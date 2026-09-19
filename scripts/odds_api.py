"""Spreads and totals across books from The Odds API, captured before kickoff on a credit budget.

One call per league returns every upcoming game with each book's spread and total
(DraftKings, FanDuel, BetMGM, Caesars, BetRivers, ESPN BET, Fanatics). Each capture is
appended to data/odds/<league>-<season>.jsonl only when a game's numbers changed, with
the retrieval time; the board shows the best price per side and names the book, and
the scoreboard can grade closing-line value against the book a pick was taken at.

The free tier is 500 credits a month. A call costs 2 (two markets, one bookmaker group),
so the script paces itself: a league is captured only when it has a game inside two
days, at least 3.5 hours after its last capture, at most three times a day (four on its
big day), and never below a 24-credit reserve. data/odds/status.json carries the pacing
state and the last usage headers between runs, hosted or local.

The key comes from the ODDS_API_KEY environment variable and is never written to a log,
a URL in the store, or the repository. Without it the script prints that it skipped and
exits 0, so the hosted workflow runs whether or not the secret is set.

Usage: python scripts/odds_api.py
Stdlib only.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features
from sports_refresh import eastern_date

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'odds'
API = 'https://api.the-odds-api.com/v4/sports/{sport}/odds'
SPORTS = {'NFL': 'americanfootball_nfl', 'CFB': 'americanfootball_ncaaf'}
BOOKS = ('draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers', 'espnbet', 'fanatics')   # <= 10: one region
MARKETS = ('spreads', 'totals')
COST = len(MARKETS)                       # credits per call: markets x bookmaker groups
WINDOW = timedelta(days=2)                # capture a league only with a game this close
MIN_GAP = timedelta(hours=3, minutes=30)  # between captures of one league
DAILY_CAP = {'NFL': {6: 4}, 'CFB': {5: 4}}  # weekday -> cap on the league's big day; else 3
DEFAULT_CAP = 3
RESERVE = 24                              # credits kept back for the month's last days


def normal(name):
    """Team names from two providers, made comparable."""
    text = str(name or '').lower().replace('&', ' and ')
    text = re.sub(r'\(.*?\)', ' ', text)
    return re.sub(r'[^a-z0-9]+', ' ', text).strip()


def same_team(a, b):
    """Two spellings of one team: equal once normalised, or the same mascot and related first words.

    "UMass Minutemen" and "Massachusetts Minutemen", "UL Monroe Warhawks" and "Louisiana-Monroe
    Warhawks": the mascot matches and the first words share four letters in a row. The caller
    also requires the kickoff to match, which rules out two Tigers on the same afternoon.
    """
    x, y = normal(a), normal(b)
    if not x or not y:
        return False
    if x == y or x in y or y in x:
        return True
    xw, yw = x.split(), y.split()
    if xw[-1] != yw[-1]:
        return False
    if len(xw) > 1 and len(yw) > 1 and xw[-2:] == yw[-2:]:
        return True
    if xw[0] == yw[0]:
        return True
    first, other = (xw[0], yw[0]) if len(xw[0]) <= len(yw[0]) else (yw[0], xw[0])
    return any(first[i:i + 4] in other for i in range(len(first) - 3))


def match(events, games):
    """Odds API event -> slate game: both teams the same and a kickoff within six hours.

    ESPN's orientation wins when the providers disagree about who is home; the event is
    flagged `swapped` so the book lines are read against the right team.
    """
    pairs, unmatched = [], []
    for event in events:
        start = features.when(event['commence_time'])
        home, away = event.get('home_team'), event.get('away_team')
        found = swapped = None
        for game in games:
            if abs(features.when(game['kickoff']) - start) > timedelta(hours=6):
                continue
            if same_team(game['home']['name'], home) and same_team(game['away']['name'], away):
                found, swapped = game, False
                break
            if same_team(game['home']['name'], away) and same_team(game['away']['name'], home):
                found, swapped = game, True
                break
        if found:
            pairs.append((dict(event, swapped=swapped), found))
        else:
            unmatched.append(f"{away} at {home} {event.get('commence_time')}")
    return pairs, unmatched


def books_of(event, home, away):
    """book key -> spread (home side) and total, American prices, from one event.

    home and away are the slate's names; each book's outcomes are matched to them by team.
    """
    out = {}
    for book in event.get('bookmakers', []):
        entry = {'title': book.get('title'), 'updatedAt': book.get('last_update')}
        for market in book.get('markets', []):
            outcomes = {normal(o.get('name')): o for o in market.get('outcomes', [])}
            if market.get('key') == 'spreads':
                h = next((o for name, o in outcomes.items() if same_team(name, home)), None)
                a = next((o for name, o in outcomes.items() if same_team(name, away)), None)
                if h and a and isinstance(h.get('point'), (int, float)):
                    entry['spread'] = {'home': h['point'], 'homePrice': h.get('price'), 'awayPrice': a.get('price')}
            elif market.get('key') == 'totals':
                over, under = outcomes.get('over'), outcomes.get('under')
                if over and under and isinstance(over.get('point'), (int, float)):
                    entry['total'] = {'line': over['point'], 'over': over.get('price'), 'under': under.get('price')}
        if 'spread' in entry or 'total' in entry:
            out[book['key']] = entry
    return out


def best(record, side):
    """The best line and price for one side across a record's books: number first, then price.

    side: 'home', 'away', 'over' or 'under'. Returns (book key, line for that side, price) or None.
    """
    rows = []
    for key, book in record['books'].items():
        if side in ('home', 'away') and book.get('spread'):
            s = book['spread']
            line = s['home'] if side == 'home' else -s['home']
            price = s['homePrice'] if side == 'home' else s['awayPrice']
            rows.append((line, price if price is not None else -1000, key))
        elif side in ('over', 'under') and book.get('total'):
            t = book['total']
            line = -t['line'] if side == 'over' else t['line']   # a lower total is better for the over
            price = t['over'] if side == 'over' else t['under']
            rows.append((line, price if price is not None else -1000, key))
    if not rows:
        return None
    line, price, key = max(rows)
    if side == 'over':
        line = -line
    return key, line, price


def due(league, games, status, now):
    """Why a league is or is not captured now; None means capture."""
    soon = [g for g in games if g['league'] == league and g.get('state') == 'pre'
            and now < features.when(g['kickoff']) <= now + WINDOW]
    if not soon:
        return 'no game inside two days'
    usage = status.get('usage') or {}
    if usage.get('remaining') is not None and usage['remaining'] - COST < RESERVE:
        return f"only {usage['remaining']} credits left; keeping the reserve"
    mine = status.get('leagues', {}).get(league, {})
    if mine.get('lastAt') and now - features.when(mine['lastAt']) < MIN_GAP:
        return f"captured {mine['lastAt']}, inside the gap"
    today = eastern_date(now)
    cap = DAILY_CAP[league].get(today.weekday(), DEFAULT_CAP)
    if mine.get('day') == today.isoformat() and mine.get('count', 0) >= cap:
        return f'{cap} captures already today'
    return None


def fetch(sport, key):
    query = urllib.parse.urlencode({'apiKey': key, 'markets': ','.join(MARKETS), 'bookmakers': ','.join(BOOKS),
                                    'oddsFormat': 'american', 'dateFormat': 'iso'})
    request = urllib.request.Request(API.format(sport=sport) + '?' + query, headers={'User-Agent': 'keenroudy-sports'})
    with urllib.request.urlopen(request, timeout=60) as response:
        headers = {k: response.headers.get(k) for k in ('x-requests-remaining', 'x-requests-used', 'x-requests-last')}
        return json.load(response), headers


def capture(slate, now, key, status, fetch=fetch, root=STORE, log=print):
    """Capture every due league; returns the updated status."""
    games = [g for g in slate.get('games', []) if g.get('league') in SPORTS]
    latest = {}
    for path in sorted(root.glob('*.jsonl')):
        for line in boxscores.read_store(path):
            latest[line['gameId']] = line
    status.setdefault('leagues', {})
    for league, sport in SPORTS.items():
        reason = due(league, games, status, now)
        if reason:
            log(f'{league}: skipped ({reason})')
            continue
        try:
            events, headers = fetch(sport, key)
        except Exception as error:   # the key never reaches the log
            log(f'{league}: request failed ({type(error).__name__})')
            continue
        usage = {k.replace('x-requests-', ''): int(v) for k, v in headers.items() if v and str(v).lstrip('-').isdigit()}
        status['usage'] = {**usage, 'at': boxscores.stamp(now)}
        today = eastern_date(now).isoformat()
        mine = status['leagues'].setdefault(league, {})
        mine.update(lastAt=boxscores.stamp(now), day=today, count=(mine.get('count', 0) if mine.get('day') == today else 0) + 1)
        pairs, unmatched = match(events, [g for g in games if g['league'] == league])
        written = []
        for event, game in pairs:
            books = books_of(event, game['home']['name'], game['away']['name'])
            if not books:
                continue
            record = {'league': league, 'gameId': game['id'], 'eventId': game['id'].split('-', 1)[1],
                      'season': game.get('season'), 'kickoff': game['kickoff'], 'oddsApiId': event.get('id'),
                      'retrievedAt': boxscores.stamp(now), 'source': API.format(sport=sport) + ' (key withheld)',
                      'books': books}
            previous = latest.get(game['id'])
            if previous and previous['books'] == books:
                continue
            record['hash'] = boxscores.content_hash(record)
            written.append(record)
        for season in sorted({r['season'] for r in written}):
            boxscores.append(boxscores.store_path(league, season, root), [r for r in written if r['season'] == season])
        log(f"{league}: {len(pairs)} games matched, {len(written)} changed, {len(unmatched)} not on the slate; "
            f"credits used {usage.get('used')} remaining {usage.get('remaining')}")
        if unmatched:
            log('  not on the slate: ' + '; '.join(unmatched[:6]))
    return status


def main():
    key = os.environ.get('ODDS_API_KEY', '').strip()
    if not key:
        print('No ODDS_API_KEY in the environment; odds capture skipped.')
        return
    problems = boxscores.verify(STORE)
    if problems:
        sys.exit('Refusing to append to an odds store whose recorded lines changed:\n  ' + '\n  '.join(problems))
    STORE.mkdir(parents=True, exist_ok=True)
    status_path = STORE / 'status.json'
    status = json.loads(status_path.read_text(encoding='utf-8')) if status_path.exists() else {}
    slate = json.loads((ROOT / 'site' / 'data' / 'slate.json').read_text(encoding='utf-8'))
    status = capture(slate, datetime.now(timezone.utc), key, status)
    boxscores.write_json(status_path, status)
    boxscores.write_json(STORE / 'ledger.json', boxscores.ledger(STORE))


if __name__ == '__main__':
    main()
