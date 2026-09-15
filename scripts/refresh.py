"""Public schedule/result refresh and immutable pregame baseline forecasts. Stdlib only."""
import json
import math
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen, Request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
MODEL = 'elo-total-v1'

def stamp(dt):
    return dt.isoformat(timespec='seconds').replace('+00:00', 'Z')

def read(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default

def fetch(league, start, end):
    slug = 'nfl' if league == 'NFL' else 'college-football'
    url = f'https://site.api.espn.com/apis/site/v2/sports/football/{slug}/scoreboard?dates={start:%Y%m%d}-{end:%Y%m%d}&limit=1000'
    if league == 'CFB':
        url += '&groups=80'
    with urlopen(url, timeout=45) as r:
        data = json.load(r)
    if not isinstance(data.get('events'), list):
        raise ValueError(f'{league}: invalid provider response')
    if len(data['events']) >= 1000:
        raise ValueError('Provider limit reached; split date window before publishing')
    return data['events'], url

def normalize(event, league):
    c = event['competitions'][0]
    sides = {x['homeAway']: x for x in c['competitors']}
    if set(sides) != {'home', 'away'}:
        raise ValueError('Expected two teams')
    status = c.get('status', event.get('status'))['type']
    game = dict(id=f'{league}-{event["id"]}', league=league, kickoff=event['date'], seasonType=event['season']['type'],
                season=event['season']['year'], week=event.get('week', {}).get('number'),
                state=status['state'], completed=status.get('completed', False),
                status=status['description'], neutral=c.get('neutralSite', False),
                timeValid=c.get('timeValid', False),
                source=f'https://www.espn.com/{"nfl" if league == "NFL" else "college-football"}/game/_/gameId/{event["id"]}')
    for side, item in sides.items():
        t = item['team']
        score = item.get('score')
        game[side] = dict(id=t['id'], name=t['displayName'], short=t.get('shortDisplayName', t['displayName']),
                          abbreviation=t.get('abbreviation', t['displayName']),
                          score=int(score) if score is not None and status['state'] != 'pre' else None)
    odds = c.get('odds', [])
    if odds:
        odds = odds[0]
        home_spread = odds.get('pointSpread', {}).get('home', {})
        total = odds.get('total', {})
        game['market'] = {
            'provider': odds.get('provider', {}).get('displayName', odds.get('provider', {}).get('name')),
            'spread': home_spread.get('close', {}).get('line'),
            'spreadOdds': home_spread.get('close', {}).get('odds'),
            'spreadOpen': home_spread.get('open', {}).get('line'),
            'total': odds.get('overUnder'),
            'totalOpen': total.get('over', {}).get('open', {}).get('line'),
            'overOdds': total.get('over', {}).get('close', {}).get('odds'),
            'underOdds': total.get('under', {}).get('close', {}).get('odds'),
            'link': odds.get('link', {}).get('href')
        }
    return game

class Model:
    def __init__(self, league):
        self.ratings = {}
        self.totals = {}
        self.counts = {}
        self.year = None
        self.base = 45.0 if league == 'NFL' else 53.0
        self.home = 1.5 if league == 'NFL' else 2.5

    def advance(self, season):
        if self.year is not None and season != self.year:
            self.ratings = {k: v * .65 for k, v in self.ratings.items()}
            self.totals = {k: self.base + (v - self.base) * .5 for k, v in self.totals.items()}
        self.year = season

    def train(self, g):
        self.advance(g['season'])
        h, a = g['home']['id'], g['away']['id']
        margin = g['home']['score'] - g['away']['score']
        observed = max(-35, min(35, margin))
        expected = self.ratings.get(h, 0) - self.ratings.get(a, 0) + (0 if g['neutral'] else self.home)
        update = .12 * (observed - expected)
        self.ratings[h] = self.ratings.get(h, 0) + update
        self.ratings[a] = self.ratings.get(a, 0) - update
        total = min(100, g['home']['score'] + g['away']['score'])
        for team in (h, a):
            self.totals[team] = .8 * self.totals.get(team, self.base) + .2 * total
            self.counts[team] = self.counts.get(team, 0) + 1

    def predict(self, g, now):
        self.advance(g['season'])
        h, a = g['home']['id'], g['away']['id']
        margin = max(-42, min(42, self.ratings.get(h, 0) - self.ratings.get(a, 0) + (0 if g['neutral'] else self.home)))
        total = .5 * (self.totals.get(h, self.base) + self.totals.get(a, self.base))
        sparse = min(self.counts.get(h, 0), self.counts.get(a, 0)) < 6
        return dict(gameId=g['id'], publishedAt=stamp(now), home=max(0, round((total + margin) / 2)),
                    away=max(0, round((total - margin) / 2)), model=MODEL, type='baseline',
                    confidence=2 if sparse else 3, sparse=sparse,
                    trainingGames={'home': self.counts.get(h, 0), 'away': self.counts.get(a, 0)},
                    why='Opponent-adjusted historical scoring margin with smoothed team game totals. ' +
                        ('Limited team history; league-average assumptions carry more weight. ' if sparse else '') +
                        'No injury, roster, weather, or betting-market adjustment. Analyst review pending.',
                    sources=[g['source']])

def validate_report(report, games):
    assert report['league'] in ('NFL', 'CFB')
    published = datetime.fromisoformat(report['publishedAt'].replace('Z', '+00:00'))
    assert published.tzinfo is not None
    assert published <= datetime.now(timezone.utc) + timedelta(minutes=5), 'Future publication date'
    assert report.get('historicalImport') is True or len(report.get('props', [])) <= 5
    assert len(report.get('riskyProps', [])) <= 3
    assert len(report.get('parlays', [])) <= 2
    assert isinstance(report.get('takeaways', []), list)
    assert isinstance(report.get('weeklyReview', []), list)
    if report.get('targetWeek') is not None:
        assert isinstance(report['targetWeek'], int) and report['targetWeek'] >= 0
    for watch in report.get('gameWatch', []):
        assert watch.get('gameId') in games, 'Watch entry has no matching game'
        assert games[watch['gameId']]['league'] == report['league']
        assert all(watch.get(k) for k in ('id', 'title', 'why', 'needs', 'sources'))
        assert all(url.startswith('https://') for url in watch['sources'])
    historical = report.get('historicalImport') is True
    for score in report.get('scores', []):
        assert score['gameId'] in games
        g = games[score['gameId']]
        assert g['league'] == report['league']
        assert historical or published < datetime.fromisoformat(g['kickoff'].replace('Z', '+00:00')), 'Late score forecast'
        assert all(isinstance(score[s], int) and 0 <= score[s] <= 100 for s in ('home', 'away'))
        assert score.get('why') and score.get('sources')
        assert all(s.startswith('https://') for s in score['sources'])
        assert historical and score.get('confidence') is None or 1 <= score['confidence'] <= 10
    for pick in report.get('props', []) + report.get('riskyProps', []) + report.get('parlays', []):
        for key in ('id', 'title', 'why', 'risk', 'sources', 'status'):
            assert pick.get(key), f'Missing {key}'
        assert all(s.startswith('https://') for s in pick['sources'])
        assert pick['status'] in ('active', 'withdrawn', 'watch', 'expired', 'settled', 'historical')
        if pick.get('recentForm') is not None:
            form = pick['recentForm']
            assert isinstance(form, dict)
            assert form.get('stat')
            assert form.get('source', '').startswith('https://')
            for window, expected in (('last5', 5), ('last10', 10)):
                if form.get(window) is not None:
                    sample = form[window]
                    assert isinstance(sample, dict)
                    assert sample.get('sample') == expected
                    assert isinstance(sample.get('hits'), int) and 0 <= sample['hits'] <= expected
            if form.get('games') is not None:
                form_games = form['games']
                assert isinstance(form_games, list) and 1 <= len(form_games) <= 10
                assert isinstance(form.get('line'), (int, float))
                for game in form_games:
                    assert isinstance(game, dict)
                    assert isinstance(game.get('value'), (int, float))
                    assert isinstance(game.get('hit'), bool)
            if form.get('lastVsOpponent') is not None:
                last_vs = form['lastVsOpponent']
                assert isinstance(last_vs, dict)
                assert all(last_vs.get(k) is not None for k in ('value', 'date', 'source'))
                assert last_vs['source'].startswith('https://')
        if pick['status'] == 'historical':
            assert pick.get('result') in ('win', 'loss', 'push', 'void', 'unverified')
            assert pick.get('actual') is not None
            assert pick.get('resultSource', '').startswith('https://')
        if pick['status'] == 'settled':
            assert pick.get('result') in ('win', 'loss', 'push', 'void')
            assert pick.get('resultSource', '').startswith('https://')
            assert pick.get('settledAt') and pick.get('actual') is not None
            assert isinstance(pick.get('odds'), (int, float)) and abs(pick['odds']) >= 100
        if pick['status'] == 'active':
            assert not historical, 'Historical import cannot become an active recommendation'
            for key in ('book', 'odds', 'quotedAt', 'expiresAt', 'gameIds', 'cutoff', 'confidence', 'edge'):
                assert pick.get(key) is not None, f'Missing {key}'
            quote = datetime.fromisoformat(pick['quotedAt'].replace('Z', '+00:00'))
            expires = datetime.fromisoformat(pick['expiresAt'].replace('Z', '+00:00'))
            assert quote <= published < expires
            assert 1 <= pick['confidence'] <= 10
            assert isinstance(pick['odds'], (int, float)) and abs(pick['odds']) >= 100
            assert pick['gameIds'], 'No games attached'
            if pick in report.get('parlays', []):
                assert len(pick.get('legs', [])) >= 2 and pick.get('correlation')
            else:
                assert pick.get('projection') is not None
                assert pick.get('position'), 'Active prop missing position'
            if report['league'] == 'CFB':
                assert pick.get('jurisdictionVerified') is True
            for gid in pick['gameIds']:
                assert gid in games, f'Unknown game {gid}'
                assert games[gid]['league'] == report['league']
                assert historical or published < datetime.fromisoformat(games[gid]['kickoff'].replace('Z', '+00:00')), 'Late recommendation'
    return report

def main():
    now = datetime.now(timezone.utc)
    season = now.year if now.month >= 7 else now.year - 1
    DATA.mkdir(parents=True, exist_ok=True)
    existing = read(DATA / 'slate.json', {'games': []})
    games = {g['id']: g for g in existing['games']}
    forecasts = read(DATA / 'forecasts.json', [])
    known = {p['gameId'] for p in forecasts}
    sources = []
    for league in ('NFL', 'CFB'):
        old, _ = fetch(league, datetime(season-1, 8, 1), datetime(season, 2, 20))
        assert len(old) > 100, 'Historical feed unexpectedly incomplete'
        current, url = fetch(league, datetime(season, 8, 1), now + timedelta(days=14))
        normalized = [normalize(e, league) for e in current if e['season']['type'] in (2, 3)]
        sources.append({'league': league, 'url': url, 'retrievedAt': stamp(now)})
        training = sorted([normalize(e, league) for e in old if e['season']['type'] in (2, 3)] + normalized, key=lambda g: g['kickoff'])
        model = Model(league)
        for g in training:
            if g['completed'] and datetime.fromisoformat(g['kickoff'].replace('Z', '+00:00')) < now:
                model.train(g)
        for g in normalized:
            previous = games.get(g['id'], {})
            history = previous.get('marketHistory', [])
            if g.get('market'):
                market = g['market']
                keys = ('provider', 'spread', 'spreadOdds', 'total', 'overOdds', 'underOdds')
                snapshot = {key: market.get(key) for key in keys}
                if not history or any(history[-1].get(key) != snapshot[key] for key in keys):
                    snapshot['retrievedAt'] = stamp(now)
                    snapshot['phase'] = 'pregame' if g['state'] == 'pre' and datetime.fromisoformat(g['kickoff'].replace('Z', '+00:00')) > now else 'post-start'
                    history = (history + [snapshot])[-50:]
                g['marketHistory'] = history
                g['marketRetrievedAt'] = stamp(now)
            elif history:
                g['marketHistory'] = history
            games[g['id']] = g
            kickoff = datetime.fromisoformat(g['kickoff'].replace('Z', '+00:00'))
            if g['state'] == 'pre' and kickoff > now and g['timeValid'] and g['id'] not in known:
                forecasts.append(model.predict(g, now))
                known.add(g['id'])
    reports = [validate_report(read(p, {}), games) for p in sorted((ROOT / 'research').glob('*.json'))]
    payload = {'updatedAt': stamp(now), 'sources': sources, 'games': sorted(games.values(), key=lambda g: g['kickoff'])}
    # All network reads and validation succeed before replacing any published data.
    for name, value in [('slate.json', payload), ('forecasts.json', forecasts), ('research.json', reports)]:
        path = DATA / name
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)
    print(f'Refreshed {len(games)} games, {len(forecasts)} pregame forecasts, {len(reports)} research reports.')

if __name__ == '__main__':
    main()

