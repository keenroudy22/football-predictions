"""Publish model v2 forecasts for upcoming games. Deterministic, stdlib only.

Every run refits the team model and player projections from all stored games
that have finished, then writes a snapshot for each game in site/data/slate.json
that kicks off in the next eight days and more than an hour from now. A game
gets a new snapshot only on a material change (margin or total by half a point,
the injury list, or a player's volume by a tenth), so the history shows every
forecast that was public and when without near-duplicates. Snapshots append to
data/forecasts/<league>-<season>.jsonl and are never edited; the scoreboard
grades the last one published before kickoff.

Inputs stored with every snapshot: the games it was fit on (count, last kickoff
and a hash of their event IDs and contents), the model version (its fixed
parameters live in scripts/model_v2.py), both teams' ratings and which players
the injury report removed. Nothing here reads a market price.

Usage: python scripts/forecast.py
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features
import model_v2
import projections
from sports_refresh import eastern_date

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'forecasts'
HORIZON = timedelta(days=8)
BUFFER = timedelta(minutes=60)       # no new forecast inside an hour of kickoff
INJURY_FRESH = timedelta(days=21)    # older injury entries are ignored
RULED_OUT = {'out', 'injured reserve', 'doubtful', 'suspension'}
MATERIAL = {'points': 0.5, 'share': 0.10, 'floor': 0.5}  # what counts as a changed forecast
PLAYERS_PER_TEAM = {'NFL': 14, 'CFB': 8}


def injuries(context, league, now):
    """team ID -> {athlete ID: status} for recent Out/IR/Doubtful entries."""
    teams = ((context or {}).get('leagues', {}).get(league) or {}).get('teams') or {}
    out = {}
    for team, data in teams.items():
        ruled = {}
        for player in data.get('players', []):
            reported = player.get('reportedAt')
            try:
                fresh = reported and now - features.when(reported) <= INJURY_FRESH
            except ValueError:
                fresh = False
            if fresh and str(player.get('status', '')).lower() in RULED_OUT and player.get('id'):
                ruled[str(player['id'])] = player['status']
        out[str(team)] = ruled
    return out


def compact(side):
    """Player projections as [mean, low, high] triples, top players only."""
    if not side:
        return None
    players = []
    for player in side['players']:
        line = {'id': player['id'], 'pos': player['pos']}
        for stat in projections.STATS:
            if stat in player:
                value = player[stat]
                line[stat] = [value['mean'], value['low'], value['high']]
        players.append(line)
    return {'volume': side['volume'], 'games': side['games'], 'players': players}


def volumes(record):
    """athlete -> (targets, carries, attempts) means, both teams."""
    out = {}
    for side in ('home', 'away'):
        for player in (record['players'].get(side) or {}).get('players', []):
            out[player['id']] = tuple(player.get(stat, [0])[0] for stat in ('targets', 'carries', 'att'))
    return out


def material(record, previous):
    """Would a reader see a different forecast? Rounding noise does not count."""
    if previous is None or previous['model'] != record['model'] or previous.get('kickoff') != record['kickoff']:
        return True
    if abs(record['margin'] - previous['margin']) >= MATERIAL['points'] or \
            abs(record['total'] - previous['total']) >= MATERIAL['points']:
        return True
    if record['inputs']['ruledOut'] != previous['inputs']['ruledOut']:
        return True
    now, before = volumes(record), volumes(previous)
    if now.keys() != before.keys():
        return True
    for pid, values in now.items():
        for new, old in zip(values, before[pid]):
            if abs(new - old) >= max(MATERIAL['floor'], MATERIAL['share'] * max(new, old)):
                return True
    return False


def why(model, forecast, home, away, league):
    """Plain-language inputs, filled in from numbers the code computed."""
    margin_ratings = {side: model.margin.team(team) for side, team in (('home', home), ('away', away))}
    through = eastern_date(model.through).isoformat() if model.through else 'none'
    parts = [f"Ratings from {model.games} stored {league} games through {through} (kickoff date, Eastern).",
             f"Margin ratings (points vs average): home offense {margin_ratings['home']['off']:+.1f}, "
             f"defense {margin_ratings['home']['def']:+.1f}; away offense {margin_ratings['away']['off']:+.1f}, "
             f"defense {margin_ratings['away']['def']:+.1f}."]
    weight = model.params['margin'].get('eloWeight', 0)
    if weight:
        parts.append(f"Margin blends {weight:.0%} of the v1 Elo margin.")
    if forecast['sparse']:
        parts.append('At least one team has fewer than three games this season; treat with extra caution.')
    parts.append('No injury, weather or market input in the score. Injuries only remove ruled-out players from '
                 'player volume.')
    return ' '.join(parts)


def snapshot(league, game, model, history, slope, priors, ruled_out, now):
    home, away = game['home']['id'], game['away']['id']
    forecast = model.predict(home, away, game.get('neutral', False))
    sides = {}
    for side, rival, margin in (('home', away, forecast['margin']), ('away', home, -forecast['margin'])):
        team = game[side]['id']
        unavailable = set(ruled_out.get(team, {}))
        projected = projections.project_team(history, league, team, rival, now, game['season'], margin, slope,
                                             priors, unavailable)
        if projected:
            projected['players'] = projected['players'][:PLAYERS_PER_TEAM[league]]
        sides[side] = compact(projected)
    z = model_v2.Z80
    record = {
        'model': model_v2.VERSION, 'projectionModel': projections.VERSION, 'league': league,
        'gameId': game['id'], 'eventId': game['id'].split('-', 1)[1], 'season': game['season'],
        'seasonType': game.get('seasonType'), 'week': game.get('week'), 'kickoff': game['kickoff'],
        'neutral': bool(game.get('neutral')), 'publishedAt': boxscores.stamp(now),
        'home': {'id': home, 'abbreviation': game['home'].get('abbreviation'), 'points': round(forecast['home'], 1)},
        'away': {'id': away, 'abbreviation': game['away'].get('abbreviation'), 'points': round(forecast['away'], 1)},
        'margin': round(forecast['margin'], 2), 'total': round(forecast['total'], 2),
        'homeWinProb': round(forecast['homeWinProb'], 3),
        'sd': {'margin': forecast['sdMargin'], 'total': forecast['sdTotal']},
        'range80': {'margin': [round(forecast['margin'] - z * forecast['sdMargin'], 1),
                               round(forecast['margin'] + z * forecast['sdMargin'], 1)],
                    'total': [round(forecast['total'] - z * forecast['sdTotal'], 1),
                              round(forecast['total'] + z * forecast['sdTotal'], 1)]},
        'sparse': forecast['sparse'],
        'players': sides,
        'inputs': {'games': model.games, 'through': model.through, 'hash': model.inputs,
                   'ratings': {'home': {'margin': model.margin.team(home), 'total': model.total.team(home)},
                               'away': {'margin': model.margin.team(away), 'total': model.total.team(away)},
                               'homeField': round(model.margin.beta[1], 2)},
                   'passSlope': round(slope, 5),
                   'ruledOut': {side: sorted(ruled_out.get(game[side]['id'], {})) for side in ('home', 'away')},
                   'injuryCoverage': 'ESPN injury report' if league == 'NFL' else 'college injury reports are not covered'},
        'why': why(model, forecast, home, away, league),
    }
    return record


def upcoming(slate, league, now):
    for game in slate.get('games', []):
        if game.get('league') != league or game.get('state') != 'pre' or not game.get('timeValid', True):
            continue
        kickoff = features.when(game['kickoff'])
        if now + BUFFER <= kickoff <= now + HORIZON:
            yield game


def publish(now=None, root=STORE, slate=None, context=None, records=None, snaps=None, log=print):
    now = now or datetime.now(timezone.utc)
    slate = slate if slate is not None else json.loads((ROOT / 'site' / 'data' / 'slate.json').read_text(encoding='utf-8'))
    if context is None:
        path = ROOT / 'site' / 'data' / 'research-context.json'
        context = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    existing = {}
    for path in sorted(root.glob('*.jsonl')):
        for line in boxscores.read_store(path):
            existing[line['gameId']] = line
    written = {}
    for league in ('NFL', 'CFB'):
        games = list(upcoming(slate, league, now))
        if not games:
            continue
        stored = records[league] if records else features.load(leagues=(league,))
        season = games[0]['season']
        model = model_v2.Model(league, stored, now, season)
        history = projections.History(stored, (snaps if snaps is not None else projections.load_snaps())
                                      if league == 'NFL' else None)
        slope = projections.pass_slope(history, now, league)
        priors = projections.priors(history, now, league)
        ruled_out = injuries(context, league, now)
        new = []
        for game in games:
            record = snapshot(league, game, model, history, slope, priors, ruled_out, now)
            previous = existing.get(record['gameId'])
            if not material(record, previous):
                continue
            if previous:
                record['supersedes'] = previous['publishedAt']
            new.append(record)
        for season_key in sorted({r['season'] for r in new}):
            batch = sorted((r for r in new if r['season'] == season_key), key=lambda r: (r['kickoff'], r['gameId']))
            boxscores.append(boxscores.store_path(league, season_key, root), batch)
            written[f'{league.lower()}-{season_key}.jsonl'] = len(batch)
        log(f'{league}: {len(games)} upcoming games, {len(new)} new snapshots')
    return written


def main():
    problems = boxscores.verify(STORE)
    if problems:
        sys.exit('Refusing to append to a forecast store whose recorded lines changed:\n  ' + '\n  '.join(problems))
    STORE.mkdir(parents=True, exist_ok=True)
    written = publish()
    boxscores.write_json(STORE / 'ledger.json', boxscores.ledger(STORE))
    print(f'Published {sum(written.values())} forecast snapshots {written or ""}')


if __name__ == '__main__':
    main()
