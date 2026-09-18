"""Player volume projections. Deterministic, stdlib only.

For each team in a game, from games before the cutoff:

  plays      average of the offense's recent plays and what the defense allows
  pass rate  the offense's recent dropback rate, moved by the forecast margin
             (favorites run more; the slope is fit on past games against the
             closing spread)
  volume     dropbacks, rushes, targets, pass attempts and sacks from those

Each player's share of targets, carries and pass attempts comes from recent
games the player played for that team, with NFL snap counts marking who was on the
field. A pseudo-game at zero share keeps one big game from setting a role.
Catch rate and yards per target, carry and attempt are shrunk toward position
averages learned from the same games. Players listed out are removed live and
their share is spread over the rest. Ranges come from walk-forward residuals.

Usage: python scripts/projections.py backtest NFL 2025
"""
import argparse
import bisect
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features
import model_v2

VERSION = 'v2.0'
WINDOW = 8               # team games that define current roles
TEAM_HALF_LIFE = 4.0     # games
PLAYER_HALF_LIFE = 3.0   # games
PSEUDO_GAMES = 0.5       # zero-share pseudo-games added to every role
EFFICIENCY_GAMES = 24    # player games used for efficiency
SHRINK = {'catchRate': 20, 'yardsPerTarget': 40, 'yardsPerCarry': 50, 'completionRate': 100, 'yardsPerAttempt': 150}
OUT = {'out', 'injured reserve', 'doubtful', 'suspension', 'physically unable to perform', 'reserve-ret'}
STATS = ('targets', 'receptions', 'recYds', 'carries', 'rushYds', 'att', 'cmp', 'passYds')
Z80 = model_v2.Z80
# Residual spread by stat, sd = a + b * projection, fit on 2024 walk-forward
# residuals with availability known (`python scripts/projections.py calibrate
# NFL 2024 --known-out`) and checked on 2025.
SPREAD = {
    'NFL': {'targets': (1.09, 0.297), 'receptions': (0.94, 0.332), 'recYds': (10.78, 0.433),
            'carries': (1.55, 0.308), 'rushYds': (9.71, 0.416), 'att': (9.17, 0.0), 'cmp': (6.19, 0.0),
            'passYds': (78.5, 0.0)},
    'CFB': {'targets': (0.61, 0.489), 'receptions': (0.69, 0.43), 'recYds': (9.96, 0.52),
            'carries': (0.0, 0.726), 'rushYds': (0.59, 0.83), 'att': (0.0, 0.56), 'cmp': (0.0, 0.581),
            'passYds': (0.0, 0.596)},
}


def weights(count, half_life):
    """Newest-first recency weights for `count` games."""
    return [0.5 ** (i / half_life) for i in range(count)]


def average(pairs):
    """Weighted mean of (value, weight) pairs, skipping missing values."""
    pairs = [(v, w) for v, w in pairs if v is not None]
    total = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / total if total else None


class History:
    """Stored games indexed by team and athlete, for any cutoff."""

    def __init__(self, records, snaps=None):
        self.records = records
        self.kickoffs = [features.when(g['kickoff']) for g in records]
        self.by_team = defaultdict(list)
        self.by_player = defaultdict(list)  # athlete -> [(record position, stat line)], oldest first
        for position, game in enumerate(records):
            for side in ('home', 'away'):
                self.by_team[game[side]['id']].append(position)
            for player in game['players']:
                self.by_player[player['id']].append((position, player))
        self.snaps = snaps or {}

    def before(self, cutoff):
        return bisect.bisect_left(self.kickoffs, cutoff)

    def team_games(self, team, cutoff, count):
        positions = self.by_team.get(team, [])
        end = bisect.bisect_left(positions, self.before(cutoff))
        return [self.records[p] for p in reversed(positions[max(0, end - count):end])]  # newest first

    def player_lines(self, pid, cutoff):
        """(record, line) pairs for an athlete before the cutoff, newest first."""
        entries = self.by_player.get(pid, [])
        end = bisect.bisect_left(entries, (self.before(cutoff),), key=lambda e: (e[0],))
        return [(self.records[p], line) for p, line in reversed(entries[:end])]


def team_line(game, team, league):
    """Volume a team produced in one game, in box-score terms for its league."""
    stats = game['teams'].get(team, {})
    pbp = stats.get('pbp') or {}
    players = [p for p in game['players'] if p.get('team') == team]
    has_plays = game['quality'].get('plays') == 'ok'
    unified = [features.unified(p, league, has_plays) for p in players]
    sacks = stats.get('sacked') if league == 'NFL' else (sum(p.get('pbpSacked', 0) for p in players) if has_plays else None)
    counted = bool(pbp.get('plays'))  # zero counts are not stored; an option team can throw no passes
    return {'plays': pbp.get('plays'), 'dropbacks': pbp.get('dropbacks', 0) if counted else None,
            'rushes': pbp.get('rushes', 0) if counted else None,
            'targets': sum(u.get('targets', 0) for u in unified) if any('targets' in u for u in unified) else None,
            'carries': stats.get('rushAtt'), 'att': stats.get('att'), 'sacks': sacks}


def opponent(game, team):
    return game['away']['id'] if game['home']['id'] == team else game['home']['id']


def pass_slope(history, cutoff, league):
    """Change in dropback rate per point of expected margin, from past closes."""
    xs, ys, rates = [], [], defaultdict(list)
    for game in history.records[:history.before(cutoff)]:
        close = (game.get('market') or {}).get('close') or {}
        for side in ('home', 'away'):
            line = team_line(game, game[side]['id'], league)
            if line['plays'] and line['dropbacks'] is not None:
                rates[game[side]['id']].append(line['dropbacks'] / line['plays'])
                if close.get('spread') is not None:
                    expected = -close['spread'] if side == 'home' else close['spread']
                    xs.append((game[side]['id'], expected, line['dropbacks'] / line['plays']))
    for team, expected, rate in xs:
        ys.append((expected, rate - statistics.mean(rates[team])))
    denominator = sum(x * x for x, _ in ys)
    return sum(x * y for x, y in ys) / denominator if denominator else 0.0


def priors(history, cutoff, league):
    """League efficiency by position group from games before the cutoff."""
    sums = defaultdict(lambda: defaultdict(float))
    fallback = features.usual_positions(history.records[:history.before(cutoff)])
    for game in history.records[:history.before(cutoff)]:
        has_plays = game['quality'].get('plays') == 'ok'
        for player in game['players']:
            group = features.GROUP.get(features.position(player, fallback)[0])
            if not group:
                continue
            line = {**player, **features.unified(player, league, has_plays)}
            bucket = sums[group]
            for key in ('targets', 'rec', 'recYds', 'car', 'rushYds', 'att', 'cmp', 'passYds'):
                bucket[key] += line.get(key, 0) or 0
    out = {}
    for group, s in sums.items():
        out[group] = {'catchRate': s['rec'] / s['targets'] if s['targets'] else 0.6,
                      'yardsPerTarget': s['recYds'] / s['targets'] if s['targets'] else 7.0,
                      'yardsPerCarry': s['rushYds'] / s['car'] if s['car'] else 4.0,
                      'completionRate': s['cmp'] / s['att'] if s['att'] else 0.6,
                      'yardsPerAttempt': s['passYds'] / s['att'] if s['att'] else 6.5}
    return out


def played(game, player_id, snaps):
    """Did this athlete take part? NFL snap counts decide when the game has them."""
    line = snaps.get(game['eventId'])
    if line is not None:
        return player_id in line
    return any(p['id'] == player_id for p in game['players'])


def spread(league, stat, mean):
    a, b = SPREAD[league][stat]
    sd = a + b * mean
    return {'mean': round(mean, 1), 'low': round(max(0.0, mean - Z80 * sd), 1), 'high': round(mean + Z80 * sd, 1)}


def project_team(history, league, team, rival, cutoff, season, margin, slope, league_priors, unavailable=()):
    """Team volume and player projections for one side of one game."""
    games = history.team_games(team, cutoff, WINDOW)
    # Recent games across seasons: early in a season one game must not set a role.
    if not games:
        return None
    this_season = any(g['season'] == season for g in games)
    team_weights = weights(len(games), TEAM_HALF_LIFE)
    lines = [team_line(g, team, league) for g in games]
    allowed_games = history.team_games(rival, cutoff, WINDOW)
    allowed = [team_line(g, opponent(g, rival), league) for g in allowed_games]
    own_plays = average((l['plays'], w) for l, w in zip(lines, team_weights))
    allowed_plays = average((l['plays'], w) for l, w in zip(allowed, weights(len(allowed), TEAM_HALF_LIFE)))
    plays = own_plays if allowed_plays is None else 0.5 * (own_plays + allowed_plays) if own_plays else allowed_plays
    base_rate = average((l['dropbacks'] / l['plays'] if l['plays'] else None, w) for l, w in zip(lines, team_weights))
    if not plays or base_rate is None:
        return None
    rate = min(0.8, max(0.3, base_rate + slope * margin))
    dropbacks = plays * rate
    per = {key: average(((l[key] / l['dropbacks']) if l[key] is not None and l['dropbacks'] else None, w)
                        for l, w in zip(lines, team_weights)) for key in ('targets', 'att', 'sacks')}
    carries_per_rush = average(((l['carries'] / l['rushes']) if l['carries'] is not None and l['rushes'] else None, w)
                               for l, w in zip(lines, team_weights))
    volume = {'plays': plays, 'passRate': rate, 'dropbacks': dropbacks, 'rushes': plays - dropbacks,
              'targets': dropbacks * (per['targets'] or 0.0), 'att': dropbacks * (per['att'] or 0.0),
              'carries': (plays - dropbacks) * (carries_per_rush or 1.0)}
    roster = candidates(history, league, team, games, cutoff)
    shares, raw = {}, defaultdict(float)
    for pid, info in roster.items():
        share = {}
        for stat, team_key in (('targets', 'targets'), ('car', 'carries'), ('att', 'att')):
            numerator = denominator = 0.0
            # Quarterbacks change between seasons more than anyone: once this
            # season has a game, passing shares come from this season alone.
            usable = [(g, w, l) for g, w, l in zip(games, team_weights, lines)
                      if stat != 'att' or g['season'] == season or not this_season]
            for game, w, line in usable:
                if line[team_key] is None or not played(game, pid, history.snaps):
                    continue
                own = next((p for p in game['players'] if p['id'] == pid), {})
                value = features.unified(own, league, game['quality'].get('plays') == 'ok').get('targets', 0) \
                    if stat == 'targets' else own.get(stat, 0)
                numerator += w * (value or 0)
                denominator += w * line[team_key]
            typical = average((l[team_key], w) for _, w, l in usable) or 0.0
            share[stat] = numerator / (denominator + PSEUDO_GAMES * typical) if denominator else 0.0
            raw[stat] += numerator / denominator if denominator else 0.0
        shares[pid] = share
    # The pseudo-game moves share from thin samples to established roles; it
    # must not shrink the team's covered volume, so totals return to the raw sum.
    for stat in ('targets', 'car', 'att'):
        shrunk = sum(s[stat] for s in shares.values())
        if shrunk:
            for s in shares.values():
                s[stat] *= min(raw[stat], 1.0) / shrunk
    # Players ruled out give their share to everyone else in proportion; a
    # team's shares never add up to more than all of its volume.
    active = {pid: s for pid, s in shares.items() if pid not in unavailable}
    for stat in ('targets', 'car', 'att'):
        before = sum(s[stat] for s in shares.values())
        after = sum(s[stat] for s in active.values())
        scale = before / after if after else 0.0
        if after and sum(s[stat] * scale for s in active.values()) > 1:
            scale = 1.0 / after
        for s in active.values():
            s[stat] *= scale
    players = []
    for pid, share in shares.items():
        if pid in unavailable:
            continue
        info = roster[pid]
        prior = league_priors.get(features.GROUP.get(info['pos']), {})
        eff = efficiency(history, pid, cutoff, league, prior)
        projection = {'id': pid, 'name': info['name'], 'pos': info['pos'],
                      'share': {k: round(v, 3) for k, v in share.items() if v}}
        targets = share['targets'] * volume['targets']
        carries = share['car'] * volume['carries']
        attempts = share['att'] * volume['att']
        if targets >= 0.5:
            projection['targets'] = spread(league, 'targets', targets)
            projection['receptions'] = spread(league, 'receptions', targets * eff['catchRate'])
            projection['recYds'] = spread(league, 'recYds', targets * eff['yardsPerTarget'])
        if carries >= 0.5:
            projection['carries'] = spread(league, 'carries', carries)
            projection['rushYds'] = spread(league, 'rushYds', carries * eff['yardsPerCarry'])
        if attempts >= 5:
            projection['att'] = spread(league, 'att', attempts)
            projection['cmp'] = spread(league, 'cmp', attempts * eff['completionRate'])
            projection['passYds'] = spread(league, 'passYds', attempts * eff['yardsPerAttempt'])
        if len(projection) > 4:
            players.append(projection)
    players.sort(key=lambda p: -(p.get('targets', {}).get('mean', 0) + p.get('carries', {}).get('mean', 0)
                                 + p.get('att', {}).get('mean', 0)))
    return {'volume': {k: round(v, 3 if k == 'passRate' else 1) for k, v in volume.items()},
            'games': len(games), 'players': players}


def candidates(history, league, team, games, cutoff):
    """Players whose latest stored game before the cutoff was for this team, within its recent games."""
    seen = {}
    for game in games:  # newest first
        for player in game['players']:
            if player.get('team') == team and player['id'] not in seen and player.get('name'):
                seen[player['id']] = {'name': player['name'], 'pos': player.get('pos')}
    fallback = features.usual_positions(games)
    out = {}
    for pid, info in seen.items():
        latest = history.player_lines(pid, cutoff)
        if not latest or latest[0][1].get('team') != team:
            continue
        pos = info['pos'] or fallback.get(pid)
        if features.GROUP.get(pos):
            out[pid] = {'name': info['name'], 'pos': pos}
    return out


def efficiency(history, pid, cutoff, league, prior):
    """Player rates shrunk toward the position group's league rates."""
    totals = defaultdict(float)
    for game, line in history.player_lines(pid, cutoff)[:EFFICIENCY_GAMES]:
        values = {**line, **features.unified(line, league, game['quality'].get('plays') == 'ok')}
        for key in ('targets', 'rec', 'recYds', 'car', 'rushYds', 'att', 'cmp', 'passYds'):
            totals[key] += values.get(key, 0) or 0

    def shrunk(numerator, denominator, name, default):
        k, base = SHRINK[name], prior.get(name, default)
        return (totals[numerator] + base * k) / (totals[denominator] + k)

    return {'catchRate': shrunk('rec', 'targets', 'catchRate', 0.6),
            'yardsPerTarget': shrunk('recYds', 'targets', 'yardsPerTarget', 7.0),
            'yardsPerCarry': shrunk('rushYds', 'car', 'yardsPerCarry', 4.0),
            'completionRate': shrunk('cmp', 'att', 'completionRate', 0.6),
            'yardsPerAttempt': shrunk('passYds', 'att', 'yardsPerAttempt', 6.5)}


def load_snaps():
    """eventId -> set of ESPN athlete IDs with offensive snaps (NFL only)."""
    out = {}
    for path in sorted((boxscores.ROOT / 'data' / 'nflverse').glob('nfl-*.jsonl')):
        for event, line in boxscores.latest(boxscores.read_store(path)).items():
            out[event] = {p['id'] for p in line['players'] if p.get('id')}
    return out


# ------------------------------------------------------------------ backtest

def actual(game, pid, league):
    line = next((p for p in game['players'] if p['id'] == pid), None)
    if not line:
        return None
    values = {**line, **features.unified(line, league, game['quality'].get('plays') == 'ok')}
    return {'targets': values.get('targets'), 'receptions': values.get('rec', 0), 'recYds': values.get('recYds', 0),
            'carries': values.get('car', 0), 'rushYds': values.get('rushYds', 0), 'att': values.get('att', 0),
            'cmp': values.get('cmp', 0), 'passYds': values.get('passYds', 0)}


def backtest(league, season, from_week=2, known_out=False):
    """Walk-forward projections for players who then played; with a last-5 baseline.

    known_out=True treats everyone who then did not play as ruled out before the
    game, a stand-in for the injury report the live projections read. Results are
    reported both ways.
    """
    records = features.load(leagues=(league,))
    history = History(records, load_snaps() if league == 'NFL' else None)
    rows, cache = [], {}
    for game in records:
        if game['season'] != season or (game['seasonType'] == 2 and (game['week'] or 0) < from_week):
            continue
        cutoff = model_v2.week_start(features.when(game['kickoff']))
        if cutoff not in cache:
            cache.clear()
            cache[cutoff] = (model_v2.Model(league, records, cutoff, season), pass_slope(history, cutoff, league),
                             priors(history, cutoff, league))
        model, slope, league_priors = cache[cutoff]
        forecast = model.predict(game['home']['id'], game['away']['id'], game['neutral'])
        for side, rival, margin in (('home', 'away', forecast['margin']), ('away', 'home', -forecast['margin'])):
            team = game[side]['id']
            out = set()
            if known_out:
                recent = [g for g in history.team_games(team, cutoff, WINDOW) if g['season'] == season]                     or history.team_games(team, cutoff, WINDOW // 2)
                out = {pid for pid in candidates(history, league, team, recent, cutoff)
                       if not played(game, pid, history.snaps)}
            projected = project_team(history, league, team, game[rival]['id'], cutoff, season, margin, slope,
                                     league_priors, out)
            if not projected:
                continue
            for player in projected['players']:
                truth = actual(game, player['id'], league)
                if truth is None:
                    continue
                recent = [actual(g, player['id'], league) for g in history.team_games(team, cutoff, 5)]
                recent = [r for r in recent if r]
                for stat in STATS:
                    if stat in player and truth.get(stat) is not None:
                        base = statistics.mean(r[stat] or 0 for r in recent) if recent else None
                        rows.append({'stat': stat, 'pos': player['pos'], 'projection': player[stat]['mean'],
                                     'low': player[stat]['low'], 'high': player[stat]['high'],
                                     'actual': truth[stat], 'baseline': base})
    return rows


def summarize(rows):
    out = {}
    for stat in STATS:
        sample = [r for r in rows if r['stat'] == stat]
        paired = [r for r in sample if r['baseline'] is not None]
        if not sample:
            continue
        out[stat] = {'n': len(sample),
                     'miss': round(statistics.mean(abs(r['projection'] - r['actual']) for r in sample), 2),
                     'bias': round(statistics.mean(r['projection'] - r['actual'] for r in sample), 2),
                     'within80': round(statistics.mean(r['low'] <= r['actual'] <= r['high'] for r in sample), 3),
                     'missVsLast5': [round(statistics.mean(abs(r['projection'] - r['actual']) for r in paired), 2),
                                     round(statistics.mean(abs(r['baseline'] - r['actual']) for r in paired), 2)]
                     if paired else None}
    return out


def calibrate(rows):
    """Fit sd = a + b * projection per stat from absolute residuals (normal: sd = 1.2533 * E|e|)."""
    out = {}
    for stat in STATS:
        sample = [(r['projection'], abs(r['projection'] - r['actual']) * 1.2533) for r in rows if r['stat'] == stat]
        if len(sample) < 30:
            continue
        mean_x = statistics.mean(x for x, _ in sample)
        mean_y = statistics.mean(y for _, y in sample)
        var = sum((x - mean_x) ** 2 for x, _ in sample)
        b = sum((x - mean_x) * (y - mean_y) for x, y in sample) / var if var else 0.0
        # Both terms stay non-negative so no projection gets a negative or
        # shrinking spread: a negative slope becomes a constant spread, and a
        # negative intercept becomes a fit through zero.
        b = max(b, 0.0)
        a = mean_y - b * mean_x
        if a < 0:
            a, b = 0.0, sum(x * y for x, y in sample) / sum(x * x for x, _ in sample)
        out[stat] = (round(a, 2), round(b, 3))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('command', choices=('backtest', 'calibrate'))
    parser.add_argument('league')
    parser.add_argument('season', type=int)
    parser.add_argument('--known-out', action='store_true', help='treat players who did not play as ruled out')
    args = parser.parse_args(argv)
    rows = backtest(args.league.upper(), args.season, known_out=args.known_out)
    print(json.dumps(summarize(rows) if args.command == 'backtest' else calibrate(rows), indent=1))


if __name__ == '__main__':
    main()
