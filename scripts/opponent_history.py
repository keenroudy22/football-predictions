"""Bounded opponent box-score history for upcoming, followed NFL matchups."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

try:
    from .player_history import defense_context
except ImportError:
    from player_history import defense_context

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl'
MAX_GAMES = 4


def instant(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (ValueError, TypeError):
        return None


def selected_games(slate, reports, now):
    followed = set()
    for report in reports:
        if report.get('league') != 'NFL':
            continue
        for key in ('props', 'riskyProps', 'gameWatch'):
            for item in report.get(key, []):
                if not item.get('athleteId'):
                    continue
                followed.update(item.get('gameIds', []) or [item.get('gameId')])
    return sorted((g for g in slate.get('games', []) if g.get('id') in followed
                   and g.get('league') == 'NFL' and g.get('state') == 'pre'
                   and instant(g.get('kickoff')) and instant(g['kickoff']) > instant(now)),
                  key=lambda g: g['kickoff'])[:MAX_GAMES]


def past_games(schedule, defense_id, cutoff, target_id):
    """The schedule envelope may name the current season; trust each event."""
    if str(schedule.get('team', {}).get('id')) != str(defense_id):
        raise ValueError('Schedule team identity mismatch')
    rows = []
    for event in schedule.get('events', []):
        comp = next(iter(event.get('competitions', [])), {})
        teams = comp.get('competitors', [])
        event_time = instant(event.get('date'))
        season_type = event.get('seasonType', {}).get('type', event.get('seasonType', {}).get('id'))
        if str(season_type) != '2' or not comp.get('status', {}).get('type', {}).get('completed'):
            continue
        if not event_time or event_time >= instant(cutoff) or str(event.get('id')) == target_id:
            continue
        if len(teams) != 2 or str(defense_id) not in {str(t.get('team', {}).get('id')) for t in teams}:
            continue
        rows.append({'id': 'NFL-' + str(event['id']), 'kickoff': event['date'],
                     'season': event.get('season', {}).get('year'), 'defenseId': str(defense_id)})
    return rows


def validate_summary(summary, prior):
    header = summary.get('header', {})
    comp = next(iter(header.get('competitions', [])), {})
    if str(header.get('id')) != prior['id'].split('-')[-1]:
        raise ValueError('Box-score event identity mismatch')
    if not comp.get('status', {}).get('type', {}).get('completed'):
        raise ValueError('Box score is not final')
    teams = {str(t.get('team', {}).get('id')) for t in comp.get('competitors', [])}
    if len(teams) != 2 or prior['defenseId'] not in teams:
        raise ValueError('Box-score team identity mismatch')


def refresh(slate, reports, previous, fetch, now):
    output = copy.deepcopy(previous)
    output.update(updatedAt=now, provider='ESPN public team schedules and final box scores',
                  coverage='Up to four upcoming followed NFL games; last five regular-season games across the current and previous season. Position labels are provider classifications, not historical snap alignments.', failures=[])
    output.setdefault('games', {})
    positions = {}
    for block in previous.get('games', {}).values():
        for context in block.values():
            for game in context.get('games', []):
                for player in game.get('players', []):
                    if player.get('athleteId') and player.get('position'):
                        positions[str(player['athleteId'])] = player['position']
    cache = {}

    def get(url):
        if url not in cache:
            cache[url] = fetch(url)
        return cache[url]

    for target in selected_games(slate, reports, now):
        target_context = output['games'].setdefault(target['id'], {})
        for side in ('home', 'away'):
            team = target[side]
            defense_id = str(team['id'])
            try:
                rows = []
                sources = []
                for season in (target['season'] - 1, target['season']):
                    source = f'{API}/teams/{defense_id}/schedule?season={season}&seasontype=2'
                    sources.append(source)
                    rows += past_games(get(source), defense_id, target['kickoff'], target['id'].split('-')[-1])
                rows = sorted({r['id']: r for r in rows}.values(), key=lambda r: r['kickoff'], reverse=True)[:5]
                if not rows:
                    raise ValueError('No completed regular-season reference games')
                summaries = [(row, get(f'{API}/summary?event={row["id"].split("-")[-1]}')) for row in rows]
                ids = set()
                for row, summary in summaries:
                    validate_summary(summary, row)
                    for offense in summary.get('boxscore', {}).get('players', []):
                        if str(offense.get('team', {}).get('id')) == defense_id:
                            continue
                        for category in offense.get('statistics', []):
                            if category.get('name') not in ('passing', 'rushing', 'receiving'):
                                continue
                            ids.update(str(p['athlete']['id']) for p in category.get('athletes', []))

                def identify(athlete_id):
                    payload = get(f'{WEB}/athletes/{athlete_id}').get('athlete', {})
                    if str(payload.get('id')) != athlete_id or not payload.get('position', {}).get('abbreviation'):
                        raise ValueError('Unverified player position')
                    return athlete_id, payload['position']['abbreviation']

                with ThreadPoolExecutor(max_workers=4) as pool:
                    positions.update(pool.map(identify, sorted(ids - positions.keys())))
                contexts = []
                for row, summary in summaries:
                    # Only the offensive categories relevant to player props are used.
                    summary = copy.deepcopy(summary)
                    for offense in summary['boxscore']['players']:
                        offense['statistics'] = [c for c in offense.get('statistics', []) if c.get('name') in ('passing', 'rushing', 'receiving')]
                    context = defense_context(target, row, summary, positions)
                    if not context:
                        raise ValueError('Position box score unavailable')
                    context.update(season=row['season'], checkedAt=now)
                    contexts.append(context)
                target_context[side] = {'defenseId': defense_id, 'defenseName': team['name'],
                                        'gameId': target['id'], 'cutoffAt': target['kickoff'],
                                        'sample': len(contexts), 'games': contexts,
                                        'status': 'ok', 'checkedAt': now, 'lastAttemptAt': now, 'sources': sources}
            except (OSError, ValueError, KeyError, TypeError) as error:
                old = target_context.get(side, {})
                old.update(status='stale' if old.get('games') else 'unavailable', lastAttemptAt=now,
                           reason='Opponent history could not be fully verified on this check.')
                target_context[side] = old
                output['failures'].append({'gameId': target['id'], 'side': side, 'error': type(error).__name__})
    return output


def main():
    def read(name, fallback):
        path = DATA / name
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else fallback

    def fetch(url):
        with urlopen(url, timeout=15) as response:
            return json.load(response)

    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    result = refresh(read('slate.json', {}), read('research.json', []), read('opponent-history.json', {}), fetch, now)
    path = DATA / 'opponent-history.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(path)
    print(json.dumps({'matchups': len(result['games']), 'failures': result['failures']}))


if __name__ == '__main__':
    main()
