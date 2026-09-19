"""Prices and chances: what v2's stored numbers say about one line at one price.

Shared by the research desk (scripts/desk.py) and the site build (scripts/build_site.py), so a
pick and the board read the same line the same way. A chance is a normal approximation around
the stored v2 mean, with the spread its 80% range implies; results are whole numbers, so a
whole-number line can push. Stdlib only.
"""
import math

import model_v2

Z80 = model_v2.Z80
CAVEAT = "Chances are v2's normal curve shrunk toward 50% by its 2024-25 record against the close; player props are raw."
# Prop markets as the DraftKings capture names them, and the v2 stat that projects each.
PROJECTED = {'rec': 'receptions', 'car': 'carries', 'recYds': 'recYds', 'rushYds': 'rushYds', 'att': 'att',
             'cmp': 'cmp', 'passYds': 'passYds'}
WORDS = {'rec': 'receptions', 'car': 'carries', 'recYds': 'receiving yards', 'rushYds': 'rushing yards',
         'att': 'pass attempts', 'cmp': 'completions', 'passYds': 'passing yards'}
# Phrases in older pick titles, most specific first.
TITLE_MARKETS = (('receiving yards', 'recYds'), ('rushing yards', 'rushYds'), ('passing yards', 'passYds'),
                 ('receptions', 'rec'), ('carries', 'car'), ('rushing attempts', 'car'), ('completions', 'cmp'),
                 ('pass attempts', 'att'), ('passing attempts', 'att'))
KEYS = (-7, -3, 3, 7)
RULES = {'prop': 0.5, 'total': 1.5, 'cents': 15}

# Board colors: how many points v2's calibrated chance clears what the price needs.
STRONG, LEAN = 5.0, 2.0
# calibrated = 50% + k * (raw - 50%). Fit by scripts/calibrate.py on the 2024-25 walk-forward against the close,
# where the side v2 favoured won 49.5% (NFL spreads), 52.9% (NFL totals), 50.5% (FBS spreads) and 53.4% (FBS
# totals) whatever the raw number said. No entry means no graded history yet: the raw chance is shown as such.
CALIBRATION = {('NFL', 'spread'): 0.0, ('NFL', 'total'): 0.42, ('CFB', 'spread'): 0.15, ('CFB', 'total'): 0.36}


# ------------------------------------------------------------------ arithmetic

def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def chances(mean, sd, line):
    """(over, push, under) for a whole-number result against a line."""
    if float(line).is_integer():
        over = 1 - phi((line + 0.5 - mean) / sd)
        under = phi((line - 0.5 - mean) / sd)
        return over, 1 - over - under, under
    over = 1 - phi((line - mean) / sd)
    return over, 0.0, 1 - over


def payout(odds):
    """Profit per unit risked at American odds."""
    return odds / 100 if odds > 0 else 100 / -odds


def break_even(odds):
    return 1 / (1 + payout(odds))


def cents(odds):
    """American odds on one continuous scale, so -105 to +105 is 10 cents, not 210."""
    return odds + 100 if odds < 0 else odds - 100


def worse_price(odds, by=RULES['cents']):
    """The price RULES['cents'] worse than odds, back in American form."""
    value = cents(odds) - by
    return value - 100 if value < 0 else value + 100


def fmt(line):
    return f'{line:g}'


def signed(line):
    return f'{line:+g}' if line else 'PK'


def tier(edge, thin=False):
    """strong (5+ points), lean (2 to 5) or pass. A thin sample never reads as strong."""
    if edge is None:
        return None
    if edge >= STRONG and not thin:
        return 'strong'
    return 'lean' if edge >= LEAN else 'pass'


def player_line(snapshot, athlete):
    for side in ('home', 'away'):
        for player in ((snapshot['players'] or {}).get(side) or {}).get('players', []):
            if player['id'] == str(athlete):
                return side, player
    return None, None


def price(snapshot, market, side, line, odds, athlete=None):
    """The numbers for one candidate, from one stored v2 snapshot.

    chance is calibrated (see CALIBRATION); rawChance is the normal curve's own number.
    """
    market = {v: k for k, v in PROJECTED.items()}.get(market, market)
    league = snapshot.get('league') or str(snapshot.get('gameId', '')).split('-')[0]
    game_market = market in ('spread', 'total')
    if game_market:
        if market == 'spread' and side not in ('home', 'away') or market == 'total' and side not in ('over', 'under'):
            raise ValueError(f'{market} takes {"home or away" if market == "spread" else "over or under"}')
        if market == 'spread':
            mean, sd = snapshot['margin'], snapshot['sd']['margin']
            # Home covers when margin + line > 0; away covers when margin < away line.
            over, push, under = chances(mean, sd, -line if side == 'home' else line)
            win, loss = (over, under) if side == 'home' else (under, over)
            what, low_high = 'home margin', snapshot['range80']['margin']
        else:
            mean, sd = snapshot['total'], snapshot['sd']['total']
            over, push, under = chances(mean, sd, line)
            win, loss = (over, under) if side == 'over' else (under, over)
            what, low_high = 'total', snapshot['range80']['total']
    else:
        if market not in PROJECTED or side not in ('over', 'under'):
            raise ValueError(f'player markets are {", ".join(PROJECTED)} with over or under')
        if not athlete:
            raise ValueError('a player market needs --player')
        _, player = player_line(snapshot, athlete)
        if not player or PROJECTED[market] not in player:
            raise ValueError(f'v2 has no {PROJECTED[market]} projection for athlete {athlete} in this snapshot')
        mean, low, high = player[PROJECTED[market]]
        sd = (high - mean) / Z80
        if sd <= 0:
            raise ValueError('the stored range has no width; no chance can be computed')
        over, push, under = chances(mean, sd, line)
        win, loss = (over, under) if side == 'over' else (under, over)
        what, low_high = WORDS[market], [low, high]
    raw = win
    k = CALIBRATION.get((league, market))
    if k is not None:
        win = 0.5 + k * (raw - 0.5)
        loss = max(0.0, 1 - win - push)
    even = break_even(odds)
    edge = 100 * (win - even)
    ev = win * payout(odds) - loss
    trust = (f"v2's raw {100 * raw:.1f}% shrunk by its 2024-25 record against the close" if k is not None
             else 'uncalibrated: no graded history against a line yet')
    return {'gameId': snapshot['gameId'], 'market': market, 'side': side, 'line': line, 'odds': odds,
            'athleteId': str(athlete) if athlete else None, 'model': snapshot['model'],
            'snapshotAt': snapshot['publishedAt'], 'projection': round(mean, 1), 'range80': low_high,
            'sd': round(sd, 2), 'chance': round(win, 3), 'rawChance': round(raw, 3), 'calibration': k,
            'calibrated': k is not None, 'push': round(push, 3), 'breakEven': round(even, 3),
            'edgePoints': round(edge, 1), 'evPerUnit': round(ev, 3),
            'edge': (f"v2 {what} {mean:.1f} (80% range {fmt(low_high[0])} to {fmt(low_high[1])}). "
                     f"Chance of {side} {signed(line) if market == 'spread' else fmt(line)}: {100 * win:.1f}% ({trust})"
                     f"{f', push {100 * push:.1f}%' if push >= 0.0005 else ''}, against {100 * even:.1f}% "
                     f"break-even at {odds:+d}: {edge:+.1f} points, {ev:+.3f}u per unit."),
            'cutoff': cutoff(market, side, line, odds)}


def cutoff(market, side, line, odds):
    """The worst number and price, written from the entry rules."""
    worst = worse_price(odds)
    if market == 'spread':
        # Our number only gets worse downward: -2.5 to -3, or +3.5 to +3.
        below = max((k for k in KEYS if k < line), default=None)
        where = ('on any move against it' if line in KEYS else
                 f'if the line reaches {signed(below)}' if below is not None else 'on no key number')
        return (f'{side.upper()} {signed(line)} at {odds:+d} or better. Closed to new entries {where}, '
                f'or at {worst:+d} or worse at {signed(line)}.')
    step = RULES['total'] if market == 'total' else RULES['prop']
    limit = line + step if side == 'over' else line - step
    return (f'{side.upper()} {fmt(line)} at {odds:+d} or better. Closed to new entries at '
            f'{fmt(limit)}{"+" if side == "over" else " or lower"}, or at {worst:+d} or worse at {fmt(line)}.')


def market_of(pick):
    key = pick.get('market')
    if key in WORDS:
        return key
    text = f"{pick.get('market') or ''} {pick.get('title') or ''}".lower()
    return next((k for phrase, k in TITLE_MARKETS if phrase in text), None)
