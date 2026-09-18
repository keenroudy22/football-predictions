"""Build view-shaped payloads for the next front end.

The current site fetches 4.68 MB of JSON before first paint, including a 1.8 MB
player history file, on every visit, for every visitor, whatever page they land
on. This emits small per-view slices instead, derived entirely from the files
already in site/data. It invents nothing and computes nothing the existing
pipeline does not already record.

    python scripts/build_next_data.py
"""
import json
import os
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'site', 'data')
OUT = os.path.join(DATA, 'next')

# Primary team colours. Factual brand colours, used only for accents.
NFL_COLORS = {
    'ARI': '#97233F', 'ATL': '#A71930', 'BAL': '#241773', 'BUF': '#00338D',
    'CAR': '#0085CA', 'CHI': '#0B162A', 'CIN': '#FB4F14', 'CLE': '#FF3C00',
    'DAL': '#003594', 'DEN': '#FB4F14', 'DET': '#0076B6', 'GB': '#203731',
    'HOU': '#03202F', 'IND': '#002C5F', 'JAX': '#006778', 'KC': '#E31837',
    'LAC': '#0080C6', 'LAR': '#003594', 'LV': '#A5ACAF', 'MIA': '#008E97',
    'MIN': '#4F2683', 'NE': '#002244', 'NO': '#D3BC8D', 'NYG': '#0B2265',
    'NYJ': '#125740', 'PHI': '#004C54', 'PIT': '#FFB612', 'SEA': '#002244',
    'SF': '#AA0000', 'TB': '#D50A0A', 'TEN': '#4B92DB', 'WSH': '#5A1414',
}
NEUTRAL = '#64748B'

# Provider strings as the feed spells them, mapped to the books' own names.
BOOKS = {'Draft Kings': 'DraftKings', 'DraftKings': 'DraftKings',
         'Fan Duel': 'FanDuel', 'FanDuel': 'FanDuel',
         'Bet MGM': 'BetMGM', 'BetMGM': 'BetMGM', 'ESPN BET': 'ESPN BET'}


def read(name, fallback=None):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return fallback
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def moment(value):
    if not value:
        return None
    try:
        text = str(value).replace('Z', '+00:00')
        stamp = datetime.fromisoformat(text)
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def team_color(league, abbr, identities):
    if league == 'NFL':
        return NFL_COLORS.get(abbr, NEUTRAL)
    return identities.get(abbr, NEUTRAL)


def identity_colors(identity):
    """Team colours observed in the followed-player identities, by abbreviation."""
    out = {}
    for row in (identity or {}).get('players', {}).values():
        team = row.get('team') or {}
        abbr, color = team.get('abbreviation'), team.get('color')
        if abbr and color:
            out.setdefault(abbr, '#' + color.lstrip('#'))
    return out


def first_publications(reports):
    """Each pick as first published, plus its latest settlement, by id.

    Original prices and projections are anchored to first publication, matching
    records.js. A later revision may add a result; it may not rewrite history.
    """
    first, latest = {}, {}
    ordered = sorted(reports or [], key=lambda r: (r.get('publishedAt') or ''))
    for report in ordered:
        league, published = report.get('league'), report.get('publishedAt')
        for kind in ('props', 'riskyProps', 'gamePicks', 'parlays'):
            for pick in report.get(kind) or []:
                key = pick.get('id')
                if not key:
                    continue
                if key not in first:
                    first[key] = dict(pick, league=league, kind=kind,
                                      publishedAt=pick.get('publishedAt') or published,
                                      historicalImport=bool(report.get('historicalImport')))
                latest[key] = dict(latest.get(key, {}), **pick)
    return first, latest


def build_lines(catalog, games, identities, now):
    """Every catalogued line, carrying the state the board needs to sort and filter."""
    out = []
    for row in (catalog or {}).get('lines', []):
        game = games.get(row.get('gameId')) or {}
        kickoff = moment(row.get('kickoff') or game.get('kickoff'))
        started = bool(game.get('completed')) or (game.get('state') and game['state'] != 'pre') \
            or (kickoff is not None and kickoff <= now)
        expires = moment(row.get('expiresAt'))
        if started:
            state = 'closed'
        elif row.get('status') in ('expired', 'stale') or (expires and expires <= now):
            state = 'stale'
        elif row.get('odds') is None or row.get('status') == 'missing-price':
            state = 'unpriced'
        elif row.get('quoteType') != 'sportsbook':
            state = 'reference'
        else:
            state = 'open'
        abbr = (row.get('team')
                or (game.get('home', {}) or {}).get('abbreviation'))
        out.append({
            'id': row.get('id'),
            'league': row.get('league'),
            'gameId': row.get('gameId'),
            'player': row.get('player'),
            'athleteId': row.get('athleteId'),
            'position': row.get('position'),
            'market': row.get('market'),
            'direction': row.get('direction'),
            'line': row.get('line'),
            'odds': row.get('odds'),
            'book': row.get('book'),
            'state': state,
            'kickoff': row.get('kickoff') or game.get('kickoff'),
            'observedAt': row.get('observedAt'),
            'expiresAt': row.get('expiresAt'),
            'source': row.get('source'),
            'marketWindow': row.get('marketWindow'),
            'color': team_color(row.get('league'), abbr, identities),
            'title': row.get('title'),
        })
    return out


def _american(value):
    """Odds arrive as '+102' or '-110' strings; the board wants numbers."""
    try:
        return int(str(value).replace('+', ''))
    except (TypeError, ValueError):
        return None


def market_move(game):
    """Open-to-now movement, which slate.json already records but nothing shows."""
    market = game.get('market') or {}
    history = game.get('marketHistory') or []
    opener = next((h for h in history if h.get('spread') is not None), None)
    def number(value):
        try:
            return float(str(value).replace('+', ''))
        except (TypeError, ValueError):
            return None
    now_spread = number(market.get('spread'))
    open_spread = number((opener or {}).get('spread') or market.get('spreadOpen'))
    move = None
    if now_spread is not None and open_spread is not None:
        move = round(now_spread - open_spread, 1)
    return {
        'spread': market.get('spread'),
        'spreadOpen': (opener or {}).get('spread') or market.get('spreadOpen'),
        'spreadMove': move,
        'total': number(market.get('total')),
        'overOdds': market.get('overOdds'),
        'underOdds': market.get('underOdds'),
        'spreadOdds': market.get('spreadOdds'),
        # ESPN reports "Draft Kings"; the book spells itself DraftKings.
        'book': BOOKS.get((market.get('provider') or '').strip(), market.get('provider')),
    }


def build():
    os.makedirs(OUT, exist_ok=True)
    slate = read('slate.json', {}) or {}
    forecasts = {f['gameId']: f for f in (read('forecasts.json', []) or [])}
    reports = read('research.json', []) or []
    catalog = read('market-lines.json', {}) or {}
    identities = identity_colors(read('player-identity.json', {}))
    now = datetime.now(timezone.utc)

    games_raw = slate.get('games') or []
    by_id = {g['id']: g for g in games_raw}
    first, latest = first_publications(reports)

    horizon = now + timedelta(days=9)
    games = []
    for game in games_raw:
        kickoff = moment(game.get('kickoff'))
        if kickoff is None or kickoff > horizon:
            continue
        if game.get('completed') and kickoff < now - timedelta(days=9):
            continue
        model = forecasts.get(game['id']) or {}
        market = market_move(game)
        model_total = (model.get('home', 0) + model.get('away', 0)) if model else None
        edge = None
        if model_total is not None and market.get('total') is not None:
            edge = round(model_total - market['total'], 1)
        side = lambda t: {
            'abbr': (t or {}).get('abbreviation'),
            'name': (t or {}).get('short') or (t or {}).get('name'),
            'score': (t or {}).get('score'),
            'color': team_color(game.get('league'), (t or {}).get('abbreviation'), identities),
        }
        games.append({
            'id': game['id'], 'league': game.get('league'), 'kickoff': game.get('kickoff'),
            'state': game.get('state'), 'completed': bool(game.get('completed')),
            'status': game.get('status'), 'week': game.get('week'),
            'home': side(game.get('home')), 'away': side(game.get('away')),
            'model': ({'home': model.get('home'), 'away': model.get('away'),
                       'total': model_total, 'confidence': model.get('confidence'),
                       'sparse': model.get('sparse'), 'version': model.get('model')}
                      if model else None),
            'market': market,
            'totalEdge': edge,
        })

    lines = build_lines(catalog, by_id, identities, now)

    # Game markets live in slate.json, refreshed with the scoreboard. They are
    # the only lines that are actually current, so the board needs them.
    for game in games:
        if game['completed'] or game['state'] != 'pre':
            continue
        market = game['market']
        stamp = slate.get('updatedAt')
        for side, price, label in (
                ('spread', market.get('spread'),
                 '%s %s spread' % (game['home']['abbr'], market.get('spread'))),
                ('total', market.get('total'),
                 '%s @ %s total %s' % (game['away']['abbr'], game['home']['abbr'],
                                       market.get('total')))):
            if price is None:
                continue
            lines.append({
                'id': 'game-%s-%s' % (game['id'], side),
                'league': game['league'], 'gameId': game['id'],
                'player': None, 'athleteId': None, 'position': None,
                'market': 'point spread' if side == 'spread' else 'total points',
                'direction': None, 'line': price,
                'odds': _american(market.get('overOdds') if side == 'total'
                                  else market.get('spreadOdds')),
                'book': market.get('book'), 'state': 'open',
                'kickoff': game['kickoff'], 'observedAt': stamp,
                'expiresAt': None, 'source': None, 'marketWindow': 'Full game',
                'color': game['home']['color'], 'title': label,
                'gameMarket': True,
                'move': market.get('spreadMove') if side == 'spread' else None,
            })

    picks = []
    for key, pick in first.items():
        recent = latest.get(key, {})
        game = by_id.get((pick.get('gameIds') or [None])[0]) or {}
        picks.append({
            'id': key, 'league': pick.get('league'), 'kind': pick.get('kind'),
            'title': pick.get('title'), 'player': pick.get('player'),
            'athleteId': pick.get('athleteId'), 'position': pick.get('position'),
            'gameId': (pick.get('gameIds') or [None])[0],
            'line': pick.get('line'), 'direction': pick.get('direction'),
            'book': pick.get('book'), 'odds': pick.get('odds'),
            'projection': pick.get('projection'), 'confidence': pick.get('confidence'),
            'favorite': bool(pick.get('favorite')), 'cutoff': pick.get('cutoff'),
            'why': pick.get('why'), 'risk': pick.get('risk'), 'edge': pick.get('edge'),
            'quotedAt': pick.get('quotedAt'), 'expiresAt': pick.get('expiresAt'),
            'publishedAt': pick.get('publishedAt'),
            'historicalImport': pick.get('historicalImport'),
            'sources': pick.get('sources') or [],
            'result': recent.get('result'), 'actual': recent.get('actual'),
            'settledAt': recent.get('settledAt'),
            'settlementReason': recent.get('settlementReason'),
            'resultSource': recent.get('resultSource'),
            'kickoff': game.get('kickoff'),
            'color': team_color(pick.get('league'),
                                (game.get('home', {}) or {}).get('abbreviation'), identities),
        })
    picks.sort(key=lambda p: (p.get('publishedAt') or ''), reverse=True)

    wins = sum(1 for p in picks if p['result'] == 'win')
    losses = sum(1 for p in picks if p['result'] == 'loss')
    pushes = sum(1 for p in picks if p['result'] == 'push')
    voids = sum(1 for p in picks if p['result'] == 'void')
    pending = sum(1 for p in picks if not p['result'])
    priced = [p for p in picks if p['result'] in ('win', 'loss', 'push') and p.get('odds')]
    units = 0.0
    for pick in priced:
        odds = pick['odds']
        if pick['result'] == 'win':
            units += odds / 100 if odds > 0 else 100 / abs(odds)
        elif pick['result'] == 'loss':
            units -= 1
    graded = wins + losses
    record = {
        'wins': wins, 'losses': losses, 'pushes': pushes, 'voids': voids,
        'pending': pending, 'total': len(picks), 'graded': graded,
        'hitRate': round(100 * wins / graded, 1) if graded else None,
        'pricedSettled': len(priced),
        'unpricedSettled': sum(1 for p in picks
                               if p['result'] in ('win', 'loss', 'push') and not p.get('odds')),
        'units': round(units, 2) if priced else None,
        # Deliberately withheld below the threshold: a return over a handful of
        # priced bets is noise, and printing it is the least honest thing here.
        'roiMinimum': 10,
        'roi': (round(100 * units / len(priced), 1) if len(priced) >= 10 else None),
    }

    payload = {
        'updatedAt': slate.get('updatedAt') or catalog.get('updatedAt'),
        'generatedAt': now.replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'games': games, 'lines': lines, 'picks': picks, 'record': record,
        'counts': {'games': len(games), 'lines': len(lines),
                   'open': sum(1 for l in lines if l['state'] == 'open'),
                   'picks': len(picks)},
    }
    path = os.path.join(OUT, 'board.json')
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, separators=(',', ':'), sort_keys=True)
    return path, payload


if __name__ == '__main__':
    path, payload = build()
    size = os.path.getsize(path) / 1024
    print('%s  %.0f KB' % (os.path.relpath(path, ROOT), size))
    print('  %(games)d games, %(lines)d lines (%(open)d open), %(picks)d picks'
          % payload['counts'])
