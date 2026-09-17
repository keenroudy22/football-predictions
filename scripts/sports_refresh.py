"""Refresh read-only NBA/MLB schedules and scores in six bounded requests.

This snapshot supplies no odds, forecasts, recommended picks, or betting results.
A failed league keeps its entire last successful snapshot and its original time.
Calendar dates use America/Indianapolis; event IDs distinguish doubleheaders.
"""
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'site/data/sports.json'
LEAGUES = {'NBA': ('basketball', 'nba'), 'MLB': ('baseball', 'mlb')}
TIME_ZONE = 'America/Indianapolis'


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Provider time must include its UTC offset')
    return parsed.astimezone(timezone.utc)


def eastern_date(value):
    """Use IANA data, with modern US DST fallback for Windows without tzdata."""
    moment = timestamp(value) if isinstance(value, str) else value
    try:
        return moment.astimezone(ZoneInfo(TIME_ZONE)).date()
    except ZoneInfoNotFoundError:
        # The current schedule never requests years before the 2007 US rule.
        if moment.year < 2007:
            raise ValueError('IANA time-zone data required before 2007')
        march = datetime(moment.year, 3, 1, 7, tzinfo=timezone.utc)
        start = march + timedelta(days=(6 - march.weekday()) % 7 + 7)
        november = datetime(moment.year, 11, 1, 6, tzinfo=timezone.utc)
        end = november + timedelta(days=(6 - november.weekday()) % 7)
        offset = -4 if start <= moment.astimezone(timezone.utc) < end else -5
        return moment.astimezone(timezone(timedelta(hours=offset))).date()


def endpoint(league, day):
    sport, slug = LEAGUES[league]
    return (f'https://site.api.espn.com/apis/site/v2/sports/{sport}/{slug}/scoreboard'
            f'?dates={day:%Y%m%d}&limit=100')


def source_link(event, fallback):
    for link in event.get('links', []):
        url = link.get('href', '')
        if 'summary' in link.get('rel', []) and url.startswith('https://www.espn.com/'):
            return url
    return fallback


def game_status(status):
    kind = status.get('type', {})
    name = kind.get('name', '').upper()
    # Exceptional statuses can carry a post state but do not mean a final game.
    for word, normalized in [('POSTPONED', 'postponed'), ('CANCELED', 'cancelled'),
                             ('CANCELLED', 'cancelled'), ('SUSPENDED', 'suspended'),
                             ('DELAYED', 'delayed')]:
        if word in name:
            return normalized
    if kind.get('completed') is True:
        return 'final'
    return {'pre': 'scheduled', 'in': 'in_progress'}.get(kind.get('state'), 'unknown')


def score_value(raw):
    if isinstance(raw, dict):
        raw = raw.get('value', raw.get('displayValue'))
    if raw is None or raw == '':
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError('Invalid provider score') from None
    if value < 0 or str(value) != str(raw):
        raise ValueError('Invalid provider score')
    return value


def normalize(payload, league, now, url):
    if not isinstance(payload, dict) or not isinstance(payload.get('events'), list):
        raise ValueError('Provider did not supply an event list')
    if not any(str(item.get('abbreviation', '')).upper() == league
               for item in payload.get('leagues', [])):
        raise ValueError('Provider league identity could not be verified')
    games = []
    for event in payload['events']:
        provider_id = str(event.get('id', ''))
        if not provider_id or not event.get('competitions'):
            raise ValueError('Provider event identity or competition missing')
        competition = event['competitions'][0]
        kickoff = competition.get('date') or event.get('date')
        if not kickoff:
            raise ValueError('Provider event date missing')
        kickoff = timestamp(kickoff).isoformat(timespec='seconds').replace('+00:00', 'Z')
        status_data = competition.get('status') or event.get('status') or {}
        status = game_status(status_data)
        teams, scores = {}, {}
        for competitor in competition.get('competitors', []):
            side = competitor.get('homeAway')
            team = competitor.get('team', {})
            if side not in ('away', 'home') or side in teams:
                raise ValueError('Provider home/away identities are ambiguous')
            if not team.get('id') or not team.get('displayName'):
                raise ValueError('Provider team identity missing')
            teams[side] = {'id': str(team['id']), 'name': team['displayName'],
                           'shortName': team.get('shortDisplayName', team['displayName']),
                           'abbreviation': team.get('abbreviation', ''),
                           'logo': team.get('logo')}
            # Pregame feeds often use placeholder 0-0, which is not a score.
            scores[side] = None if status in ('scheduled', 'postponed', 'cancelled') else score_value(competitor.get('score'))
        if set(teams) != {'home', 'away'}:
            raise ValueError('Both teams are required')
        if status == 'final' and any(value is None for value in scores.values()):
            raise ValueError('Final game missing a score')
        season = event.get('season', {})
        games.append({
            'id': f'{league}-{provider_id}', 'providerId': provider_id,
            'league': league, 'sport': LEAGUES[league][0],
            'season': season.get('year'), 'seasonType': season.get('slug'),
            'date': eastern_date(kickoff).isoformat(), 'kickoff': kickoff,
            'timeConfirmed': competition.get('timeValid', True) is not False,
            'status': status,
            'statusDetail': status_data.get('type', {}).get('shortDetail') or status_data.get('type', {}).get('description', 'Status unavailable'),
            'period': status_data.get('period'), 'clock': status_data.get('displayClock'),
            'teams': teams, 'scores': scores,
            'source': {'name': 'ESPN', 'url': source_link(event, url)},
            'updatedAt': now,
        })
    return games


def refresh(previous, fetch, now):
    start = eastern_date(now)
    days = [start + timedelta(days=offset) for offset in range(3)]
    window = {'from': days[0].isoformat(), 'through': days[-1].isoformat(), 'timeZone': TIME_ZONE}
    result = {'schemaVersion': 1, 'updatedAt': now, 'timeZone': TIME_ZONE, 'leagues': {}}
    for league, (sport, _) in LEAGUES.items():
        old = previous.get('leagues', {}).get(league, {})
        base = {'league': league, 'sport': sport,
                'coverage': {'scores': True, 'forecasts': False, 'props': False, 'picks': False},
                'coverageNote': 'Schedules and scores only. Researched picks and forecasts are not yet available.',
                'lastAttemptAt': now, 'requestedWindow': window}
        try:
            by_id = {}
            urls = [endpoint(league, day) for day in days]
            for url in urls:
                for game in normalize(fetch(url), league, now, url):
                    if window['from'] <= game['date'] <= window['through']:
                        by_id[game['id']] = game
            result['leagues'][league] = {**base, 'status': 'ok', 'checkedAt': now,
                'lastSuccessfulAt': now, 'error': None, 'window': window,
                'source': {'name': 'ESPN', 'url': urls[0], 'urls': urls},
                'games': sorted(by_id.values(), key=lambda game: (game['kickoff'], game['id']))}
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            # Avoid displaying partial provider coverage as a complete empty slate.
            # A successful empty snapshot (e.g. NBA offseason) is still last-good data.
            has_snapshot = bool(old.get('lastSuccessfulAt') or old.get('checkedAt'))
            result['leagues'][league] = {**deepcopy(old), **base,
                'status': 'stale' if has_snapshot else 'unavailable',
                'checkedAt': old.get('checkedAt'),
                'lastSuccessfulAt': old.get('lastSuccessfulAt', old.get('checkedAt')),
                'error': f'{type(error).__name__}: schedule refresh unavailable',
                'window': deepcopy(old.get('window', window)),
                'source': deepcopy(old.get('source', {'name': 'ESPN', 'url': endpoint(league, days[0])})),
                'games': deepcopy(old.get('games', []))}
    return result


def main():
    previous = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {}
    def fetch(url):
        with urlopen(url, timeout=20) as response:
            return json.load(response)
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    result = refresh(previous, fetch, now)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    print(json.dumps({league: {'status': data['status'], 'games': len(data['games']),
                              'checkedAt': data['checkedAt']}
                      for league, data in result['leagues'].items()}))


if __name__ == '__main__':
    main()
