"""NFL snap counts and game context from nflverse, keyed to ESPN IDs.

ESPN publishes no snap counts. nflverse publishes free weekly CSVs sourced from
Pro Football Reference; this script reduces them to one append-only line per
game in data/nflverse/nfl-<season>.jsonl, joined to the ESPN event ID and ESPN
team and athlete IDs used everywhere else:

  snaps     offensive snaps and share for every QB/RB/FB/WR/TE who played
  context   roof, surface, temperature, wind, rest days and starting QBs

Players are matched by nflverse's PFR-to-ESPN ID crosswalk, else by name within
that team's box score for the game; anything still unmatched is kept with its
PFR ID and no ESPN ID. A changed file appends a revision, like the box scores.

Usage: python scripts/nflverse.py [--seasons 2024 2025 2026]
Stdlib only. Data attribution: nflverse (github.com/nflverse), Pro Football Reference.
"""
import argparse
import csv
import io
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'nflverse'
EXTRACTOR = 1
SNAPS = 'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv'
GAMES = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv'
PLAYERS = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv'
SKILL = {'QB', 'RB', 'FB', 'WR', 'TE'}
SUFFIX = re.compile(r'\b(jr|sr|ii|iii|iv|v)\b')


def download(url):
    with urlopen(url, timeout=60) as response:
        return list(csv.DictReader(io.StringIO(response.read().decode('utf-8'))))


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return int(result) if result.is_integer() else result


def name_key(name):
    """'D.K. Metcalf Jr.' and 'DK Metcalf' compare equal."""
    return SUFFIX.sub('', re.sub(r'[^a-z ]', '', str(name or '').lower().replace('.', ''))).replace(' ', '')


def team_map(schedule_row, record):
    """nflverse team abbreviation -> ESPN team ID, verified by the final score."""
    home, away = schedule_row['home_team'], schedule_row['away_team']
    scores = (number(schedule_row.get('home_score')), number(schedule_row.get('away_score')))
    if scores != (record['home']['score'], record['away']['score']):
        raise ValueError(f'nflverse and ESPN finals disagree for {schedule_row["game_id"]}')
    return {home: record['home']['id'], away: record['away']['id']}


def build(game_rows, schedule_row, record, crosswalk, sources, retrieved_at):
    teams = team_map(schedule_row, record)
    by_name = defaultdict(dict)
    for player in record['players']:
        if player.get('name'):
            by_name[player['team']][name_key(player['name'])] = player['id']
    team_snaps, players, quality = defaultdict(int), [], {'crosswalk': 0, 'name': 0, 'unmatched': 0}
    for row in game_rows:
        team = teams.get(row['team'])
        snaps = number(row.get('offense_snaps')) or 0
        if team is None:
            raise ValueError(f'Unknown team {row["team"]} in {row["game_id"]}')
        team_snaps[team] = max(team_snaps[team], snaps)
        if row.get('position') not in SKILL or snaps <= 0:
            continue
        espn = crosswalk.get(row.get('pfr_player_id'))
        method = 'crosswalk' if espn else None
        if not espn:
            espn = by_name[team].get(name_key(row.get('player')))
            method = 'name' if espn else 'unmatched'
        quality[method] += 1
        line = {'pfr': row.get('pfr_player_id'), 'name': row.get('player'), 'team': team, 'pos': row['position'],
                'snaps': snaps, 'pct': number(row.get('offense_pct'))}
        if espn:
            line['id'] = str(espn)
        if method == 'name':
            line['matchedBy'] = 'name'
        players.append(line)
    context = {'roof': schedule_row.get('roof') or None, 'surface': schedule_row.get('surface') or None,
               'temp': number(schedule_row.get('temp')), 'wind': number(schedule_row.get('wind')),
               'homeRest': number(schedule_row.get('home_rest')), 'awayRest': number(schedule_row.get('away_rest')),
               'divisional': schedule_row.get('div_game') == '1',
               'homeQB': schedule_row.get('home_qb_name') or None, 'awayQB': schedule_row.get('away_qb_name') or None}
    out = {'extractor': EXTRACTOR, 'league': 'NFL', 'eventId': record['eventId'], 'season': record['season'],
           'week': number(schedule_row.get('week')), 'gameType': schedule_row.get('game_type'),
           'nflverseId': schedule_row['game_id'], 'kickoff': record['kickoff'],
           'teams': {team: {'snaps': snaps} for team, snaps in sorted(team_snaps.items())},
           'players': sorted(players, key=lambda p: (p['team'], -p['snaps'], p['pfr'] or '')),
           'context': {k: v for k, v in context.items() if v is not None}, 'quality': quality,
           'sources': sources, 'retrievedAt': retrieved_at}
    out['hash'] = boxscores.content_hash(out)
    return out


def refresh(seasons, fetch=download, now=None, root=STORE, box_root=boxscores.STORE):
    """Append new or changed games. Returns ({file: lines}, problems)."""
    retrieved_at = boxscores.stamp(now or datetime.now(timezone.utc))
    schedule = {row['game_id']: row for row in fetch(GAMES)}
    crosswalk = {row['pfr_id']: str(number(row['espn_id'])) for row in fetch(PLAYERS)
                 if row.get('pfr_id') and number(row.get('espn_id')) is not None}
    box = {r['eventId']: r for r in boxscores.stored(box_root).values() if r['league'] == 'NFL'}
    existing = boxscores.stored(root)
    added, problems = {}, []
    for season in seasons:
        url = SNAPS.format(season=season)
        try:
            rows = fetch(url)
        except OSError as error:
            problems.append(f'{season}: snap counts unavailable ({type(error).__name__})')
            continue
        games = defaultdict(list)
        for row in rows:
            games[row['game_id']].append(row)
        new = []
        for game_id, game_rows in sorted(games.items()):
            schedule_row = schedule.get(game_id)
            event = (schedule_row or {}).get('espn')
            if not event or event not in box:
                problems.append(f'{game_id}: no stored ESPN box score for event {event or "unknown"}')
                continue
            try:
                line = build(game_rows, schedule_row, box[event], crosswalk,
                             {'snaps': url, 'schedule': GAMES, 'players': PLAYERS}, retrieved_at)
            except ValueError as error:
                problems.append(str(error))
                continue
            previous = existing.get(event)
            if previous and previous['hash'] == line['hash']:
                continue
            if previous:
                line['revision'] = previous.get('revision', 1) + 1
            new.append(line)
        new.sort(key=lambda r: (r['kickoff'], int(r['eventId'])))
        boxscores.append(boxscores.store_path('NFL', season, root), new)
        if new:
            added[f'nfl-{season}.jsonl'] = len(new)
    return added, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--seasons', nargs='+', type=int)
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    season = now.year if now.month >= 7 else now.year - 1
    problems = boxscores.verify(STORE)
    if problems:
        sys.exit('Refusing to append to a store whose recorded lines changed:\n  ' + '\n  '.join(problems))
    STORE.mkdir(parents=True, exist_ok=True)
    try:
        added, problems = refresh(args.seasons or [season], now=now)
    except OSError as error:
        # nflverse unavailable: keep the last good lines; the hosted run continues.
        print(f'nflverse unavailable ({type(error).__name__}); stored snap counts unchanged.')
        return
    boxscores.write_json(STORE / 'ledger.json', boxscores.ledger(STORE))
    print(f'Appended {sum(added.values())} game lines {added or ""}; {len(problems)} games skipped.')
    for problem in problems[:10]:
        print('  ' + problem)


if __name__ == '__main__':
    main()
