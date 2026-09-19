"""Model v2: team scores from the box-score store. Deterministic, stdlib only.

Each forecast refits two sets of team ratings from games that kicked off before
its cutoff, as recency-weighted ridge regressions of points scored on offense,
defense and home field:

  margin ratings  fit to points actually scored
  total ratings   fit to a blend of points and efficiency-implied points
                  (success rate, explosive plays, pace, turnovers, red-zone
                  drives), which carries less scoring luck

The margin can also blend in v1's Elo margin (the same code, replayed over the
stored games); tuning sets that weight per league and leaves it at zero where
it did not help. College FCS opponents share a group rating, so a lightly
observed FCS team is not treated as an average FBS team.

Games age in football days: the offseason is skipped and last season carries
over through priorWeight. Uncertainty comes from walk-forward residuals: every
forecast carries a margin and total standard deviation, 80% ranges and a home
win probability. No market, injury or weather input; the market is only the
yardstick.

Usage:
  python scripts/model_v2.py backtest NFL 2025      walk-forward results vs the close
  python scripts/model_v2.py tune CFB --out FILE    grid search on 2024, holdout 2025
"""
import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features
from refresh import Model as Elo

VERSION = 'v2.0'
# Chosen by `tune` on the full 2024 season (with 2023 as its prior) and checked
# once on the untouched 2025 season; see data/model/v2-tuning-*.json.
# Standard deviations are the 2024 walk-forward residuals.
PARAMS = {
    'NFL': {'margin': {'halfLife': 180, 'ridge': 10.0, 'priorWeight': 0.6, 'eloWeight': 0.5},
            'total': {'halfLife': 45, 'ridge': 3.0, 'priorWeight': 0.3, 'blend': 0.3},
            'sdMargin': 13.21, 'sdTotal': 12.79, 'pace': 65.0},
    'CFB': {'margin': {'halfLife': 90, 'ridge': 1.0, 'priorWeight': 0.3, 'eloWeight': 0.0},
            'total': {'halfLife': 90, 'ridge': 10.0, 'priorWeight': 0.6, 'blend': 1.0},
            'sdMargin': 16.31, 'sdTotal': 16.18, 'pace': 70.0},
}
# Parameters are fixed per version, so a snapshot names its version instead of
# copying them. Changing PARAMS without releasing a new VERSION fails the tests.
RELEASED = {'v2.0': 'bb945057fd1d'}
FBS_MIN_GAMES = 6  # a college team with this many stored games in a season is FBS
Z80 = 1.2815515655446004


# ------------------------------------------------------------------ inputs

def params_hash(params=None):
    return hashlib.sha256(json.dumps(params or PARAMS, sort_keys=True).encode()).hexdigest()[:12]


def efficiency(stats, pace):
    """[1, success rate, explosive rate, plays/pace, turnovers, red-zone drives] or None."""
    pbp = stats.get('pbp') or {}
    plays, tries = pbp.get('plays'), pbp.get('successPlays')
    if not plays or not tries or stats.get('turnovers') is None:
        return None
    return [1.0, pbp['successes'] / tries, pbp.get('explosive', 0) / plays, plays / pace,
            float(stats['turnovers']), float(pbp.get('rzDrives', 0))]


def solve(matrix, vector):
    """Gauss-Jordan elimination with partial pivoting for small dense systems."""
    n = len(vector)
    rows = [row[:] + [vector[i]] for i, row in enumerate(matrix)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(rows[r][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        lead = rows[col][col]
        if abs(lead) < 1e-12:
            raise ValueError('Singular system')
        rows[col] = [value / lead for value in rows[col]]
        for r in range(n):
            if r != col and rows[r][col]:
                factor = rows[r][col]
                rows[r] = [a - factor * b for a, b in zip(rows[r], rows[col])]
    return [rows[i][n] for i in range(n)]


def implied_points(rows):
    """Least-squares map from efficiency to points, fit only on the rows given."""
    data = [(r['efficiency'], r['points']) for r in rows if r['efficiency']]
    if len(data) < 50:
        return None
    k = len(data[0][0])
    matrix = [[sum(x[i] * x[j] for x, _ in data) + (1e-6 if i == j else 0.0) for j in range(k)] for i in range(k)]
    return solve(matrix, [sum(x[i] * y for x, y in data) for i in range(k)])


def observations(records, pace):
    """One row per offense per game, oldest first."""
    rows = []
    for game in records:
        for side, other in (('home', 'away'), ('away', 'home')):
            team = game[side]['id']
            rows.append({'kickoff': features.when(game['kickoff']), 'season': game['season'], 'team': team,
                         'opp': game[other]['id'], 'home': side == 'home' and not game['neutral'],
                         'points': game[side]['score'], 'efficiency': efficiency(game['teams'].get(team, {}), pace)})
    return rows


def offseason_days(records, season, cutoff):
    """Days without games between each earlier season and `season`, keyed by season.

    Measured from each season's last game to the next season's first game; the
    current season starts at its first scheduled game or the cutoff, whichever
    is earlier. Schedules are public in advance, so this uses no results.
    """
    first, last = {}, {}
    for game in records:
        moment = features.when(game['kickoff'])
        first[game['season']] = min(first.get(game['season'], moment), moment)
        last[game['season']] = max(last.get(game['season'], moment), moment)
    starts = dict(first)
    starts[season] = min(first.get(season, cutoff), cutoff)
    gaps, total = {}, 0.0
    for year in sorted((y for y in last if y < season), reverse=True):
        following = starts.get(year + 1)
        if following is None:
            break
        total += max((following - last[year]).total_seconds() / 86400, 0.0)
        gaps[year] = total
    return gaps


def fbs_teams(records):
    counts = defaultdict(int)
    for game in records:
        for side in ('home', 'away'):
            counts[(game['season'], game[side]['id'])] += 1
    return {team for (_, team), n in counts.items() if n >= FBS_MIN_GAMES}


# ------------------------------------------------------------------ fitting

def ridge(targets, weights, active, size, penalty, start=None, tolerance=1e-10, limit=None):
    """Weighted ridge regression over 0/1 indicator features.

    Solves (X'WX + P) b = X'Wy by conjugate gradients with a diagonal
    preconditioner, stopping on the true relative residual. Exact in principle
    within `size` steps and robust on sparse schedules such as college
    conferences, where coordinate methods creep. `start` warm-starts a refit;
    parameters no observation touches stay at zero.
    """
    used = [False] * size
    diagonal = list(penalty)
    for columns, w in zip(active, weights):
        for j in columns:
            used[j] = True
            diagonal[j] += w
    diagonal = [d if u and d > 0 else 1.0 for d, u in zip(diagonal, used)]

    def apply(vector):
        out = [p * v if u else v for p, v, u in zip(penalty, vector, used)]
        for columns, w in zip(active, weights):
            s = w * sum(vector[j] for j in columns)
            for j in columns:
                out[j] += s
        return out

    rhs = [0.0] * size
    for columns, y, w in zip(active, targets, weights):
        for j in columns:
            rhs[j] += w * y
    beta = [b if u else 0.0 for b, u in zip(start, used)] if start else [0.0] * size
    residual = [r - a for r, a in zip(rhs, apply(beta))]
    scale = math.sqrt(sum(r * r for r in rhs)) or 1.0
    z = [r / d for r, d in zip(residual, diagonal)]
    direction = list(z)
    rz = sum(r * q for r, q in zip(residual, z))
    for _ in range(limit or 4 * size):
        if math.sqrt(sum(r * r for r in residual)) <= tolerance * scale:
            break
        product = apply(direction)
        step = rz / sum(d * p for d, p in zip(direction, product))
        beta = [b + step * d for b, d in zip(beta, direction)]
        residual = [r - step * p for r, p in zip(residual, product)]
        z = [r / d for r, d in zip(residual, diagonal)]
        updated = sum(r * q for r, q in zip(residual, z))
        direction = [q + (updated / rz) * d for q, d in zip(z, direction)]
        rz = updated
    return beta


class Ratings:
    """Offense/defense ratings for one target. Parameters 0-3 are the base
    points, home field, FCS offense and FCS defense."""

    def __init__(self, beta, index, fcs):
        self.beta, self.index, self.fcs = beta, index, fcs

    def points(self, team, opponent, home):
        b, i = self.beta, self.index
        value = b[0] + (b[1] if home else 0.0)
        value += b[i['off', team]] if ('off', team) in i else 0.0
        value += b[i['def', opponent]] if ('def', opponent) in i else 0.0
        return value + (b[2] if self.fcs(team) else 0.0) + (b[3] if self.fcs(opponent) else 0.0)

    def team(self, team):
        return {side: round(self.beta[self.index[side, team]], 2) if (side, team) in self.index else 0.0
                for side in ('off', 'def')}

    def start_for(self, index):
        start = self.beta[:4] + [0.0] * len(index)
        for key, position in index.items():
            if key in self.index:
                start[position] = self.beta[self.index[key]]
        return start


def fit(rows, cutoff, season, params, fcs, target, warm=None, offseason=None):
    """Ratings from observation rows, all before the cutoff. target(row) is the response.

    Age is counted in football days: the offseason between a game's season and
    the cutoff's season is skipped, so carryover from last season is set by
    priorWeight rather than by how long the summer was.
    """
    index = {}
    for row in rows:
        for key in (('off', row['team']), ('def', row['opp'])):
            if key not in index:
                index[key] = 4 + len(index)
    penalty = [0.0] * 4 + [params['ridge']] * len(index)
    targets, weights, active = [], [], []
    for row in rows:
        age = (cutoff - row['kickoff']).total_seconds() / 86400 - (offseason or {}).get(row['season'], 0.0)
        weight = 0.5 ** (max(age, 0.0) / params['halfLife']) * params['priorWeight'] ** (season - row['season'])
        columns = [0, index['off', row['team']], index['def', row['opp']]]
        if row['home']:
            columns.append(1)
        if fcs(row['team']):
            columns.append(2)
        if fcs(row['opp']):
            columns.append(3)
        targets.append(target(row))
        weights.append(weight)
        active.append(columns)
    start = warm.start_for(index) if warm else None
    return Ratings(ridge(targets, weights, active, 4 + len(index), penalty, start), index, fcs)


def elo_as_of(league, past, season):
    """v1's Elo (refresh.Model, unchanged) replayed over earlier games, regressed into `season`."""
    elo = Elo(league)
    for game in past:
        elo.train({'season': game['season'], 'neutral': game['neutral'],
                   'home': {'id': game['home']['id'], 'score': game['home']['score']},
                   'away': {'id': game['away']['id'], 'score': game['away']['score']}})
    elo.advance(season)
    return elo


class Model:
    """Both rating sets as of one cutoff, from games that kicked off before it."""

    def __init__(self, league, records, cutoff, season, params=None, warm=None, targets=('margin', 'total')):
        self.league, self.cutoff, self.season = league, cutoff, season
        self.params = params or PARAMS[league]
        past = [g for g in records if features.when(g['kickoff']) < cutoff]
        self.games, self.through = len(past), past[-1]['kickoff'] if past else None
        self.inputs = hashlib.sha256(json.dumps([(g['eventId'], g['hash']) for g in past]).encode()).hexdigest()[:16]
        rows = observations(past, self.params['pace'])
        self.counts = defaultdict(int)
        for row in rows:
            self.counts[row['team']] += row['season'] == season
        self.offseason = offseason_days(records, season, cutoff)
        fbs = fbs_teams(past) if league == 'CFB' else None
        self.fcs = (lambda team: team not in fbs) if fbs is not None else (lambda team: False)
        self.implied = implied_points(rows)
        blend = self.params['total']['blend'] if self.implied else 1.0

        def total_target(row):
            if not row['efficiency'] or not self.implied:
                return row['points']
            return blend * row['points'] + (1 - blend) * sum(a * b for a, b in zip(self.implied, row['efficiency']))

        self.margin = self.total = None
        if 'margin' in targets:
            self.margin = fit(rows, cutoff, season, self.params['margin'], self.fcs, lambda row: row['points'],
                              warm.margin if warm else None, self.offseason)
        if 'total' in targets:
            self.total = fit(rows, cutoff, season, self.params['total'], self.fcs, total_target,
                             warm.total if warm else None, self.offseason)
        self.elo = elo_as_of(league, past, season) if self.params['margin'].get('eloWeight') else None

    def elo_margin(self, home, away, neutral):
        ratings = self.elo.ratings
        margin = ratings.get(home, 0.0) - ratings.get(away, 0.0) + (0.0 if neutral else self.elo.home)
        return max(-42.0, min(42.0, margin))

    def predict(self, home, away, neutral=False):
        at_home, p = not neutral, self.params
        margin = total = 0.0
        if self.margin:
            margin = self.margin.points(home, away, at_home) - self.margin.points(away, home, False)
            weight = p['margin'].get('eloWeight', 0.0)
            if weight:
                margin = (1 - weight) * margin + weight * self.elo_margin(home, away, neutral)
        if self.total:
            total = self.total.points(home, away, at_home) + self.total.points(away, home, False)
        return {'margin': margin, 'total': total, 'home': (total + margin) / 2, 'away': (total - margin) / 2,
                'sdMargin': p['sdMargin'], 'sdTotal': p['sdTotal'],
                'homeWinProb': 0.5 * (1 + math.erf(margin / (p['sdMargin'] * math.sqrt(2)))),
                'sparse': min(self.counts.get(home, 0), self.counts.get(away, 0)) < 3}


# ------------------------------------------------------------------ backtest

def week_start(moment):
    """Walk-forward refit point: the Tuesday 08:00 UTC at or before a kickoff."""
    base = moment.replace(hour=8, minute=0, second=0, microsecond=0)
    start = base - timedelta(days=(base.weekday() - 1) % 7)
    return start if start <= moment else start - timedelta(days=7)


def backtest(league, season, params=None, records=None, from_week=None, targets=('margin', 'total')):
    """Walk-forward forecasts for a season, each from games before its week's refit."""
    records = records if records is not None else features.load(leagues=(league,))
    games = [g for g in records if g['season'] == season
             and (from_week is None or g['seasonType'] == 3 or (g['week'] or 0) >= from_week)]
    out, model, current = [], None, None
    for game in games:
        refit = week_start(features.when(game['kickoff']))
        if refit != current:
            model, current = Model(league, records, refit, season, params, warm=model, targets=targets), refit
        forecast = model.predict(game['home']['id'], game['away']['id'], game['neutral'])
        close = (game.get('market') or {}).get('close') or {}
        out.append({'eventId': game['eventId'], 'week': game['week'], 'seasonType': game['seasonType'],
                    'kickoff': game['kickoff'], 'margin': game['home']['score'] - game['away']['score'],
                    'total': game['home']['score'] + game['away']['score'], 'forecast': forecast,
                    'closeMargin': -close['spread'] if close.get('spread') is not None else None,
                    'closeTotal': close.get('total')})
    return out


def score(rows):
    """Average misses against the result, and records against the close."""
    def mean(values):
        values = list(values)
        return round(statistics.mean(values), 2) if values else None

    priced = [r for r in rows if r['closeMargin'] is not None and r['closeTotal'] is not None]
    side = [(r['forecast']['margin'] > r['closeMargin']) == (r['margin'] > r['closeMargin']) for r in priced
            if r['forecast']['margin'] != r['closeMargin'] and r['margin'] != r['closeMargin']]
    total = [(r['forecast']['total'] > r['closeTotal']) == (r['total'] > r['closeTotal']) for r in priced
             if r['forecast']['total'] != r['closeTotal'] and r['total'] != r['closeTotal']]
    margin_errors = [r['forecast']['margin'] - r['margin'] for r in rows]
    total_errors = [r['forecast']['total'] - r['total'] for r in rows]
    return {'games': len(rows), 'priced': len(priced),
            'marginMiss': mean(abs(r['forecast']['margin'] - r['margin']) for r in priced),
            'closeMarginMiss': mean(abs(r['closeMargin'] - r['margin']) for r in priced),
            'totalMiss': mean(abs(r['forecast']['total'] - r['total']) for r in priced),
            'closeTotalMiss': mean(abs(r['closeTotal'] - r['total']) for r in priced),
            'sideVsClose': [sum(side), len(side) - sum(side)], 'totalVsClose': [sum(total), len(total) - sum(total)],
            'within80': {'margin': mean(abs(e) <= Z80 * r['forecast']['sdMargin'] for e, r in zip(margin_errors, rows)),
                         'total': mean(abs(e) <= Z80 * r['forecast']['sdTotal'] for e, r in zip(total_errors, rows))},
            'residualSd': {'margin': round(statistics.pstdev(margin_errors), 2),
                           'total': round(statistics.pstdev(total_errors), 2)} if len(rows) > 1 else None}


GRID = {'halfLife': (45, 90, 180), 'ridge': (1.0, 3.0, 10.0), 'priorWeight': (0.3, 0.6, 1.0),
        'eloWeight': (0.0, 0.3, 0.5), 'blend': (0.3, 0.6, 1.0)}


def tune(league, tune_season=2024, holdout=2025, log=print):
    """Grid search the margin, then the total, on one full season; score the holdout once.

    The tuning season has a stored prior season, so its early weeks count too.
    Ties go to the simpler setting (no Elo, pure points).
    """
    records = features.load(leagues=(league,))
    defaults = {'halfLife': 90, 'ridge': 3.0, 'priorWeight': 0.6}
    trials, chosen = {'margin': [], 'total': []}, {}
    for target, knob in (('margin', 'eloWeight'), ('total', 'blend')):
        for half_life in GRID['halfLife']:
            for penalty in GRID['ridge']:
                for prior in GRID['priorWeight']:
                    for value in GRID[knob]:
                        candidate = {'halfLife': half_life, 'ridge': penalty, 'priorWeight': prior, knob: value}
                        params = {**PARAMS[league], 'margin': chosen.get('margin', {**defaults, 'eloWeight': 0.0}),
                                  'total': {**defaults, 'blend': 1.0}, target: candidate}
                        miss = score(backtest(league, tune_season, params, records, targets=(target,)))[f'{target}Miss']
                        trials[target].append({'params': candidate, 'miss': miss})
                        log(f'{league} {target} {candidate}: {miss}')
        simplest = (lambda t: t['params']['eloWeight']) if target == 'margin' else (lambda t: -t['params']['blend'])
        chosen[target] = min(trials[target], key=lambda t: (t['miss'], simplest(t)))['params']
    final = {**PARAMS[league], 'margin': chosen['margin'], 'total': chosen['total']}
    tuned = score(backtest(league, tune_season, final, records))
    final['sdMargin'], final['sdTotal'] = tuned['residualSd']['margin'], tuned['residualSd']['total']
    return {'league': league, 'version': VERSION, 'tuneSeason': tune_season, 'holdoutSeason': holdout,
            'chosen': final, 'tuning': tuned, 'holdout': score(backtest(league, holdout, final, records)),
            'trials': trials}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('backtest')
    run.add_argument('league')
    run.add_argument('season', type=int)
    run.add_argument('--from-week', type=int)
    grid = sub.add_parser('tune')
    grid.add_argument('league')
    grid.add_argument('--out')
    args = parser.parse_args(argv)
    if args.command == 'backtest':
        print(json.dumps(score(backtest(args.league.upper(), args.season, from_week=args.from_week)), indent=1))
        return
    result = tune(args.league.upper(), log=lambda *_: None)
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'trials'}, indent=1))


if __name__ == '__main__':
    main()
