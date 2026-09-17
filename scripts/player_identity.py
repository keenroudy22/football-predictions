"""Refresh identities for followed football players using ESPN's public APIs.

Only IDs already present in research/history are queried (at most 40 per run).
Current affiliations come from athlete detail, never the recommendation matchup.
No credentials, extra packages, broad roster crawl, or background process.
"""
import copy
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
OUTPUT = DATA / 'player-identity.json'
SLUGS = {'NFL': 'nfl', 'CFB': 'college-football'}
MAX_ATHLETES = 40
MAX_WORKERS = 4


def athlete_url(league, athlete_id):
    return f'https://site.web.api.espn.com/apis/common/v3/sports/football/{SLUGS[league]}/athletes/{athlete_id}'


def team_url(league, team_id):
    return f'https://site.api.espn.com/apis/site/v2/sports/football/{SLUGS[league]}/teams/{team_id}'


def numeric_id(value):
    value = str(value or '')
    return value if re.fullmatch(r'[1-9][0-9]*', value) else None


def color(value):
    if not isinstance(value, str):
        return None
    value = value.removeprefix('#')
    return value.upper() if re.fullmatch(r'[0-9a-fA-F]{6}', value) else None


def candidates(reports, history):
    """Prioritize newest research, then sourced history; deduplicate by league."""
    found = {}

    def visit(node, inherited_league=None):
        if isinstance(node, list):
            for item in node:
                visit(item, inherited_league)
            return
        if not isinstance(node, dict):
            return
        league = node.get('league', inherited_league)
        game_id = node.get('gameId', '')
        if isinstance(game_id, str) and game_id.split('-')[0] in SLUGS:
            league = game_id.split('-')[0]
        athlete_id = numeric_id(node.get('athleteId'))
        # Existing exact-market history has a sourced player URL even when an
        # older row predates the explicit athleteId field.
        form_source = node.get('recentForm', {}).get('source', '') if isinstance(node.get('recentForm'), dict) else ''
        matched = re.fullmatch(r'https://www\.espn\.com/(nfl|college-football)/player/gamelog/_/id/([1-9][0-9]*)/?', form_source)
        if matched and not athlete_id:
            source_league = 'NFL' if matched.group(1) == 'nfl' else 'CFB'
            if league in (None, source_league):
                league, athlete_id = source_league, matched.group(2)
        if league in SLUGS and athlete_id:
            found.setdefault(f'{league}/{athlete_id}', (league, athlete_id))
        for child in node.values():
            if isinstance(child, (list, dict)):
                visit(child, league)

    for report in sorted(reports, key=lambda row: row.get('publishedAt', ''), reverse=True):
        visit(report)
    for bucket in ('watches', 'picks'):
        visit(history.get(bucket, {}))
    return list(found.values())


def normalized_team(team):
    if not isinstance(team, dict):
        return None
    team_id = numeric_id(team.get('id'))
    name = team.get('displayName') or team.get('name')
    abbreviation = team.get('abbreviation')
    if not team_id or not isinstance(name, str) or not name.strip() or not isinstance(abbreviation, str) or not abbreviation.strip():
        return None
    result = {'id': team_id, 'name': name.strip(), 'abbreviation': abbreviation.strip()}
    for key in ('color', 'alternateColor'):
        checked = color(team.get(key))
        if checked:
            result[key] = checked
    return result


def load_identity(league, athlete_id, fetch, now):
    source = athlete_url(league, athlete_id)
    payload = fetch(source)
    athlete = payload.get('athlete')
    if not isinstance(athlete, dict) or numeric_id(athlete.get('id')) != athlete_id:
        raise ValueError('Athlete identity did not match requested ID')
    name = athlete.get('displayName')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Athlete name unavailable')
    position = athlete.get('position', {})
    position = position.get('abbreviation') if isinstance(position, dict) else None
    row = {'athleteId': athlete_id, 'league': league, 'name': name.strip(),
           'position': position if isinstance(position, str) and position else None,
           'team': None, 'source': source, 'checkedAt': now,
           'lastAttemptAt': now, 'status': 'team-unavailable'}
    supplied_team = athlete.get('team')
    if not isinstance(supplied_team, dict) or not supplied_team:
        return row
    team_id = numeric_id(supplied_team.get('id'))
    if not team_id:
        reference = supplied_team.get('$ref', '')
        matched = re.search(r'/teams/([1-9][0-9]*)(?:[/?]|$)', reference) if isinstance(reference, str) else None
        team_id = matched.group(1) if matched else None
    if not team_id:
        return row
    team = normalized_team(supplied_team)
    if team is None or not any(key in supplied_team for key in ('color', 'alternateColor')):
        team_source = team_url(league, team_id)
        detail = fetch(team_source).get('team')
        if not isinstance(detail, dict) or numeric_id(detail.get('id')) != team_id:
            raise ValueError('Team identity did not match athlete affiliation')
        team = normalized_team(detail)
        if team is None:
            raise ValueError('Team details unavailable')
        row['teamSource'] = team_source
    row.update(team=team, status='ok')
    return row


def refresh(reports, history, previous, fetch, now, max_athletes=MAX_ATHLETES):
    eligible = candidates(reports, history)
    # A hard upper bound remains in force even if callers supply a larger value.
    selected = eligible[:max(0, min(max_athletes, MAX_ATHLETES))]
    players = copy.deepcopy(previous.get('players', {}))
    failures = []

    def check(item):
        league, athlete_id = item
        key = f'{league}/{athlete_id}'
        try:
            return key, load_identity(league, athlete_id, fetch, now), None
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            failure = {'key': key, 'source': athlete_url(league, athlete_id),
                       'attemptedAt': now, 'error': type(error).__name__}
            return key, None, failure

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for key, row, failure in pool.map(check, selected):
            if failure:
                failures.append(failure)
                if key in players:
                    # checkedAt still describes the last successful source read.
                    players[key].update(status='stale', lastAttemptAt=now, error=failure['error'])
            else:
                players[key] = row
    return {'updatedAt': now, 'provider': 'ESPN public athlete/team detail',
            'coverage': 'Followed NFL/CFB athletes only. Team affiliation does not establish health, participation, or starter status.',
            'attempted': len(selected), 'deferred': len(eligible) - len(selected),
            'players': players, 'failures': failures}


def main():
    reports = json.loads((DATA / 'research.json').read_text(encoding='utf-8'))
    history_path = DATA / 'player-history.json'
    history = json.loads(history_path.read_text(encoding='utf-8')) if history_path.exists() else {}
    previous = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {}

    def fetch(url):
        with urlopen(url, timeout=12) as response:
            return json.load(response)

    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    result = refresh(reports, history, previous, fetch, now)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    print(json.dumps({'players': len(result['players']), 'attempted': result['attempted'],
                      'deferred': result['deferred'], 'failures': len(result['failures'])}))


if __name__ == '__main__':
    main()
