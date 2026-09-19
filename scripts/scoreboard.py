"""The scoreboard: every forecast graded against the closing line and the result.

  live      published before kickoff: v1 baseline forecasts, the last v2 snapshot
            before kickoff, and analyst score calls
  backtest  v2 walk-forward and the v1 Elo replayed for past seasons, labeled
            retrospective; recomputed only when the model or the store changes
  props     v2 player projections against the last DraftKings line captured
            before kickoff
  picks     closing-line value on published picks: the line when posted against
            the last comparable line before kickoff

A game is graded when the box-score store has its final and the provider's
closing line. Sides and totals are graded against the close; a forecast equal
to the close takes no side. Missing lines, closes or results leave a row
ungraded; nothing is estimated. Writes site/data/scoreboard.json and
site/data/scoreboard-games.json. No network.

Usage: python scripts/scoreboard.py
"""
import glob
import hashlib
import json
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features
import integrity
import model_v2
import projections

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
BACKTEST = ROOT / 'data' / 'model' / 'backtest-v2.json'
BACKTEST_SEASONS = (2024, 2025)
# Player projection stats and the prop market each is compared with.
PROP_STATS = {'receptions': 'rec', 'recYds': 'recYds', 'carries': 'car', 'rushYds': 'rushYds',
              'att': 'att', 'cmp': 'cmp', 'passYds': 'passYds'}
# Published prop market names and the box-score stat that settles them.
PICK_MARKETS = {'passing yards': 'passYds', 'completions': 'cmp', 'pass completions': 'cmp',
                'passing attempts': 'att', 'pass attempts': 'att', 'passing touchdowns': 'passTD',
                'interceptions': 'int', 'rushing yards': 'rushYds', 'carries': 'car', 'rushing attempts': 'car',
                'receiving yards': 'recYds', 'receptions': 'rec', 'longest reception': 'recLong',
                'longest rush': 'rushLong', 'rushing + receiving yards': 'rushRecYds',
                'rush + rec yards': 'rushRecYds', 'passing + rushing yards': 'passRushYds'}
Z80 = model_v2.Z80


def read(path, fallback):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else fallback


def before(earlier, later):
    """True when the first timestamp is strictly earlier; formats differ across sources."""
    return bool(earlier and later) and features.when(earlier) < features.when(later)


def game_id(record):
    return f"{record['league']}-{record['eventId']}"


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ grading

def against(forecast, line, actual):
    """W/L/P for the side a forecast takes against a line; None when it takes none."""
    if forecast is None or line is None or actual is None or forecast == line:
        return None
    if actual == line:
        return 'P'
    return 'W' if (forecast > line) == (actual > line) else 'L'


def grade(game, margin, total, sd=None, home_prob=None):
    """Grade one forecast (home margin and total) against the close and the result."""
    market = game.get('market') or {}
    close, opening = market.get('close') or {}, market.get('open') or {}
    close_margin = -close['spread'] if close.get('spread') is not None else None
    open_margin = -opening['spread'] if opening.get('spread') is not None else None
    actual_margin = game['home']['score'] - game['away']['score']
    actual_total = game['home']['score'] + game['away']['score']
    row = {'margin': round(margin, 1) if margin is not None else None,
           'total': round(total, 1) if total is not None else None,
           'closeMargin': close_margin, 'closeTotal': close.get('total'),
           'actualMargin': actual_margin, 'actualTotal': actual_total,
           'side': against(margin, close_margin, actual_margin),
           'ou': against(total, close.get('total'), actual_total)}
    for key, value, line, actual in (('Margin', margin, close_margin, actual_margin),
                                     ('Total', total, close.get('total'), actual_total)):
        if value is not None and line is not None:
            model_miss, close_miss = abs(value - actual), abs(line - actual)
            row[f'closer{key}'] = None if model_miss == close_miss else model_miss < close_miss
    if margin is not None and open_margin is not None and close_margin is not None \
            and margin != open_margin and close_margin != open_margin:
        row['movedToward'] = (close_margin - open_margin > 0) == (margin - open_margin > 0)
    if sd and margin is not None:
        row['within80'] = abs(margin - actual_margin) <= Z80 * sd
    if home_prob is not None and actual_margin != 0:
        row['brier'] = round((home_prob - (1.0 if actual_margin > 0 else 0.0)) ** 2, 4)
    return row


def summarize(rows):
    def record(key):
        values = [r.get(key) for r in rows]
        return [values.count('W'), values.count('L'), values.count('P')]

    def mean(values):
        values = [v for v in values if v is not None]
        return round(statistics.mean(values), 2) if values else None

    def split(key):
        values = [r[key] for r in rows if r.get(key) is not None]
        return [sum(values), len(values) - sum(values)]

    priced = [r for r in rows if r['closeMargin'] is not None and r['margin'] is not None]
    totals = [r for r in rows if r['closeTotal'] is not None and r['total'] is not None]
    out = {'games': len(rows), 'side': record('side'), 'ou': record('ou'),
           'marginMiss': mean(abs(r['margin'] - r['actualMargin']) for r in priced),
           'closeMarginMiss': mean(abs(r['closeMargin'] - r['actualMargin']) for r in priced),
           'totalMiss': mean(abs(r['total'] - r['actualTotal']) for r in totals),
           'closeTotalMiss': mean(abs(r['closeTotal'] - r['actualTotal']) for r in totals),
           'closerMargin': split('closerMargin'), 'closerTotal': split('closerTotal'),
           'movedToward': split('movedToward')}
    if any('within80' in r for r in rows):
        out['within80'] = mean(1.0 if r['within80'] else 0.0 for r in rows if 'within80' in r)
    if any('brier' in r for r in rows):
        out['brier'] = round(statistics.mean(r['brier'] for r in rows if 'brier' in r), 4)
    return out


def week_label(game):
    return 'post' if game.get('seasonType') == 3 else str(game.get('week'))


def group(rows, keys=('league', 'model', 'season')):
    """Summaries per league, model and season, each with its weeks in order."""
    buckets = defaultdict(list)
    for row in rows:
        buckets[tuple(row[k] for k in keys)].append(row)
    out = []
    for key, members in sorted(buckets.items(), key=lambda item: (item[0][0], item[0][1], -item[0][2])):
        weeks = defaultdict(list)
        for row in members:
            weeks[row['week']].append(row)
        order = sorted(weeks, key=lambda w: (w == 'post', int(w) if w.isdigit() else 99))
        out.append({**dict(zip(keys, key)), 'summary': summarize(members),
                    'weeks': [{'week': w, **summarize(weeks[w])} for w in order]})
    return out


# ------------------------------------------------------------------ sources

def v1_rows(games):
    rows = []
    for forecast in read(DATA / 'forecasts.json', []):
        game = games.get(forecast.get('gameId'))
        if not game or not before(forecast.get('publishedAt'), game['kickoff']):
            continue
        rows.append(row_for(game, 'v1', forecast['publishedAt'],
                            grade(game, forecast['home'] - forecast['away'], forecast['home'] + forecast['away'])))
    return rows


def v2_rows(games):
    """The last snapshot published before kickoff, per game."""
    final = {}
    for path in sorted((ROOT / 'data' / 'forecasts').glob('*.jsonl')):
        for snapshot in boxscores.read_store(path):
            game = games.get(snapshot['gameId'])
            if game and before(snapshot['publishedAt'], game['kickoff']):
                final[snapshot['gameId']] = snapshot
    rows = []
    for gid, snapshot in final.items():
        row = row_for(games[gid], snapshot['model'], snapshot['publishedAt'],
                      grade(games[gid], snapshot['margin'], snapshot['total'], snapshot['sd']['margin'],
                            snapshot['homeWinProb']))
        rows.append(row)
    return rows, final


def analyst_rows(games, reports):
    final = {}
    for _, report in reports:
        for call in report.get('scores') or []:
            game = games.get(call.get('gameId'))
            if game and before(report.get('publishedAt'), game['kickoff']) \
                    and not report.get('historicalImport'):
                final[call['gameId']] = (report['publishedAt'], call)
    return [row_for(games[gid], 'analyst', published, grade(games[gid], call['home'] - call['away'],
                                                           call['home'] + call['away']))
            for gid, (published, call) in final.items()]


def row_for(game, model, published, graded):
    return {'gameId': game_id(game), 'league': game['league'], 'season': game['season'], 'week': week_label(game),
            'kickoff': game['kickoff'], 'model': model, 'publishedAt': published,
            'home': game['home']['abbreviation'], 'away': game['away']['abbreviation'], **graded}


# ------------------------------------------------------------------ backtest

def store_digest(league):
    ledger = read(boxscores.STORE / 'ledger.json', {})
    wanted = {f'{league.lower()}-{season}.jsonl' for season in range(min(BACKTEST_SEASONS) - 1, max(BACKTEST_SEASONS) + 1)}
    return hashlib.sha256(json.dumps({k: v for k, v in sorted(ledger.items()) if k in wanted}).encode()).hexdigest()[:12]


def backtest_rows(games_by_league):
    """v2 walk-forward and the v1 Elo replay for past seasons, cached by inputs."""
    key = {'version': model_v2.VERSION, 'params': model_v2.params_hash(),
           'stores': {league: store_digest(league) for league in ('NFL', 'CFB')}}
    cached = read(BACKTEST, {})
    if cached.get('key') == key:
        return cached['rows']
    rows = []
    for league in ('NFL', 'CFB'):
        records = games_by_league[league]
        replay = elo_replay(league, records)
        by_event = {r['eventId']: r for r in records}
        for season in BACKTEST_SEASONS:
            for item in model_v2.backtest(league, season, records=records):
                game = by_event[item['eventId']]
                forecast = item['forecast']
                rows.append(row_for(game, model_v2.VERSION, None,
                                    grade(game, forecast['margin'], forecast['total'], forecast['sdMargin'],
                                          forecast['homeWinProb'])))
                v1 = replay.get(item['eventId'])
                if v1:
                    rows.append(row_for(game, 'v1 replay', None, grade(game, *v1)))
    BACKTEST.parent.mkdir(parents=True, exist_ok=True)
    BACKTEST.write_text(json.dumps({'key': key, 'rows': rows}, separators=(',', ':')) + '\n', encoding='utf-8',
                        newline='\n')
    return rows


def elo_replay(league, records):
    """v1's Elo (refresh.Model, unchanged) rated just before each game, as rounded scores."""
    elo, out = model_v2.Elo(league), {}
    for game in records:
        g = {'id': game['eventId'], 'season': game['season'], 'neutral': game['neutral'],
             'source': game['sources']['page'],
             'home': {'id': game['home']['id'], 'score': game['home']['score']},
             'away': {'id': game['away']['id'], 'score': game['away']['score']}}
        forecast = elo.predict(g, datetime(2000, 1, 1, tzinfo=timezone.utc))  # stamp unused
        out[game['eventId']] = (forecast['home'] - forecast['away'], forecast['home'] + forecast['away'])
        elo.train(g)
    return out


# ------------------------------------------------------------------ props

def captured_lines(games):
    """gameId -> (retrievedAt, lines) from the last DraftKings capture before kickoff."""
    out = {}
    for path in sorted((ROOT / 'data' / 'props').glob('*.jsonl')):
        for capture in boxscores.read_store(path):
            game = games.get(capture['gameId'])
            if game and before(capture['retrievedAt'], game['kickoff']):
                out[capture['gameId']] = (capture['retrievedAt'], capture['lines'])
    return out


def settle_value(player, stat):
    if player is None:
        return None
    if stat == 'rushRecYds':
        return player.get('rushYds', 0) + player.get('recYds', 0)
    if stat == 'passRushYds':
        return player.get('passYds', 0) + player.get('rushYds', 0)
    if stat in features.LONGEST:
        return player.get(stat)
    return player.get(stat, 0)


def projection_rows(games, snapshots, captures):
    rows = []
    for gid, snapshot in snapshots.items():
        game, capture = games.get(gid), captures.get(gid)
        if not game or not capture:
            continue
        box = {p['id']: p for p in game['players']}
        for side in ('home', 'away'):
            for player in (snapshot['players'].get(side) or {}).get('players', []):
                lines = capture[1].get(player['id'], {})
                for stat, market in PROP_STATS.items():
                    if stat not in player or market not in lines or player['id'] not in box:
                        continue
                    projection, line = player[stat][0], lines[market][0]
                    actual = settle_value(box[player['id']], market)
                    rows.append({'gameId': gid, 'week': week_label(game), 'player': player['id'], 'market': market,
                                 'projection': projection, 'line': line, 'actual': actual,
                                 'result': against(projection, line, actual),
                                 'capturedAt': capture[0]})
    return rows


def summarize_props(rows):
    out = []
    for market in sorted({r['market'] for r in rows}):
        members = [r for r in rows if r['market'] == market]
        results = [r['result'] for r in members]
        closer = [abs(r['projection'] - r['actual']) < abs(r['line'] - r['actual']) for r in members
                  if abs(r['projection'] - r['actual']) != abs(r['line'] - r['actual'])]
        out.append({'market': market, 'graded': len(members),
                    'record': [results.count('W'), results.count('L'), results.count('P')],
                    'closerThanLine': [sum(closer), len(closer) - sum(closer)],
                    'projectionMiss': round(statistics.mean(abs(r['projection'] - r['actual']) for r in members), 2),
                    'lineMiss': round(statistics.mean(abs(r['line'] - r['actual']) for r in members), 2)})
    return out


# ------------------------------------------------------------------ picks

def observed_lines():
    """(gameId, athleteId, market) -> [(observedAt, line, odds, direction, book, source)] from hand captures."""
    out = defaultdict(list)
    for path in sorted(glob.glob(str(ROOT / 'market-observations' / '*.json'))):
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
        for block in payload if isinstance(payload, list) else [payload]:
            for item in block.get('observations', []):
                market = PICK_MARKETS.get(str(item.get('market', '')).lower())
                if item.get('athleteId') and market and isinstance(item.get('line'), (int, float)):
                    out[(block.get('gameId'), str(item['athleteId']), market)].append(
                        (block['retrievedAt'], item['line'], item.get('odds'), item.get('direction'),
                         block.get('book'), block.get('source')))
    return out


def parse_prop(pick):
    """(direction, line, market) from the published title, e.g. 'X OVER 21.5 completions'."""
    title = pick.get('marketTitle') or pick.get('title') or ''
    found = re.search(r'\b(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s+(.+)$', title)
    if not found:
        return None
    return found.group(1), float(found.group(2)), PICK_MARKETS.get(found.group(3).strip().lower())


def athlete_for(pick, game):
    if pick.get('athleteId'):
        return str(pick['athleteId'])
    name = re.split(r'\s+(?:OVER|UNDER)\b', pick.get('title', ''), maxsplit=1)[0]
    key = re.sub(r'[^a-z]', '', name.lower())
    matches = [p['id'] for p in (game or {}).get('players', []) if re.sub(r'[^a-z]', '', (p.get('name') or '').lower()) == key]
    return matches[0] if len(matches) == 1 else None


def pick_rows(reports, games, captures, observations):
    first, last = {}, {}
    for name, report in reports:
        for kind in ('props', 'riskyProps', 'gamePicks'):
            for pick in report.get(kind) or []:
                key = (report['league'], kind, pick.get('id'))
                first.setdefault(key, (report, pick))
                last[key] = (report, pick)
    rows = []
    for key, (report, pick) in first.items():
        if pick.get('status') == 'historical' or report.get('historicalImport'):
            continue
        gid = (pick.get('gameIds') or [pick.get('gameId')])[0]
        game = games.get(gid)
        latest = last[key][1]
        row = {'id': pick.get('id'), 'league': report['league'], 'kind': key[1], 'title': pick.get('title'),
               'gameId': gid, 'book': pick.get('book'), 'postedOdds': pick.get('odds'),
               'postedAt': pick.get('quotedAt') or report.get('publishedAt'), 'result': latest.get('result')}
        kickoff = game['kickoff'] if game else None
        if key[1] == 'gamePicks':
            close = ((game or {}).get('market') or {}).get('close') or {}
            direction, posted = pick.get('direction'), number(pick.get('line'))
            if pick.get('marketType') == 'spread' and close.get('spread') is not None and posted is not None:
                closing = close['spread'] if direction == 'home' else -close['spread']
                row.update(postedLine=posted, closeLine=closing, clv=round(posted - closing, 1),
                           closeSource='ESPN close (DraftKings)')
            elif pick.get('marketType') == 'total' and close.get('total') is not None and posted is not None:
                sign = 1 if direction == 'over' else -1
                row.update(postedLine=posted, closeLine=close['total'], clv=round(sign * (close['total'] - posted), 1),
                           closeSource='ESPN close (DraftKings)')
        else:
            parsed = parse_prop(pick)
            athlete = athlete_for(pick, game)
            if parsed and parsed[2] and athlete and kickoff:
                direction, posted, market = parsed
                candidates = [(at, line, odds, 'hand observation') for at, line, odds, *_ in
                              observations.get((gid, athlete, market), []) if before(at, kickoff)]
                capture = captures.get(gid)
                if capture and market in capture[1].get(athlete, {}):
                    candidates.append((capture[0], capture[1][athlete][market][0], None, 'ESPN feed (DraftKings)'))
                if candidates:
                    at, line, odds, source = max(candidates, key=lambda c: features.when(c[0]))
                    sign = 1 if direction == 'OVER' else -1
                    row.update(postedLine=posted, closeLine=line, closeOdds=odds, closeAt=at, closeSource=source,
                               clv=round(sign * (line - posted), 1),
                               minutesBeforeKickoff=int((features.when(kickoff) - features.when(at)).total_seconds() // 60))
        rows.append(row)
    return rows


def summarize_picks(rows):
    measured = [r['clv'] for r in rows if r.get('clv') is not None]
    return {'published': len(rows), 'withClose': len(measured),
            'averageClv': round(statistics.mean(measured), 2) if measured else None,
            'beatClose': [sum(c > 0 for c in measured), sum(c == 0 for c in measured), sum(c < 0 for c in measured)]}


# ------------------------------------------------------------------ build

def build():
    records = features.load()
    games = {game_id(g): g for g in records}
    by_league = {league: [g for g in records if g['league'] == league] for league in ('NFL', 'CFB')}
    reports = integrity.reports()
    v2, snapshots = v2_rows(games)
    live = v1_rows(games) + v2 + analyst_rows(games, reports)
    backtest = backtest_rows(by_league)
    captures = captured_lines(games)
    props = projection_rows(games, snapshots, captures)
    picks = pick_rows(reports, games, captures, observed_lines())
    graded = [r['kickoff'] for r in live]
    summary = {'updatedThrough': max(graded) if graded else None,
               'live': group(live), 'backtest': group(backtest),
               'props': {'graded': len(props), 'markets': summarize_props(props)},
               'picks': {'summary': summarize_picks(picks), 'rows': picks},
               'method': {'close': 'Provider closing line from ESPN (DraftKings from 2026, ESPN BET for 2024-2025).',
                          'live': 'Only forecasts published before kickoff: v1 original, v2 last snapshot, analyst last call.',
                          'backtest': 'Retrospective walk-forward; never published and not part of the live record.',
                          'props': 'v2 projection vs the last DraftKings line captured before kickoff; no prices.',
                          'clv': 'Posted line vs the last comparable line before kickoff, in points, positive when better.'}}
    current = max((g['season'] for g in records), default=None)
    games_out = {f'{league}-{current}': [r for r in live if r['league'] == league and r['season'] == current]
                 for league in ('NFL', 'CFB')}
    return summary, games_out


def main():
    summary, games = build()
    for name, payload in (('scoreboard.json', summary), ('scoreboard-games.json', games)):
        path = DATA / name
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload, separators=(',', ':'), sort_keys=True) + '\n', encoding='utf-8',
                             newline='\n')
        temporary.replace(path)
    live = {f"{g['league']} {g['model']} {g['season']}": g['summary']['games'] for g in summary['live']}
    print(f'Scoreboard: live {live}; {summary["props"]["graded"]} projection-vs-line rows; '
          f'{summary["picks"]["summary"]["withClose"]} of {summary["picks"]["summary"]["published"]} picks with a close.')


if __name__ == '__main__':
    main()
