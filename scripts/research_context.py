"""Refresh sourced injury context without rewriting picks or implying starters.

Two league requests per run. On failure retain the last successful snapshot and
record the failed attempt. An absent player is never classified as healthy.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'site/data/research-context.json'


def normalize(payload, league, now, previous=None):
    if not isinstance(payload.get('injuries'), list):
        raise ValueError('Provider did not supply an injury list')
    teams = {}
    for team in payload['injuries']:
        if not team.get('id') or not isinstance(team.get('injuries'), list):
            raise ValueError('Invalid team injury response')
        rows = []
        for injury in team['injuries']:
            athlete = injury.get('athlete', {})
            source = next((x['href'] for x in athlete.get('links', []) if x.get('href', '').startswith('https://') and 'playercard' in x.get('rel', [])), None)
            linked_id = re.search(r'/id/(\d+)', source or '')
            athlete_id = athlete.get('id') or (linked_id.group(1) if linked_id else None)
            if not athlete_id or not athlete.get('displayName'):
                continue
            rows.append({'id': str(athlete_id), 'name': athlete['displayName'],
                         'position': athlete.get('position', {}).get('abbreviation', 'Unknown'),
                         'status': injury.get('status', 'Unknown'),
                         'injury': injury.get('details', {}).get('type'),
                         'reportedAt': injury.get('date'),
                         'source': source})
        if team['injuries'] and not rows:
            raise ValueError('Injured player identities could not be normalized')
        teams[str(team['id'])] = {'name': team.get('displayName', ''), 'players': rows}
    old = {(t, p['id']): p for t, d in (previous or {}).get('teams', {}).items() for p in d['players']}
    changes = list((previous or {}).get('changes', []))
    for team_id, data in teams.items():
        for p in data['players']:
            prior = old.get((team_id, p['id']))
            if prior and prior['status'] != p['status']:
                changes.append({'teamId': team_id, 'name': p['name'], 'from': prior['status'],
                                'to': p['status'], 'observedAt': now, 'source': p['source']})
    slug = 'nfl' if league == 'NFL' else 'college-football'
    return {'teams': teams, 'changes': changes[-50:], 'status': 'ok', 'checkedAt': now,
            'lastAttemptAt': now, 'source': f'https://www.espn.com/{slug}/injuries',
            'coverage': 'Provider-listed injuries only; not confirmed starters or game-day inactives.'}


def refresh(previous, fetch, now):
    result = {'updatedAt': now, 'leagues': {}}
    for league, slug in [('NFL', 'nfl'), ('CFB', 'college-football')]:
        old = previous.get('leagues', {}).get(league, {})
        url = f'https://site.api.espn.com/apis/site/v2/sports/football/{slug}/injuries'
        try:
            result['leagues'][league] = normalize(fetch(url), league, now, old)
        except (OSError, ValueError, KeyError, TypeError) as error:
            result['leagues'][league] = {**old, 'status': 'failed', 'lastAttemptAt': now,
                                        'error': type(error).__name__, 'teams': old.get('teams', {})}
    return result


def main():
    previous = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {}
    def fetch(url):
        with urlopen(url, timeout=25) as response:
            return json.load(response)
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    result = refresh(previous, fetch, now)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    print({league: {'status': data['status'], 'teams': len(data['teams'])} for league, data in result['leagues'].items()})


if __name__ == '__main__':
    main()
