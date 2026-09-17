"""Build a read-only catalog from recorded quotes and sourced public references.

No sportsbook scraping or remote calls. Regeneration never refreshes an observed
quote's timestamp and never changes the recommendation/settlement ledger.
"""
import copy
import hashlib
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
OUTPUT = DATA / 'market-lines.json'
MARKETS = {'passing yards', 'passing attempts', 'completions', 'passing touchdowns',
           'rushing yards', 'rushing attempts', 'receiving yards', 'receptions', 'targets',
           'longest reception', 'longest rush', 'longest pass', 'anytime touchdown', 'first touchdown'}
ALIASES = {'carries': 'rushing attempts', 'pass attempts': 'passing attempts',
           'pass completions': 'completions', 'td passes': 'passing touchdowns',
           'anytime td scorer': 'anytime touchdown', 'anytime td': 'anytime touchdown',
           'first td scorer': 'first touchdown', 'first td': 'first touchdown'}
DIRECT_HOSTS = {'DraftKings': {'sportsbook.draftkings.com'},
                'FanDuel': {'sportsbook.fanduel.com'},
                'BetMGM': {'sports.betmgm.com'}, 'bet365': {'www.bet365.com', 'bet365.com'}}
BOOKS = {'draftkings': 'DraftKings', 'draft kings': 'DraftKings', 'fanduel': 'FanDuel',
         'betmgm': 'BetMGM', 'bet365': 'bet365'}


def instant(value):
    if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}T', value):
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except ValueError:
        return None


def iso(value):
    return value.isoformat(timespec='seconds').replace('+00:00', 'Z')


def numeric(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def price(value):
    result = numeric(value)
    return int(result) if result is not None and result.is_integer() and abs(result) >= 100 else None


def safe_source(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        return value if parsed.scheme == 'https' and parsed.hostname and not parsed.username else None
    except ValueError:
        return None


def parse_title(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'(.+?)\s+(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s+(.+)', value, re.I)
    if match:
        player, direction, line, market = match.groups()
        market = ALIASES.get(market.casefold(), market.casefold())
        return {'player': player, 'direction': direction.upper(), 'line': float(line), 'market': market} if market in MARKETS else None
    match = re.fullmatch(r'(.+?)\s+(anytime touchdown|first touchdown|anytime TD scorer|first TD scorer)', value, re.I)
    if match:
        return {'player': match[1], 'direction': 'YES', 'line': None,
                'market': ALIASES.get(match[2].casefold(), match[2].casefold())}
    return None


def exact_identity(item, history):
    athlete_id = item.get('athleteId') or history.get('athleteId')
    if athlete_id and re.fullmatch(r'[1-9][0-9]*', str(athlete_id)):
        return str(athlete_id)
    ids = set()
    for source in item.get('sources', []):
        match = re.fullmatch(r'https://www\.espn\.com/(?:nfl|college-football)/player/(?:gamelog/)?_/id/([1-9][0-9]*)(?:/[^?]*)?', source)
        if match:
            ids.add(match[1])
    return next(iter(ids)) if len(ids) == 1 else None


def normalize(raw, now, games):
    row = copy.deepcopy(raw)
    row['market'] = ALIASES.get(str(row.get('market', '')).casefold(), str(row.get('market', '')).casefold())
    if row['market'] not in MARKETS or not isinstance(row.get('player'), str) or not row['player'].strip():
        return None
    if row.get('league') not in ('NFL', 'CFB') or not row.get('gameId'):
        return None
    row['direction'] = str(row.get('direction', '')).upper()
    row['line'] = numeric(row.get('line'))
    td = row['market'] in ('anytime touchdown', 'first touchdown')
    if (not td and (row['line'] is None or row['direction'] not in ('OVER', 'UNDER'))) or (td and row['direction'] != 'YES'):
        return None
    row['book'] = BOOKS.get(str(row.get('book', '')).casefold(), row.get('book')) or 'Book unavailable'
    row['odds'] = price(row.get('odds'))
    row['source'] = safe_source(row.get('source'))
    row['marketWindow'] = row.get('marketWindow') or row.get('window') or 'Full game'
    row['athleteId'] = str(row['athleteId']) if re.fullmatch(r'[1-9][0-9]*', str(row.get('athleteId', ''))) else None
    row['identityVerified'] = bool(row.get('identityVerified') and row['athleteId'])
    if not row['identityVerified']:
        row['athleteId'] = None
    row['position'] = row.get('position') if row.get('position') in ('QB', 'RB', 'WR', 'TE', 'K') else None
    row['quoteType'] = row.get('quoteType') or 'source reference'
    observed = instant(row.get('observedAt'))
    row['observedAt'] = iso(observed) if observed else None
    row['checkedAt'] = row['observedAt']
    game = games.get(row['gameId'], {})
    kickoff = instant(game.get('kickoff'))
    row['kickoff'] = game.get('kickoff')
    expiry = instant(row.get('expiresAt'))
    if row['quoteType'] == 'sportsbook' and observed:
        expiry = min(expiry, observed + timedelta(hours=1)) if expiry else observed + timedelta(hours=1)
    row['expiresAt'] = iso(expiry) if expiry else None
    direct = (row['quoteType'] == 'sportsbook' and row['source']
              and urlsplit(row['source']).hostname in DIRECT_HOSTS.get(row['book'], set())
              and '/blog/' not in row['source'] and '/research/' not in row['source'])
    if game.get('completed') or game.get('state') in ('in', 'post') or (kickoff and kickoff <= now):
        status, reason = 'closed', 'Game has started or finished; retained for research history only.'
    elif not kickoff:
        status, reason = 'reference', 'Kickoff has not been verified; no current-entry claim.'
    elif observed and observed >= kickoff:
        status, reason = 'closed', 'This observation was taken after the scheduled start.'
    elif row['odds'] is None:
        status, reason = 'missing-price', 'Exact price unavailable; line reference only.'
    elif not row['source'] or observed is None or observed > now:
        status, reason = 'reference', 'Source or observation time is incomplete; recheck independently.'
    elif not direct:
        status, reason = 'reference', 'Public article or comparison quote; verify the exact market in your sportsbook.'
    elif expiry is None or expiry <= now:
        status, reason = 'stale', 'Previously observed sportsbook quote has expired; recheck the line and price.'
    else:
        status, reason = 'current', 'Direct sportsbook observation within its freshness window; this catalog is not an endorsement.'
    row['status'] = row['quoteStatus'] = status
    row['reason'] = reason
    row['builderEligible'] = status == 'current'
    row['title'] = (f"{row['player']} {row['market']}" if td else
                    f"{row['player']} {row['direction']} {row['line']:g} {row['market']}")
    key = '|'.join(str(row.get(field) or '').casefold() for field in
                   ('league', 'gameId', 'player', 'book', 'market', 'direction', 'marketWindow', 'variant'))
    row['id'] = 'line-' + hashlib.sha256(key.encode('utf-8')).hexdigest()[:20]
    return row


def report_observations(reports, history, identities=None):
    observations = []
    originals = {}
    for report in sorted(reports, key=lambda row: row.get('publishedAt', '')):
        for category in ('props', 'riskyProps', 'gameWatch'):
            for item in report.get(category, []):
                parsed = parse_title(item.get('marketTitle') or item.get('title')) or {}
                old = history.get('watches' if category == 'gameWatch' else 'picks', {}).get(item.get('id'), {})
                game_id = item.get('gameId') or next(iter(item.get('gameIds', [])), None) or old.get('gameId')
                context = {'league': report.get('league'), 'gameId': game_id,
                           'player': item.get('player') or parsed.get('player'),
                           'athleteId': exact_identity(item, old), 'position': item.get('position') or old.get('position'),
                           'reportId': item.get('id')}
                known = (identities or {}).get(f"{context['league']}/{context['athleteId']}", {})
                verified = bool(context['athleteId'] and (
                    str(old.get('athleteId', '')) == context['athleteId'] or
                    (known.get('status') == 'ok' and str(known.get('name', '')).casefold() == str(context['player']).casefold())))
                context['identityVerified'] = verified
                if not verified:
                    context['athleteId'] = None
                snapshots = item.get('marketSnapshots', [])
                for snapshot in snapshots:
                    observations.append({**context, **copy.deepcopy(snapshot),
                                         'marketWindow': snapshot.get('window') or 'Full game'})
                if parsed:
                    original = {**context, **parsed, 'book': item.get('book'), 'odds': item.get('odds'),
                                'observedAt': item.get('quotedAt'), 'expiresAt': item.get('expiresAt'),
                                'source': next(iter(item.get('sources', [])), None), 'marketWindow': item.get('marketWindow') or 'Full game',
                                'cutoff': item.get('cutoff'),
                                'quoteType': 'historical import' if report.get('historicalImport') else 'source reference'}
                    if category != 'gameWatch':
                        originals.setdefault(item.get('id'), copy.deepcopy(original))
                    if not snapshots:
                        observations.append(original)
                # These lineLabel fields are structured two-way quote rows, not
                # prose. Only extract the other side when the exact displayed
                # line, over price, and market agree with the direct snapshot.
                pair = re.fullmatch(r'(?:(?:DraftKings|FanDuel|BetMGM): )?(\d+(?:\.\d+)?) ([a-z ]+) · OVER ([+-]\d+) / UNDER ([+-]\d+)', item.get('lineLabel', ''), re.I)
                if pair:
                    threshold, market, over, under = pair.groups()
                    for snapshot in snapshots:
                        if (snapshot.get('quoteType') == 'sportsbook' and str(snapshot.get('direction')).upper() == 'OVER'
                                and numeric(snapshot.get('line')) == float(threshold)
                                and price(snapshot.get('odds')) == int(over)
                                and snapshot.get('market', '').casefold() == market.casefold()):
                            observations.append({**context, **copy.deepcopy(snapshot), 'direction': 'UNDER',
                                                 'odds': int(under), 'marketWindow': snapshot.get('window') or 'Full game',
                                                 'sourceTimeNote': 'Opposite side explicitly recorded in the same structured two-way quote row.'})
    return observations, list(originals.values())


def build(reports, history, slate, source_packets, now, identities=None):
    current = instant(now)
    if current is None:
        raise ValueError('A UTC build timestamp is required')
    games = {game['id']: game for game in slate.get('games', [])}
    verified_identities = copy.deepcopy(identities or {})
    for packet in source_packets:
        for observation in packet.get('observations', []):
            identity_source = safe_source(observation.get('identitySource'))
            if observation.get('identityVerified') and observation.get('athleteId') and identity_source and urlsplit(identity_source).hostname == 'site.web.api.espn.com':
                league = observation.get('league', packet.get('league'))
                verified_identities[f"{league}/{observation['athleteId']}"] = {
                    'status': 'ok', 'name': observation.get('player')}
    raw, originals = report_observations(reports, history, verified_identities)
    for packet in source_packets:
        for observation in packet.get('observations', []):
            raw.append({**{key: packet[key] for key in ('league', 'gameId', 'source', 'sourceDate', 'quoteType', 'book') if key in packet},
                        'observedAt': packet.get('retrievedAt'), **copy.deepcopy(observation)})
    grouped = defaultdict(list)
    for observation in raw:
        row = normalize(observation, current, games)
        if row:
            grouped[row['id']].append(row)
    result = []
    rank = {'sportsbook': 4, 'comparison feed': 3, 'article reference': 2, 'source reference': 1, 'historical import': 0}
    for key, values in grouped.items():
        unique = {}
        for row in values:
            fingerprint = json.dumps({k: row.get(k) for k in ('line', 'odds', 'observedAt', 'source', 'quoteType', 'sourcePart')}, sort_keys=True)
            unique[fingerprint] = row
        ordered = sorted(unique.values(), key=lambda row: (row.get('observedAt') or '', rank.get(row['quoteType'], 0)))
        latest = copy.deepcopy(ordered[-1])
        latest['observations'] = [{k: row.get(k) for k in ('line', 'odds', 'observedAt', 'source', 'quoteType', 'sourceDate', 'sourcePart', 'sourceTimeNote')} for row in ordered]
        latest['observationCount'] = len(ordered)
        latest['originalRecommendations'] = [copy.deepcopy(original) for original in originals
                                            if (matched := normalize(original, current, games)) and matched['id'] == key]
        result.append(latest)
    preferred = {'FanDuel': 0, 'DraftKings': 1, 'BetMGM': 2}
    result.sort(key=lambda row: (row.get('kickoff') or '9999', preferred.get(row['book'], 9), row['player'], row['market'], row['direction']))
    return {'updatedAt': now, 'status': 'ok',
            'coverage': 'Observed NFL/CFB player markets from saved research and dated public references. Not an exhaustive sportsbook menu. Rebuilding does not refresh quote times or create recommendations.',
            'freshnessPolicy': 'Direct observed prices expire after at most 60 minutes or a sooner supplied expiry; all article/comparison prices require independent sportsbook recheck.',
            'counts': {'lines': len(result), 'current': sum(row['status'] == 'current' for row in result),
                       'references': sum(row['status'] in ('reference', 'missing-price') for row in result)},
            'lines': result}


def main():
    reports = json.loads((DATA / 'research.json').read_text(encoding='utf-8'))
    history = json.loads((DATA / 'player-history.json').read_text(encoding='utf-8'))
    slate = json.loads((DATA / 'slate.json').read_text(encoding='utf-8'))
    identity_path = DATA / 'player-identity.json'
    identities = json.loads(identity_path.read_text(encoding='utf-8')).get('players', {}) if identity_path.exists() else {}
    packets = []
    for path in sorted((ROOT / 'market-observations').glob('*.json')):
        data = json.loads(path.read_text(encoding='utf-8'))
        packets.extend(data if isinstance(data, list) else [data])
    now = iso(datetime.now(timezone.utc))
    output = build(reports, history, slate, packets, now, identities)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    print(json.dumps(output['counts']))


if __name__ == '__main__':
    main()
