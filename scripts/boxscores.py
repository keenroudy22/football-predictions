"""Append-only box-score store for every completed NFL and FBS game.

Each completed game is read once from three public ESPN endpoints:
  summary  official box score and team statistics      site.api.espn.com
  plays    play-by-play with athlete participants       sports.core.api.espn.com
  odds     provider open and close spread/total/ML      sports.core.api.espn.com
and reduced to one JSON line in data/boxscores/<league>-<season>.jsonl carrying
the event ID, source URLs and retrieval time.

Lines are never edited. A later read that finds different content (an official
stat correction, or a feed that was unavailable the first time) appends a new
revision, and the last line for an event wins. ledger.json hashes the lines each
file already holds; tests fail if any of them change.

Play-derived counts (red-zone work, college targets) come from the provider's
participant tags, never from parsing play text. Positions are the provider's
per-game tags. Snap counts are not in any of these feeds and are not recorded.

Usage:
  python scripts/boxscores.py                   completed games in site/data/slate.json
  python scripts/boxscores.py --backfill NFL 2025
Stdlib only.
"""
import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'boxscores'
EXTRACTOR = 1
SLUG = {'NFL': 'nfl', 'CFB': 'college-football'}
SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/'
CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/'
# The FBS group (80) caps historical weekly responses at 25 games; conference
# groups do not, so a backfill unions them. Same list as scripts/refresh.py.
FBS_CONFERENCES = (1, 4, 5, 8, 9, 12, 15, 17, 18, 37, 151)
# Provider position IDs, from CORE + 'nfl/positions/<id>'. Unknown IDs keep
# their raw ID with no abbreviation rather than a guessed label.
POSITIONS = {'1': 'WR', '4': 'C', '7': 'TE', '8': 'QB', '9': 'RB', '10': 'FB', '22': 'PK',
             '23': 'P', '29': 'CB', '30': 'LB', '31': 'DE', '32': 'DT', '35': 'DB', '36': 'S',
             '37': 'DL', '45': 'OL', '46': 'OT', '73': 'G', '78': 'LS'}
# DraftKings first (the book the site verifies against), then ESPN BET, which
# ESPN carried for 2024-2025 games. In-game "Live Odds" feeds are never used.
PROVIDER_PREFERENCE = ('100', '58')
RECHECK_AFTER = timedelta(days=4)  # after the NFL's weekly stat-correction window
MAX_FETCH_ATTEMPTS = 3  # then back off to one attempt a day; never give up
BACKOFF = timedelta(hours=24)

TEAM_STATS = {'firstDowns': 'firstDowns', 'totalOffensivePlays': 'plays', 'totalYards': 'yards',
              'yardsPerPlay': 'ypp', 'totalDrives': 'drives', 'netPassingYards': 'passYds',
              'yardsPerPass': 'ypa', 'rushingYards': 'rushYds', 'rushingAttempts': 'rushAtt',
              'yardsPerRushAttempt': 'ypc', 'turnovers': 'turnovers', 'fumblesLost': 'fumLost',
              'interceptions': 'intThrown', 'defensiveTouchdowns': 'defTD'}
TEAM_PAIRS = {'thirdDownEff': ('thirdConv', 'thirdAtt'), 'fourthDownEff': ('fourthConv', 'fourthAtt'),
              'completionAttempts': ('cmp', 'att'), 'sacksYardsLost': ('sacked', 'sackYds'),
              'redZoneAttempts': ('rzTD', 'rzTrips'), 'totalPenaltiesYards': ('penalties', 'penYds')}
PLAYER_STATS = {
    'passing': {'completions/passingAttempts': ('cmp', 'att'), 'passingYards': 'passYds',
                'passingTouchdowns': 'passTD', 'interceptions': 'int', 'sacks-sackYardsLost': ('sacked', 'sackYds')},
    'rushing': {'rushingAttempts': 'car', 'rushingYards': 'rushYds', 'rushingTouchdowns': 'rushTD',
                'longRushing': 'rushLong'},
    'receiving': {'receptions': 'rec', 'receivingYards': 'recYds', 'receivingTouchdowns': 'recTD',
                  'longReception': 'recLong', 'receivingTargets': 'tgt'},
    'fumbles': {'fumbles': 'fum', 'fumblesLost': 'fumLost'},
    'kicking': {'fieldGoalsMade/fieldGoalAttempts': ('fgm', 'fga'), 'longFieldGoalMade': 'fgLong',
                'extraPointsMade/extraPointAttempts': ('xpm', 'xpa'), 'totalKickingPoints': 'kPts'},
}
NOT_SCRIMMAGE = ('penalty', 'kickoff', 'punt', 'field goal', 'extra point', 'two-point', 'two point',
                 '2pt', 'conversion', 'timeout', 'end of', 'end period', 'coin toss')
NOT_COMPLETION = ('incompletion', 'incomplete', 'sack', 'interception')


def stamp(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def instant(value):
    return datetime.fromisoformat(str(value).replace('Z', '+00:00'))


def urls(league, event_id):
    slug, core = SLUG[league], f'{CORE}{SLUG[league]}/events/{event_id}/competitions/{event_id}'
    return {'summary': f'{SITE}{slug}/summary?event={event_id}',
            'plays': f'{core}/plays?limit=500',
            'odds': f'{core}/odds',
            'page': f'https://www.espn.com/{slug}/boxscore/_/gameId/{event_id}'}


def fetch_json(url, attempts=3, pause=2.0):
    """Retry throttling and transient server errors; anything else fails fast."""
    for attempt in range(attempts):
        try:
            with urlopen(url, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
        except (URLError, TimeoutError, ConnectionError):
            if attempt == attempts - 1:
                raise
        time.sleep(pause * (attempt + 1))


# ---------------------------------------------------------------- parsing

def num(value):
    """'1,234' -> 1234, '4.1' -> 4.1; blanks and dashes are missing, not zero."""
    text = str(value).replace(',', '').strip() if value is not None else ''
    if not re.fullmatch(r'[-+]?\d+(\.\d+)?', text):
        return None
    result = float(text)
    return int(result) if result.is_integer() and '.' not in text else result


def pair(value):
    """'5-16', '23/33' and '3-10' split into two numbers."""
    found = re.fullmatch(r'\s*(\d+)\s*[-/]\s*(\d+)\s*', str(value or ''))
    return (int(found.group(1)), int(found.group(2))) if found else (None, None)


def seconds(value):
    found = re.fullmatch(r'\s*(\d+):(\d{2})\s*', str(value or ''))
    return int(found.group(1)) * 60 + int(found.group(2)) if found else None


def american(value):
    """Provider values are {'american': '-110'} objects or bare strings."""
    value = value.get('american') if isinstance(value, dict) else value
    text = '' if value is None else str(value).strip().upper()
    if text in ('EVEN', 'EV'):
        return 100
    parsed = num(text)
    return int(parsed) if parsed is not None and abs(parsed) >= 100 else None


def line(value):
    """'-9.5', '+3', 'o44.5' and 'PK' as numbers."""
    value = value.get('american') if isinstance(value, dict) else value
    text = '' if value is None else str(value).strip().upper().lstrip('OU')
    if text in ('PK', 'PICK', "PICK'EM", 'EVEN'):
        return 0.0
    parsed = num(text)
    return float(parsed) if parsed is not None else None


def ref_id(ref, kind):
    found = re.search(rf'/{kind}/(\d+)', (ref or {}).get('$ref', '') if isinstance(ref, dict) else str(ref or ''))
    return found.group(1) if found else None


def team_stats(summary):
    out = {}
    for side in summary.get('boxscore', {}).get('teams', []):
        team_id = str(side.get('team', {}).get('id', ''))
        stats = {}
        for item in side.get('statistics', []):
            name, value = item.get('name'), item.get('displayValue')
            if name in TEAM_STATS and TEAM_STATS[name] not in stats:
                parsed = num(value)
                if parsed is not None:
                    stats[TEAM_STATS[name]] = parsed
            elif name in TEAM_PAIRS:
                first, second = pair(value)
                if first is not None:
                    stats.update(dict(zip(TEAM_PAIRS[name], (first, second))))
            elif name == 'possessionTime' and seconds(value) is not None:
                stats['possession'] = seconds(value)
        if team_id:
            out[team_id] = stats
    return out


def box_players(summary):
    players = {}
    for side in summary.get('boxscore', {}).get('players', []):
        team_id = str(side.get('team', {}).get('id', ''))
        for category in side.get('statistics', []):
            wanted = PLAYER_STATS.get(category.get('name'))
            if not wanted:
                continue
            keys = category.get('keys', [])
            for row in category.get('athletes', []):
                athlete = row.get('athlete', {})
                athlete_id = str(athlete.get('id', ''))
                if not re.fullmatch(r'[1-9]\d*', athlete_id) or row.get('didNotPlay'):
                    continue
                stats = {}
                for key, raw in zip(keys, row.get('stats', [])):
                    target = wanted.get(key)
                    if isinstance(target, tuple):
                        first, second = pair(raw)
                        if first is not None:
                            stats.update(dict(zip(target, (first, second))))
                    elif target and num(raw) is not None:
                        stats[target] = num(raw)
                if category.get('name') == 'fumbles' and not stats.get('fum'):
                    continue  # listed only for recovering a fumble; not a stat line
                if stats.get('fgm') == 0:
                    stats.pop('fgLong', None)  # no made field goal has no longest
                if not stats:
                    continue
                player = players.setdefault(athlete_id, {'id': athlete_id, 'team': team_id,
                                                         'name': athlete.get('displayName') or athlete.get('shortName')})
                if athlete.get('jersey'):
                    player['jersey'] = str(athlete['jersey'])
                player.update(stats)
    return players


def scrimmage(play):
    kind = str(play.get('type', {}).get('text', '')).lower()
    text = str(play.get('text', '')).lower()
    return not any(word in kind for word in NOT_SCRIMMAGE) and 'no play' not in text \
        and 'two-point' not in text and 'two point' not in text


def successful(down, distance, gained, touchdown):
    if touchdown:
        return True
    if not down or not distance or gained is None:
        return None
    need = {1: .4, 2: .6}.get(down, 1.0) * distance
    return gained >= need


def play_features(payload, team_ids):
    """Per-player and per-offense counts from the provider's participant tags.

    A receiver tagged twice on one play is one target. Plays nullified by a
    penalty, special teams and two-point tries are excluded. Intercepted passes
    carry no receiver tag, so play-derived targets can trail official targets.
    """
    players = defaultdict(Counter)
    positions = defaultdict(Counter)
    affiliation = defaultdict(Counter)
    offense = {team: Counter() for team in team_ids}
    red_zone_drives = defaultdict(set)
    touchdown_drives = defaultdict(set)
    unknown_team = 0
    for play in payload.get('items', []):
        roles = defaultdict(list)
        for person in play.get('participants', []):
            athlete = ref_id(person.get('athlete'), 'athletes')
            if athlete:
                if athlete not in roles[person.get('type')]:
                    roles[person.get('type')].append(athlete)
                position = ref_id(person.get('position'), 'positions')
                if position:
                    positions[athlete][position] += 1
        passer, rusher = (roles.get('passer') or [None])[0], (roles.get('rusher') or [None])[0]
        if not (passer or rusher) or not scrimmage(play):
            continue
        # start.team is the offense at the snap; play.team flips to the defense
        # on interceptions and fumble returns.
        team = ref_id(play.get('start', {}).get('team'), 'teams') or ref_id(play.get('team'), 'teams')
        if team not in offense:
            unknown_team += 1
            continue
        start = play.get('start', {})
        to_go = start.get('yardsToEndzone')
        to_go = to_go if isinstance(to_go, int) and 0 < to_go <= 100 else None
        kind = str(play.get('type', {}).get('text', '')).lower()
        gained = play.get('statYardage') if isinstance(play.get('statYardage'), int) else None
        # Only the offense's own scores; pick-sixes and fumble returns are not.
        touchdown = kind in ('passing touchdown', 'rushing touchdown')
        red_zone = to_go is not None and to_go <= 20
        drive = ref_id(play.get('drive'), 'drives')
        stats = offense[team]
        stats['plays'] += 1
        for athlete in [passer, rusher] + roles.get('receiver', []):
            if athlete:
                affiliation[athlete][team] += 1
        if passer:
            stats['dropbacks'] += 1
            if 'sack' not in kind:
                players[passer]['pbpAtt'] += 1
                players[passer]['rzAtt'] += red_zone
            for receiver in roles.get('receiver', []):
                players[receiver]['pbpTgt'] += 1
                players[receiver]['rzTgt'] += red_zone
                players[receiver]['i10Tgt'] += to_go is not None and to_go <= 10
                if not any(word in kind for word in NOT_COMPLETION):
                    players[receiver]['pbpRec'] += 1
        else:
            stats['rushes'] += 1
            players[rusher]['pbpCar'] += 1
            players[rusher]['rzCar'] += red_zone
            players[rusher]['i10Car'] += to_go is not None and to_go <= 10
            players[rusher]['i5Car'] += to_go is not None and to_go <= 5
            players[rusher]['scrambles'] += 'scramble' in str(play.get('text', '')).lower()
        success = successful(start.get('down'), start.get('distance'), gained, touchdown)
        if success is not None:
            split = 'db' if passer else 'rush'
            stats['successPlays'] += 1
            stats['successes'] += success
            stats[f'{split}SuccessPlays'] += 1
            stats[f'{split}Successes'] += success
        stats['explosive'] += gained is not None and gained >= 20
        if red_zone and drive:
            red_zone_drives[team].add(drive)
        if touchdown and drive:
            touchdown_drives[team].add(drive)
    for team in offense:
        offense[team]['rzDrives'] = len(red_zone_drives[team])
        offense[team]['rzDriveTDs'] = len(red_zone_drives[team] & touchdown_drives[team])
    counts = {athlete: {k: v for k, v in counter.items() if v} for athlete, counter in players.items()}
    tags = {athlete: min(counter.items(), key=lambda item: (-item[1], int(item[0])))[0]
            for athlete, counter in positions.items()}
    teams = {athlete: min(counter.items(), key=lambda item: (-item[1], item[0]))[0]
             for athlete, counter in affiliation.items()}
    return counts, tags, teams, {team: dict(stats) for team, stats in offense.items()}, unknown_team


def market(payload):
    """Open and close from one pregame provider, home line negative when favored."""
    items = [item for item in (payload or {}).get('items', [])
             if 'live' not in str(item.get('provider', {}).get('name', '')).lower()]
    if not items:
        return None

    def rank(item):
        provider = str(item.get('provider', {}).get('id'))
        preferred = PROVIDER_PREFERENCE.index(provider) if provider in PROVIDER_PREFERENCE else len(PROVIDER_PREFERENCE)
        priority = item.get('provider', {}).get('priority')
        return preferred, priority if isinstance(priority, int) else 99, provider

    item = min(items, key=rank)
    out = {'provider': item.get('provider', {}).get('name'), 'providerId': str(item.get('provider', {}).get('id'))}
    for when in ('open', 'close'):
        home = (item.get('homeTeamOdds') or {}).get(when) or {}
        away = (item.get('awayTeamOdds') or {}).get(when) or {}
        totals = item.get(when) or {}
        snapshot = {'spread': line(home.get('pointSpread')), 'spreadHomeOdds': american(home.get('spread')),
                    'spreadAwayOdds': american(away.get('spread')), 'total': line(totals.get('total')),
                    'overOdds': american(totals.get('over')), 'underOdds': american(totals.get('under')),
                    'homeML': american(home.get('moneyLine')), 'awayML': american(away.get('moneyLine'))}
        away_line = line(away.get('pointSpread'))
        if snapshot['spread'] is not None and away_line is not None and snapshot['spread'] != -away_line:
            out.setdefault('warnings', []).append(f'{when} home/away spreads disagree')
        snapshot = {k: v for k, v in snapshot.items() if v is not None}
        if snapshot:
            out[when] = snapshot
    return out if 'open' in out or 'close' in out else None


# ---------------------------------------------------------------- records

def build_record(league, event_id, summary, plays, odds, retrieved_at, failures=None):
    """One game line. Raises ValueError unless the summary is this final game."""
    header = summary.get('header', {})
    competition = next(iter(header.get('competitions', [])), {})
    if str(header.get('id')) != str(event_id):
        raise ValueError('Summary event identity mismatch')
    if not competition.get('status', {}).get('type', {}).get('completed'):
        raise ValueError('Game is not final')
    sides = {c.get('homeAway'): c for c in competition.get('competitors', [])}
    if set(sides) != {'home', 'away'}:
        raise ValueError('Expected home and away teams')
    teams = {}
    for side, item in sides.items():
        score = num(item.get('score'))
        if score is None:
            raise ValueError('Final score missing')
        teams[side] = {'id': str(item.get('team', {}).get('id')), 'score': score,
                       'abbreviation': item.get('team', {}).get('abbreviation')}
        periods = [num(period.get('displayValue')) for period in item.get('linescores') or []]
        if periods and None not in periods and sum(periods) == score:
            teams[side]['periods'] = periods
    team_ids = {teams['home']['id'], teams['away']['id']}
    players = box_players(summary)
    if not players:
        raise ValueError('Box score has no player statistics yet')
    if {p['team'] for p in players.values()} - team_ids:
        raise ValueError('Box-score team identity mismatch')
    stats = {team: {**values} for team, values in team_stats(summary).items() if team in team_ids}
    for side in ('home', 'away'):
        stats.setdefault(teams[side]['id'], {})['points'] = teams[side]['score']
    failures = dict(failures or {})
    quality = {'plays': 'ok' if plays and plays.get('items') else failures.get('plays', 'empty'),
               'odds': 'ok' if odds and odds.get('items') else failures.get('odds', 'empty')}
    if quality['plays'] == 'ok':
        counts, tags, affiliations, offense, unknown = play_features(plays, team_ids)
        if unknown:
            quality['playsWithoutTeam'] = unknown
        for team, values in offense.items():
            stats[team]['pbp'] = values
        for athlete, values in counts.items():
            # Targeted without a catch leaves no college box-score line; such a
            # player takes the offense they were tagged with on those plays.
            players.setdefault(athlete, {'id': athlete, 'team': affiliations[athlete]}).update(values)
        for athlete, player in players.items():
            if athlete in tags:
                player['posId'] = tags[athlete]
                if tags[athlete] in POSITIONS:
                    player['pos'] = POSITIONS[tags[athlete]]
        quality['check'] = {}
        for key, box, pbp in (('carries', 'car', 'pbpCar'), ('receptions', 'rec', 'pbpRec'),
                              ('targets', 'tgt', 'pbpTgt')):
            compared = [p for p in players.values() if box in p]
            if compared:
                quality['check'][key] = {
                    'box': sum(p[box] for p in compared), 'pbp': sum(p.get(pbp, 0) for p in players.values()),
                    'players': len(compared), 'exact': sum(p[box] == p.get(pbp, 0) for p in compared)}
    season = header.get('season', {})
    venue = summary.get('gameInfo', {}).get('venue') or {}
    record = {'extractor': EXTRACTOR, 'league': league, 'eventId': str(event_id),
              'season': season.get('year'), 'seasonType': season.get('type'), 'week': header.get('week'),
              'kickoff': competition.get('date'), 'neutral': bool(competition.get('neutralSite')),
              'venue': {k: v for k, v in (('id', str(venue.get('id') or '') or None), ('name', venue.get('fullName')),
                                          ('grass', venue.get('grass'))) if v is not None} or None,
              'home': teams['home'], 'away': teams['away'], 'teams': stats,
              'players': sorted(players.values(), key=lambda p: (p['team'], int(p['id']))),
              'market': market(odds), 'quality': quality,
              'sources': {k: v for k, v in urls(league, event_id).items()}, 'retrievedAt': retrieved_at}
    record['hash'] = content_hash(record)
    return record


def content_hash(record):
    body = {k: v for k, v in record.items() if k not in ('retrievedAt', 'hash', 'revision')}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()[:20]


def fetch_game(league, event_id, fetch=fetch_json, clock=None):
    """Fetch all three sources. Only the summary is required."""
    sources = urls(league, event_id)
    summary = fetch(sources['summary'])
    optional, failures = {}, {}
    for key in ('plays', 'odds'):
        try:
            optional[key] = fetch(sources[key])
        except HTTPError as error:
            # 404 means the provider has nothing for this game, not a failed read.
            optional[key], failures[key] = None, 'empty' if error.code == 404 else f'error: HTTP {error.code}'
        except (OSError, ValueError) as error:
            optional[key], failures[key] = None, f'error: {type(error).__name__}'
    plays = optional['plays']
    if plays and (plays.get('pageCount') or 1) > 1:
        for page in range(2, plays['pageCount'] + 1):
            plays['items'] += fetch(f'{sources["plays"]}&page={page}').get('items', [])
    retrieved = stamp(clock() if clock else datetime.now(timezone.utc))
    return build_record(league, event_id, summary, plays, optional['odds'], retrieved, failures)


# ---------------------------------------------------------------- the store

def store_path(league, season, root=STORE):
    return root / f'{league.lower()}-{season}.jsonl'


def read_lines(path):
    if not path.exists():
        return []
    return [line.rstrip('\r\n') for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def read_store(path):
    return [json.loads(text) for text in read_lines(path)]


def latest(records):
    """The last line for each event is the current version."""
    return {record['eventId']: record for record in records}


def append(path, records):
    if not records:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_bytes() if path.exists() else b''
    if existing and not existing.endswith(b'\n'):
        raise ValueError(f'{path.name} does not end with a complete line; refusing to append')
    with open(path, 'a', encoding='utf-8', newline='\n') as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n')


def digest(lines):
    hasher = hashlib.sha256()
    for text in lines:
        hasher.update(text.encode('utf-8') + b'\n')
    return hasher.hexdigest()


def ledger(root=STORE):
    return {path.name: {'lines': len(read_lines(path)), 'sha256': digest(read_lines(path))}
            for path in sorted(root.glob('*.jsonl'))}


def verify(root=STORE):
    """Every line a ledger entry covers must still be there, byte for byte."""
    path = root / 'ledger.json'
    if not path.exists():
        return []
    problems = []
    for name, entry in json.loads(path.read_text(encoding='utf-8')).items():
        lines = read_lines(root / name)
        if len(lines) < entry['lines']:
            problems.append(f'{name}: {entry["lines"] - len(lines)} recorded lines disappeared')
        elif digest(lines[:entry['lines']]) != entry['sha256']:
            problems.append(f'{name}: a recorded line was changed')
    return problems


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=1, sort_keys=True) + '\n', encoding='utf-8', newline='\n')
    temporary.replace(path)


# ---------------------------------------------------------------- selection

def stored(root=STORE):
    return {record['eventId']: record for path in sorted(root.glob('*.jsonl')) for record in read_store(path)}


def due(game_id, kickoff, existing, status, now):
    """New finals, one post-correction recheck, and retries of missing feeds."""
    record = existing.get(game_id)
    failure = status.get('failures', {}).get(game_id, {})
    if failure.get('attempts', 0) >= MAX_FETCH_ATTEMPTS and now < instant(failure['lastAttemptAt']) + BACKOFF:
        return None
    if record is None:
        return 'new'
    if any(str(v).startswith('error') for v in (record['quality'].get('plays'), record['quality'].get('odds'))) \
            and status.get('retries', {}).get(game_id, 0) < MAX_FETCH_ATTEMPTS:
        return 'retry'
    if game_id not in status.get('rechecked', {}) and now >= instant(kickoff) + RECHECK_AFTER \
            and instant(record['retrievedAt']) < instant(kickoff) + RECHECK_AFTER:
        return 'recheck'
    return None


def slate_games(slate):
    for game in slate.get('games', []):
        if game.get('league') in SLUG and game.get('completed') and game.get('state') == 'post':
            yield game['league'], game['id'].split('-', 1)[1], game['kickoff'], game['season']


def season_games(league, season, fetch=fetch_json):
    """Every completed regular and postseason game in a past season."""
    base = f'{SITE}{SLUG[league]}/scoreboard?dates={season}&limit=1000'
    pages = [f'{base}&seasontype=2&week={w}' for w in range(1, 19)] + \
            [f'{base}&seasontype=3&week={w}' for w in range(1, 6)]
    if league == 'CFB':
        pages = [f'{page}&groups={group}' for page in pages for group in FBS_CONFERENCES]
    events = {}
    for url in pages:
        for event in fetch(url).get('events', []):
            competition = event.get('competitions', [{}])[0]
            names = {c.get('team', {}).get('abbreviation') for c in competition.get('competitors', [])}
            if names & {'AFC', 'NFC'} or not competition.get('status', {}).get('type', {}).get('completed'):
                continue  # all-star games are not team results
            events[str(event['id'])] = (league, str(event['id']), event['date'], event['season']['year'])
    return sorted(events.values(), key=lambda row: (row[2], row[1]))


def run(games, status, now, fetch=fetch_json, workers=4, limit=None, log=print, root=STORE, clock=None):
    """Read what is due and append changed games. Returns ({file: lines}, games read)."""
    existing = stored(root)
    work = [(league, eid, kickoff, season, reason) for league, eid, kickoff, season in games
            for reason in [due(eid, kickoff, existing, status, now)] if reason]
    if limit:
        work = work[:limit]
    for key in ('failures', 'rechecked', 'retries'):
        status.setdefault(key, {})
    appended = defaultdict(list)

    def task(item):
        league, eid, _, season, reason = item
        try:
            return item, fetch_game(league, eid, fetch, clock), None
        except (OSError, ValueError, KeyError, TypeError) as error:
            return item, None, f'{type(error).__name__}: {error}'[:160]

    written = Counter()

    def flush():
        for path, records in sorted(appended.items()):
            records.sort(key=lambda r: (r['kickoff'], int(r['eventId'])))
            append(path, records)
            written[path.name] += len(records)
        appended.clear()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for done, ((league, eid, _, season, reason), record, error) in enumerate(pool.map(task, work), 1):
            if done % 100 == 0:
                flush()  # a long backfill keeps its progress if interrupted
                log(f'  {done}/{len(work)} games read')
            if error:
                failure = status['failures'].setdefault(eid, {'attempts': 0})
                failure.update(attempts=failure['attempts'] + 1, lastError=error, lastAttemptAt=stamp(now))
                continue
            status['failures'].pop(eid, None)
            if reason == 'recheck':
                status['rechecked'][eid] = record['retrievedAt']
            if reason == 'retry':
                status['retries'][eid] = status['retries'].get(eid, 0) + 1
            previous = existing.get(eid)
            if previous and previous['hash'] == record['hash']:
                continue
            if previous:
                record['revision'] = previous.get('revision', 1) + 1
            appended[store_path(league, record['season'] or season, root)].append(record)
    flush()
    return dict(written), len(work)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--backfill', nargs=2, metavar=('LEAGUE', 'SEASON'))
    parser.add_argument('--limit', type=int, help='read at most this many games')
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    status_path = STORE / 'status.json'
    status = json.loads(status_path.read_text(encoding='utf-8')) if status_path.exists() else {}
    before = json.dumps(status, sort_keys=True)
    problems = verify()
    if problems:
        sys.exit('Refusing to append to a store whose recorded lines changed:\n  ' + '\n  '.join(problems))
    if args.backfill:
        league, season = args.backfill[0].upper(), int(args.backfill[1])
        games = season_games(league, season)
        print(f'{league} {season}: {len(games)} completed games listed')
    else:
        slate = json.loads((ROOT / 'site' / 'data' / 'slate.json').read_text(encoding='utf-8'))
        games = list(slate_games(slate))
    added, attempted = run(games, status, now, limit=args.limit)
    STORE.mkdir(parents=True, exist_ok=True)
    write_json(STORE / 'ledger.json', ledger())
    if added or json.dumps(status, sort_keys=True) != before:
        if added:
            status['lastAppendAt'] = stamp(now)
        write_json(status_path, status)
    failed = sum(1 for f in status.get('failures', {}).values() if f.get('lastAttemptAt') == stamp(now))
    print(f'Read {attempted} games; appended {sum(added.values())} lines {added or ""}; {failed} failed this run.')


if __name__ == '__main__':
    main()
