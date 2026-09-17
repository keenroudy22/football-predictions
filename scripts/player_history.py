"""Sourced NFL exact-market logs and last-game positional defense context.

This enrichment is separate from immutable original recommendations. Stdlib only.
"""
import json
import copy
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl'
MARKETS = {
    'receiving yards': 'receivingYards', 'receptions': 'receptions',
    'passing yards': 'passingYards', 'completions': 'completions',
    'rushing yards': 'rushingYards', 'carries': 'rushingAttempts',
}
USAGE = {
    'receiving yards': (('receivingTargets', 'Targets'), ('receptions', 'Receptions')),
    'receptions': (('receivingTargets', 'Targets'),),
    'passing yards': (('passingAttempts', 'Pass attempts'), ('completions', 'Completions')),
    'completions': (('passingAttempts', 'Pass attempts'),),
    'rushing yards': (('rushingAttempts', 'Carries'),),
}


@lru_cache(maxsize=256)
def fetch(url):
    """Reuse successful athlete/season and box-score reads within this run."""
    with urlopen(url, timeout=12) as response:
        return json.load(response)


def number(value):
    try:
        result = float(str(value).replace(',', ''))
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def identity(summary, name):
    matches = []
    for side in summary.get('boxscore', {}).get('players', []):
        for category in side.get('statistics', []):
            for row in category.get('athletes', []):
                athlete = row['athlete']
                display = athlete.get('displayName', '').casefold()
                if display == name.casefold() or display == (name + ' Jr.').casefold():
                    matches.append((athlete['id'], side['team']['id']))
    return next(iter(set(matches)), None)


def event_id(url):
    found = re.search(r'gameId/(\d+)', url or '')
    return found.group(1) if found else None


def instant(value):
    """Parse provider ISO dates; reject invalid dates instead of sorting text."""
    if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}(?:T|$)', value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def iso(value):
    return value.isoformat(timespec='seconds').replace('+00:00', 'Z')


def utc_now():
    return iso(datetime.now(timezone.utc))


def team_fields(team):
    if not isinstance(team, dict) or not re.fullmatch(r'[1-9][0-9]*', str(team.get('id', ''))):
        return None
    return {'id': str(team['id']), 'name': team.get('displayName') or team.get('name'),
            'abbreviation': team.get('abbreviation')}


def game_rows(log, stat, cutoff, season_year=None):
    boundary = instant(cutoff)
    if boundary is None:
        return []
    if stat not in log.get('names', []):
        return []
    index = log['names'].index(stat)
    rows = []
    for season in log.get('seasonTypes', []):
        for category in season.get('categories', []):
            if category.get('type') != 'event':
                continue
            # The gamelog endpoint also exposes pre/postseason categories.
            # Missing classification is not evidence of a regular-season game.
            split = category.get('splitType')
            label = f"{season.get('displayName', '')} {category.get('displayName', '')}".casefold()
            if str(split) != '2' and not (split is None and 'regular season' in label):
                continue
            year_match = re.search(r'\b(20\d{2})\b', season.get('displayName', ''))
            year = int(year_match.group(1)) if year_match else season_year
            for row in category.get('events', []):
                row_id = str(row.get('eventId', ''))
                event = log.get('events', {}).get(row_id)
                if not re.fullmatch(r'[1-9][0-9]*', row_id) or not isinstance(event, dict) or str(event.get('id')) != row_id:
                    continue
                played_at = instant(event.get('gameDate'))
                if played_at is None or played_at >= boundary or row.get('didNotPlay') or row.get('didNotDress'):
                    continue
                stats = row.get('stats', [])
                value = number(stats[index]) if index < len(stats) else None
                if value is not None:
                    event = {**event, 'gameDate': iso(played_at), '_season': year, '_seasonType': 'regular'}
                    rows.append((event['gameDate'], row_id, event, value))
    return rows


def stale_form(previous, attempted_at, failures):
    if not previous:
        return None
    return {**copy.deepcopy(previous), 'status': 'stale', 'lastAttemptAt': attempted_at,
            'sourceFailures': failures}


def unlisted_season(log, season):
    """ESPN may identify a request but explicitly list no NFL log for that year."""
    filters = log.get('filters', [])
    if not isinstance(filters, list):
        return False
    league = next((row for row in filters if row.get('name') == 'league'), {})
    years = next((row for row in filters if row.get('name') == 'season'), {})
    options = years.get('options')
    return (league.get('value') == 'nfl' and str(years.get('value')) == str(season)
            and isinstance(options, list) and bool(options)
            and str(season) not in {str(row.get('value')) for row in options})


def prop_history(pick, game, athlete_id, opponent_id, previous=None, checked_at=None, team_id=None):
    checked_at = checked_at or utc_now()
    match = re.match(r'^(.+?) (OVER|UNDER) (\d+(?:\.\d+)?) (.+)$', pick['title'])
    if not match or match.group(4) not in MARKETS:
        return None
    _, direction, threshold, market = match.groups()
    threshold = float(threshold)
    stat = MARKETS[market]
    boundaries = [instant(game.get('kickoff')), instant(checked_at)]
    if not all(boundaries):
        return stale_form(previous, checked_at, [{'error': 'Invalid cutoff date'}])
    cutoff = iso(min(boundaries))
    rows = []
    usage_rows = defaultdict(dict)
    workload = defaultdict(dict)
    failures = []
    unavailable_seasons = []
    seasons = [game['season'] - 2, game['season'] - 1, game['season']]
    for season in seasons:
        url = f'{WEB}/athletes/{athlete_id}/gamelog?season={season}'
        try:
            log = fetch(url)
            if not isinstance(log.get('names'), list) or not isinstance(log.get('seasonTypes'), list) or not isinstance(log.get('events'), dict):
                if unlisted_season(log, season):
                    unavailable_seasons.append({'season': season, 'source': url,
                                                'reason': 'Requested NFL season is not listed by the provider.'})
                    continue
                raise ValueError('Malformed player game log')
            rows += game_rows(log, stat, cutoff, season)
            for key in ('rushingAttempts','rushingYards','receptions','receivingTargets','receivingYards','passingAttempts','completions','passingYards'):
                for r in game_rows(log, key, cutoff, season):
                    workload[r[1]][key] = r[3]
            for values in workload.values():
                if 'rushingAttempts' in values and 'receptions' in values:
                    values['touches'] = values['rushingAttempts'] + values['receptions']
            for usage_stat, label in USAGE.get(market, ()):
                usage_rows[label].update({r[1]: r[3] for r in game_rows(log, usage_stat, cutoff, season)})
        except (OSError, ValueError, KeyError, TypeError) as error:
            failures.append({'source': url, 'error': type(error).__name__})
    if failures:
        return stale_form(previous, checked_at, failures)
    # ESPN gameDate is a local calendar date, which can precede a UTC kickoff.
    # The event ID is the reliable boundary for excluding the pick's own game.
    rows = sorted((r for r in {r[1]: r for r in rows}.values()
                   if r[1] != game['id'].split('-')[-1]), key=lambda row: (row[0], int(row[1])), reverse=True)
    if not rows:
        return stale_form(previous, checked_at, [{'error': 'No verified regular-season stat rows before cutoff'}])
    latest = rows[:10]
    def hit(value):
        return value > threshold if direction == 'OVER' else value < threshold
    def record(r):
        event = r[2]
        team = team_fields(event.get('team'))
        opponent = team_fields(event.get('opponent'))
        home, away = str(event.get('homeTeamId', '')), str(event.get('awayTeamId', ''))
        is_home = team['id'] == home if team and team['id'] in (home, away) else None
        return {'label': f"{r[0][:10]} · {(opponent or {}).get('abbreviation') or 'Opponent unavailable'}",
                'eventId': r[1], 'date': r[0], 'season': event.get('_season'),
                'seasonType': 'regular', 'isHome': is_home, 'opponent': opponent, 'team': team,
                'value': r[3], 'hit': hit(r[3]), 'push': r[3] == threshold,
                'workload': workload.get(r[1], {}),
                'source': f'https://www.espn.com/nfl/boxscore/_/gameId/{r[1]}'}
    history_games = [record(r) for r in reversed(rows)]
    games = history_games[-10:]
    opponent_games = [row for row in history_games if (row['opponent'] or {}).get('id') == str(opponent_id)]
    form = {'stat': market, 'statKey': stat, 'line': threshold, 'direction': direction,
            'opponentId': str(opponent_id), 'teamId': str(team_id) if team_id is not None else None,
            'cutoffAt': cutoff, 'checkedAt': checked_at, 'lastAttemptAt': checked_at, 'status': 'ok',
            'source': f'https://www.espn.com/nfl/player/gamelog/_/id/{athlete_id}',
            'games': games, 'historyGames': history_games, 'sample': len(latest),
            'vsOpponent': {'opponentId': str(opponent_id), 'games': opponent_games, 'sample': len(opponent_games)},
            'coverage': {'seasons': seasons, 'seasonType': 'regular',
                         'unavailableSeasons': unavailable_seasons,
                         'availableGames': len(history_games), 'missingStatsExcluded': True,
                         'note': 'Verified games played before cutoff; no preseason, postseason, DNP or inferred zero. Opponent meetings cover the current and two previous seasons only.'},
            'method': 'Regular-season games played before this recommendation game and check time; exact published threshold and direction.'}
    for window in (5, 10):
        if len(rows) >= window:
            pushes = sum(r[3] == threshold for r in rows[:window])
            hits = sum(hit(r[3]) for r in rows[:window])
            form[f'last{window}'] = {'hits': hits, 'pushes': pushes, 'misses': window - hits - pushes,
                                   'sample': window, 'decisions': window - pushes}
    usage = []
    for label, values in usage_rows.items():
        item = {'stat': label}
        for window in (5, 10):
            segment = [values.get(r[1]) for r in rows[:window]]
            if len(segment) == window and all(x is not None for x in segment):
                item[f'last{window}'] = {'average': round(sum(segment) / window, 1),
                                          'low': min(segment), 'high': max(segment)}
        if len(item) > 1:
            usage.append(item)
    if usage:
        form['usage'] = usage
    if opponent_games:
        prior = opponent_games[-1]
        form['lastVsOpponent'] = {'value': prior['value'], 'date': prior['date'][:10],
                                  'source': prior['source'], 'eventId': prior['eventId'],
                                  'opponentId': str(opponent_id)}
    return form


def position(athlete_id, cache):
    if athlete_id not in cache:
        try:
            athlete = fetch(f'{WEB}/athletes/{athlete_id}')['athlete']
            cache[athlete_id] = athlete.get('position', {}).get('abbreviation', 'Other')
        except (OSError, ValueError, KeyError):
            cache[athlete_id] = 'Other'
    return cache[athlete_id]


def defense_context(game, previous, summary, positions):
    sides = summary.get('boxscore', {}).get('players', [])
    defense_id = str(previous['defenseId'])
    before, target = instant(previous.get('kickoff')), instant(game.get('kickoff'))
    if before is None or target is None or before >= target:
        return None
    if not any(str(side.get('team', {}).get('id')) == defense_id for side in sides):
        return None
    offense = next((side for side in sides if str(side.get('team', {}).get('id')) != defense_id), None)
    if not offense:
        return None
    by_category = defaultdict(dict)
    players = {}
    offensive_stats = {'passingYards', 'completions/passingAttempts', 'rushingAttempts',
                       'rushingYards', 'receptions', 'receivingYards', 'receivingTargets'}
    for category in offense.get('statistics', []):
        # Player box scores also contain defense, returns, kicking, and punting.
        # They cannot contribute to these offensive position comparisons.
        if not offensive_stats.intersection(category.get('keys', [])):
            continue
        for row in category.get('athletes', []):
            if row.get('didNotPlay') or row.get('didNotDress'):
                continue
            athlete = row.get('athlete', {})
            athlete_id = str(athlete.get('id', ''))
            if not re.fullmatch(r'[1-9][0-9]*', athlete_id):
                continue
            pos = athlete.get('position', {}).get('abbreviation') or position(athlete_id, positions)
            if pos not in ('QB', 'RB', 'WR', 'TE'):
                continue
            player = players.setdefault(athlete_id, {'athleteId': athlete_id,
                                       'name': athlete.get('displayName') or athlete.get('shortName'),
                                       'position': pos, 'stats': {}})
            for key, raw in zip(category.get('keys', []), row.get('stats', [])):
                if key == 'completions/passingAttempts' and re.fullmatch(r'\d+/\d+', str(raw)):
                    completed, attempted = (int(x) for x in str(raw).split('/'))
                    for stat, value in [('completions', completed), ('passingAttempts', attempted)]:
                        by_category[pos][(athlete_id, stat)] = value
                        player['stats'][stat] = value
                    continue
                value = number(raw)
                if value is not None:
                    by_category[pos][(athlete_id, key)] = value
                    player['stats'][key] = value
    desired = {'QB': ('passingYards', 'completions', 'passingAttempts'),
               'RB': ('rushingAttempts', 'rushingYards', 'receptions', 'receivingYards'),
               'WR': ('receptions', 'receivingYards'), 'TE': ('receptions', 'receivingYards')}
    aggregate = {}
    for pos, keys in desired.items():
        values = {}
        for key in keys:
            items = [v for (athlete, name), v in by_category[pos].items() if name == key]
            if items:
                values[key] = sum(items)
        if values:
            aggregate[pos] = values
    return {'date': previous['kickoff'][:10], 'opponent': offense['team']['displayName'],
            'defenseId': defense_id, 'eventId': previous['id'].split('-')[-1],
            'kickoff': iso(before), 'sample': 1, 'opponentTeam': team_fields(offense['team']),
            'players': sorted((p for p in players.values() if p['stats']), key=lambda p: (p['position'], p['name'] or '')),
            'checkedAt': utc_now(), 'status': 'ok',
            'source': f'https://www.espn.com/nfl/boxscore/_/gameId/{previous["id"].split("-")[1]}',
            'positions': aggregate, 'note': 'One prior game against this defense; opponent personnel and game script differ.'}


def main():
    fetch.cache_clear()
    attempted_at = utc_now()
    slate = json.loads((DATA / 'slate.json').read_text(encoding='utf-8'))
    reports = json.loads((DATA / 'research.json').read_text(encoding='utf-8'))
    reports.sort(key=lambda report: datetime.fromisoformat(report['publishedAt'].replace('Z', '+00:00')))
    games = {g['id']: g for g in slate['games']}
    summaries = {}
    output_path = DATA / 'player-history.json'
    previous = json.loads(output_path.read_text(encoding='utf-8')) if output_path.exists() else {}
    histories = copy.deepcopy(previous.get('picks', {}))
    watches = copy.deepcopy(previous.get('watches', {}))
    contexts = copy.deepcopy(previous.get('defenses', {}))
    failures = []
    positions = {}
    identity_path = DATA / 'player-identity.json'
    if identity_path.exists():
        identities = json.loads(identity_path.read_text(encoding='utf-8')).get('players', {})
        positions.update({str(row['athleteId']): row['position'] for row in identities.values()
                          if row.get('league') == 'NFL' and row.get('status') == 'ok'
                          and row.get('athleteId') and row.get('position') in ('QB', 'RB', 'WR', 'TE')})

    def mark_failure(bucket, key, error, source=None):
        failure = {'id': key, 'error': str(error), 'attemptedAt': attempted_at}
        if source:
            failure['source'] = source
        failures.append(failure)
        if key in bucket:
            bucket[key]['recentForm'] = stale_form(bucket[key].get('recentForm'), attempted_at, [failure])

    for report in reports:
        if report['league'] != 'NFL':
            continue
        for pick in report.get('props', []) + report.get('riskyProps', []):
            id_ = event_id(pick.get('resultSource'))
            if not id_ and pick['title'].startswith('Chris Godwin'):
                id_ = '401872925'  # Same verified Buccaneers game as Baker/Cade.
            if not id_ and pick['title'].startswith('Tyler Shough'):
                id_ = '401872923'  # Lions-Saints source identifies this Week 1 game.
            if not id_ and pick['title'].startswith('Patrick Mahomes'):
                id_ = '401872931'  # The Chiefs' sole completed Week 1 game in the feed.
            if not id_ and pick.get('gameIds'):
                id_ = pick['gameIds'][0].split('-')[-1]
            game = games.get(f'NFL-{id_}') if id_ else None
            if not game:
                continue
            name = re.split(r' (?:OVER|UNDER|anytime)', pick['title'], maxsplit=1)[0]
            try:
                if pick.get('athleteId') and not game['completed']:
                    athlete = fetch(f'{WEB}/athletes/{pick["athleteId"]}')['athlete']
                    who = (str(pick['athleteId']), athlete.get('team', {}).get('id')) if athlete.get('displayName', '').casefold() == name.casefold() else None
                else:
                    if id_ not in summaries:
                        summaries[id_] = fetch(f'{API}/summary?event={id_}')
                    who = identity(summaries[id_], name)
                    if not who and pick['title'].startswith('Brock Bowers'):
                        # A scratch is absent from the box score; verify the
                        # player identity without inventing a zero-value game.
                        athlete = fetch(f'{WEB}/athletes/4432665')['athlete']
                        if athlete.get('displayName', '').casefold() == name.casefold():
                            who = ('4432665', athlete.get('team', {}).get('id'))
            except (OSError, ValueError, KeyError, TypeError) as error:
                mark_failure(histories, pick['id'], type(error).__name__)
                continue
            if not who:
                if pick['id'] in histories:
                    mark_failure(histories, pick['id'], 'Player identity unavailable')
                continue  # Unverified identity: never infer a zero-game log.
            athlete_id, team_id = who
            if team_id not in (game['away']['id'], game['home']['id']):
                mark_failure(histories, pick['id'], 'Player affiliation could not be verified for target game')
                continue  # Reject stale roster/team identity.
            opponent_id = game['away']['id'] if team_id == game['home']['id'] else game['home']['id']
            old_form = histories.get(pick['id'], {}).get('recentForm')
            form = prop_history(pick, game, athlete_id, opponent_id, old_form, attempted_at, team_id)
            if form:
                histories[pick['id']] = {'gameId': game['id'], 'position': position(athlete_id, positions),
                                         'recentForm': form, 'athleteId': athlete_id}
                if form.get('status') == 'stale':
                    failures.append({'id': pick['id'], 'attemptedAt': attempted_at,
                                     'error': 'History refresh incomplete', 'sources': form.get('sourceFailures', [])})

    # Watch candidates use the same logs but never join the official pick ledger.
    candidates = {w['id']: w for report in reports if report['league'] == 'NFL'
                  for w in report.get('gameWatch', []) if w.get('athleteId') and w.get('marketTitle')}
    for id_, watch in candidates.items():
        game = games.get(watch['gameId'])
        if not game:
            continue
        try:
            athlete = fetch(f'{WEB}/athletes/{watch["athleteId"]}')['athlete']
            team = str(athlete.get('team', {}).get('id'))
            if athlete.get('displayName', '').casefold() != watch.get('player', '').casefold():
                mark_failure(watches, id_, 'Player identity unavailable')
                continue
            if team not in (game['away']['id'], game['home']['id']):
                mark_failure(watches, id_, 'Player affiliation could not be verified for target game')
                continue
            opponent = game['away']['id'] if team == game['home']['id'] else game['home']['id']
            form = prop_history({'title': watch['marketTitle']}, game, watch['athleteId'], opponent,
                                watches.get(id_, {}).get('recentForm'), attempted_at, team)
            if form:
                watches[id_] = {'gameId': game['id'], 'athleteId': str(watch['athleteId']),
                                'position': position(str(watch['athleteId']), positions),
                                'marketTitle': watch['marketTitle'], 'recentForm': form}
                if form.get('status') == 'stale':
                    failures.append({'id': id_, 'attemptedAt': attempted_at,
                                     'error': 'History refresh incomplete', 'sources': form.get('sourceFailures', [])})
        except (OSError, ValueError, KeyError, TypeError) as error:
            mark_failure(watches, id_, type(error).__name__)
            continue

    # Each Week 2 defense's immediately preceding Week 1 opponent is a sourced
    # positional box-score reference, never a multi-game defense projection.
    if '--picks-only' not in sys.argv:
        nfl = sorted((g for g in games.values() if g['league'] == 'NFL' and g['completed']), key=lambda g: g['kickoff'])
        upcoming = [g for g in games.values() if g['league'] == 'NFL' and g['season'] == 2026 and not g['completed']]
        for game in upcoming:
            context = copy.deepcopy(contexts.get(game['id'], {}))
            for side in ('home', 'away'):
                team = game[side]
                prior = next((g for g in reversed(nfl) if g['kickoff'] < game['kickoff']
                              and team['id'] in (g['home']['id'], g['away']['id'])), None)
                if not prior:
                    continue
                prior_id = prior['id'].split('-')[1]
                try:
                    if prior_id not in summaries:
                        summaries[prior_id] = fetch(f'{API}/summary?event={prior_id}')
                    data = defense_context(game, {'id': prior['id'], 'kickoff': prior['kickoff'], 'defenseId': team['id']},
                                           summaries[prior_id], positions)
                    if not data:
                        raise ValueError('Defensive context unavailable')
                    context[side] = {**data, 'checkedAt': attempted_at, 'lastAttemptAt': attempted_at}
                except (OSError, ValueError, KeyError, TypeError) as error:
                    failure = {'gameId': game['id'], 'side': side, 'attemptedAt': attempted_at,
                               'error': type(error).__name__, 'source': f'{API}/summary?event={prior_id}'}
                    failures.append(failure)
                    if side in context:
                        context[side].update(status='stale', lastAttemptAt=attempted_at, error=type(error).__name__)
            if context:
                contexts[game['id']] = context
    output = {'updatedAt': attempted_at,
              'provider': 'ESPN public athlete game logs and official box scores',
              'coverage': 'NFL regular-season player logs across the current and two previous seasons; defense context is one sourced prior game. Per-record checkedAt is the last successful history check.',
              'picks': histories, 'watches': watches, 'defenses': contexts, 'failures': failures}
    temporary = output_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(output_path)
    print(f'{len(histories)} player histories, {len(watches)} watches, {len(contexts)} game defensive contexts, {len(failures)} failures')


if __name__ == '__main__':
    main()
