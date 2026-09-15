"""Sourced NFL exact-market logs and last-game positional defense context.

This enrichment is separate from immutable original recommendations. Stdlib only.
"""
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
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


def fetch(url):
    with urlopen(url, timeout=25) as response:
        return json.load(response)


def number(value):
    try:
        return float(str(value).replace(',', ''))
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


def game_rows(log, stat, cutoff):
    if stat not in log.get('names', []):
        return []
    index = log['names'].index(stat)
    rows = []
    for season in log.get('seasonTypes', []):
        for category in season.get('categories', []):
            if category.get('type') != 'event':
                continue
            for row in category.get('events', []):
                event = log.get('events', {}).get(str(row['eventId']))
                if not event or event.get('gameDate', '') >= cutoff:
                    continue
                stats = row.get('stats', [])
                value = number(stats[index]) if index < len(stats) else None
                if value is not None:
                    rows.append((event['gameDate'], event['id'], event, value))
    return rows


def prop_history(pick, game, athlete_id, opponent_id):
    match = re.match(r'^(.+?) (OVER|UNDER) (\d+(?:\.\d+)?) (.+)$', pick['title'])
    if not match or match.group(4) not in MARKETS:
        return None
    _, direction, threshold, market = match.groups()
    threshold = float(threshold)
    stat = MARKETS[market]
    rows = []
    for season in (game['season'] - 1, game['season']):
        url = f'{WEB}/athletes/{athlete_id}/gamelog?season={season}'
        try:
            rows += game_rows(fetch(url), stat, game['kickoff'])
        except (OSError, ValueError, KeyError):
            continue
    # ESPN gameDate is a local calendar date, which can precede a UTC kickoff.
    # The event ID is the reliable boundary for excluding the pick's own game.
    rows = sorted((r for r in {r[1]: r for r in rows}.values()
                   if r[1] != game['id'].split('-')[1]), reverse=True)
    if not rows:
        return None
    latest = rows[:10]
    def hit(value):
        return value > threshold if direction == 'OVER' else value < threshold
    games = [{'label': f"{r[0][:10]} · {r[2]['opponent']['abbreviation']}",
              'value': r[3], 'hit': hit(r[3]),
              'source': f'https://www.espn.com/nfl/boxscore/_/gameId/{r[1]}'}
             for r in reversed(latest)]
    form = {'stat': market, 'line': threshold,
            'source': f'https://www.espn.com/nfl/player/gamelog/_/id/{athlete_id}',
            'games': games, 'sample': len(latest), 'method': 'Games played before this recommendation game; exact published threshold and direction.'}
    for window in (5, 10):
        if len(rows) >= window:
            form[f'last{window}'] = {'hits': sum(hit(r[3]) for r in rows[:window]), 'sample': window}
    prior = next((r for r in rows if r[2].get('opponent', {}).get('id') == opponent_id), None)
    if prior:
        form['lastVsOpponent'] = {'value': prior[3], 'date': prior[0][:10],
                                  'source': f'https://www.espn.com/nfl/boxscore/_/gameId/{prior[1]}'}
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
    offense = next((side for side in summary.get('boxscore', {}).get('players', [])
                    if side['team']['id'] != previous['defenseId']), None)
    if not offense:
        return None
    by_category = defaultdict(dict)
    for category in offense.get('statistics', []):
        for row in category.get('athletes', []):
            pos = position(row['athlete']['id'], positions)
            if pos not in ('QB', 'RB', 'WR', 'TE'):
                continue
            for key, raw in zip(category.get('keys', []), row.get('stats', [])):
                value = number(raw)
                if value is not None:
                    by_category[pos][(row['athlete']['id'], key)] = value
    desired = {'QB': ('passingYards', 'completions/passingAttempts'),
               'RB': ('rushingAttempts', 'rushingYards', 'receptions', 'receivingYards'),
               'WR': ('receptions', 'receivingYards'), 'TE': ('receptions', 'receivingYards')}
    aggregate = {}
    for pos, keys in desired.items():
        values = {}
        for key in keys:
            items = [v for (athlete, name), v in by_category[pos].items() if name == key]
            if items:
                values[key] = sum(items)
        # Passing attempts/completions are printed as C/ATT in the box score.
        if pos == 'QB':
            attempts = [str(raw) for category in offense.get('statistics', []) if category.get('name') == 'passing'
                        for row in category.get('athletes', []) if position(row['athlete']['id'], positions) == 'QB'
                        for key, raw in zip(category.get('keys', []), row.get('stats', []))
                        if key == 'completions/passingAttempts']
            pairs = [x.split('/') for x in attempts if '/' in x]
            if pairs:
                values['completions'] = sum(int(x[0]) for x in pairs)
                values['passingAttempts'] = sum(int(x[1]) for x in pairs)
        if values:
            aggregate[pos] = values
    return {'date': previous['kickoff'][:10], 'opponent': offense['team']['displayName'],
            'source': f'https://www.espn.com/nfl/boxscore/_/gameId/{previous["id"].split("-")[1]}',
            'positions': aggregate, 'note': 'One prior game against this defense; opponent personnel and game script differ.'}


def main():
    slate = json.loads((DATA / 'slate.json').read_text(encoding='utf-8'))
    reports = json.loads((DATA / 'research.json').read_text(encoding='utf-8'))
    games = {g['id']: g for g in slate['games']}
    summaries = {}
    histories = {}
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
            if pick.get('athleteId') and not game['completed']:
                athlete = fetch(f'{WEB}/athletes/{pick["athleteId"]}')['athlete']
                who = (str(pick['athleteId']), athlete.get('team', {}).get('id')) if athlete.get('displayName', '').casefold() == name.casefold() else None
            else:
                if id_ not in summaries:
                    summaries[id_] = fetch(f'{API}/summary?event={id_}')
                who = identity(summaries[id_], name)
                if not who and pick['title'].startswith('Brock Bowers'):
                    # A scratch is absent from the box score, but his prior
                    # player log still exists. Verify identity/team separately.
                    athlete = fetch(f'{WEB}/athletes/4432665')['athlete']
                    if athlete.get('displayName', '').casefold() == name.casefold():
                        who = ('4432665', athlete.get('team', {}).get('id'))
            if not who:
                continue  # Unverified identity: never infer a zero-game log.
            athlete_id, team_id = who
            if team_id not in (game['away']['id'], game['home']['id']):
                continue  # Reject stale roster/team identity.
            opponent_id = game['away']['id'] if team_id == game['home']['id'] else game['home']['id']
            form = prop_history(pick, game, athlete_id, opponent_id)
            if form:
                histories[pick['id']] = {'gameId': game['id'], 'position': position(athlete_id, {}),
                                         'recentForm': form, 'athleteId': athlete_id}

    # Each Week 2 defense's immediately preceding Week 1 opponent is a sourced
    # positional box-score reference, never a multi-game defense projection.
    positions = {}
    if '--picks-only' in sys.argv and (DATA / 'player-history.json').exists():
        contexts = json.loads((DATA / 'player-history.json').read_text(encoding='utf-8'))['defenses']
    else:
        contexts = {}
        nfl = sorted((g for g in games.values() if g['league'] == 'NFL' and g['completed']), key=lambda g: g['kickoff'])
        upcoming = [g for g in games.values() if g['league'] == 'NFL' and g['season'] == 2026 and not g['completed']]
        for game in upcoming:
            context = {}
            for side in ('home', 'away'):
                team = game[side]
                prior = next((g for g in reversed(nfl) if g['kickoff'] < game['kickoff']
                              and team['id'] in (g['home']['id'], g['away']['id'])), None)
                if not prior:
                    continue
                prior_id = prior['id'].split('-')[1]
                if prior_id not in summaries:
                    summaries[prior_id] = fetch(f'{API}/summary?event={prior_id}')
                data = defense_context(game, {'id': prior['id'], 'kickoff': prior['kickoff'], 'defenseId': team['id']},
                                       summaries[prior_id], positions)
                if data:
                    context[side] = data
            if context:
                contexts[game['id']] = context
    output = {'updatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
              'provider': 'ESPN public athlete game logs and official box scores',
              'picks': histories, 'defenses': contexts}
    (DATA / 'player-history.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{len(histories)} player histories, {len(contexts)} game defensive contexts')


if __name__ == '__main__':
    main()
