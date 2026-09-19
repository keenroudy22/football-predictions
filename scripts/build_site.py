"""Page payloads for the site, built from the stores. No network.

Each page loads only what it shows:

  app/today.json              games from three days back to eight ahead, with the
                              market, v1 and the latest v2 forecast; picks; record
  app/lines.json              the line catalog and current game markets (the board)
  app/games/<id>.json         one game: forecast history, player projections next
                              to DraftKings lines, both teams' form and defense
                              ranks, injuries, picks and lines, the final
  app/players/<L>.json        player directory for a league
  app/players/<L>/<n>.json    game logs, sharded by athlete ID
  app/teams/<L>.json          teams and what each defense allows by position
  app/teams/<L>/<id>.json     one team's games, defense log and roster usage
  app/research.json           injury report, status changes, analyst notes

Everything is derived from committed data, so site/data/app/ is not committed;
the hosted workflow rebuilds it before each deploy.

Usage: python scripts/build_site.py
"""
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features
import model_v2
import pricing
from sports_refresh import eastern_date

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
OUT = DATA / 'app'
SHARDS = {'NFL': 32, 'CFB': 128}
WINDOW_BACK, WINDOW_AHEAD = timedelta(days=3), timedelta(days=8)
LOG_KEYS = ('cmp', 'att', 'passYds', 'passTD', 'int', 'sacks', 'car', 'rushYds', 'rushTD', 'rushLong',
            'targets', 'rec', 'recYds', 'recTD', 'recLong', 'rzTgt', 'i10Tgt', 'rzCar', 'i10Car', 'i5Car',
            'scrambles', 'fumLost', 'fgm', 'fga', 'xpm', 'kPts', 'snaps', 'snapPct')
ALLOWED_KEYS = {'QB': ('att', 'cmp', 'passYds', 'passTD', 'int', 'sacks', 'car', 'rushYds'),
                'RB': ('car', 'rushYds', 'rushTD', 'targets', 'rec', 'recYds', 'recTD'),
                'WR': ('targets', 'rec', 'recYds', 'recTD'), 'TE': ('targets', 'rec', 'recYds', 'recTD')}


def read(path, fallback):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else fallback


def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(',', ':'), sort_keys=True, ensure_ascii=False) + '\n',
                    encoding='utf-8', newline='\n')


def number(value):
    try:
        return float(str(value).replace('+', ''))
    except (TypeError, ValueError):
        return None


def rnd(value, places=1):
    return None if value is None else round(value, places)


def stamp(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


@lru_cache(maxsize=None)
def day(kickoff):
    """A kickoff's Eastern calendar date. A Thursday 8:15 PM game is Thursday, though it is Friday in UTC."""
    return eastern_date(kickoff).isoformat()


def american(value):
    """Odds arrive as '+102' or '-110' strings, or 'OFF'; pages want integers or nothing."""
    try:
        return int(str(value).replace('+', ''))
    except (TypeError, ValueError):
        return None


def instant(value):
    """A timestamp as an aware instant, naive ones read as UTC; unreadable is None."""
    try:
        moment = features.when(value) if value else None
    except ValueError:
        return None
    return moment if moment is None or moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# Primary team colours, used only for accents. College colours come from the followed-player identities.
NFL_COLORS = {
    'ARI': '#97233F', 'ATL': '#A71930', 'BAL': '#241773', 'BUF': '#00338D', 'CAR': '#0085CA', 'CHI': '#0B162A',
    'CIN': '#FB4F14', 'CLE': '#FF3C00', 'DAL': '#003594', 'DEN': '#FB4F14', 'DET': '#0076B6', 'GB': '#203731',
    'HOU': '#03202F', 'IND': '#002C5F', 'JAX': '#006778', 'KC': '#E31837', 'LAC': '#0080C6', 'LAR': '#003594',
    'LV': '#A5ACAF', 'MIA': '#008E97', 'MIN': '#4F2683', 'NE': '#002244', 'NO': '#D3BC8D', 'NYG': '#0B2265',
    'NYJ': '#125740', 'PHI': '#004C54', 'PIT': '#FFB612', 'SEA': '#002244', 'SF': '#AA0000', 'TB': '#D50A0A',
    'TEN': '#4B92DB', 'WSH': '#5A1414'}
NEUTRAL = '#64748B'
# Provider names as the feed spells them, mapped to the books' own spelling.
BOOKS = {'Draft Kings': 'DraftKings', 'DraftKings': 'DraftKings', 'Fan Duel': 'FanDuel', 'FanDuel': 'FanDuel',
         'Bet MGM': 'BetMGM', 'BetMGM': 'BetMGM', 'ESPN BET': 'ESPN BET'}


def identity_colors(identity):
    """Team colours seen in the followed-player identities, by abbreviation."""
    out = {}
    for row in (identity or {}).get('players', {}).values():
        team = row.get('team') or {}
        if team.get('abbreviation') and team.get('color'):
            out.setdefault(team['abbreviation'], '#' + team['color'].lstrip('#'))
    return out


def first_publications(reports):
    """Each pick as first published, plus its latest settlement, by id.

    The original price and projection come from first publication. A later
    report may add a result; it never rewrites what was published.
    """
    first, latest = {}, {}
    for report in sorted(reports or [], key=lambda r: r.get('publishedAt') or ''):
        league, published = report.get('league'), report.get('publishedAt')
        for kind in ('props', 'riskyProps', 'gamePicks', 'parlays'):
            for pick in report.get(kind) or []:
                key = pick.get('id')
                if not key:
                    continue
                if key not in first:
                    first[key] = dict(pick, league=league, kind=kind, publishedAt=pick.get('publishedAt') or published,
                                      historicalImport=bool(report.get('historicalImport')))
                latest[key] = dict(latest.get(key, {}), **pick)
    return first, latest


def catalog_lines(catalog, games, identities, now):
    """Every catalogued line, with the state the board sorts and filters on."""
    out = []
    for row in (catalog or {}).get('lines', []):
        game = games.get(row.get('gameId')) or {}
        kickoff = instant(row.get('kickoff') or game.get('kickoff'))
        expires = instant(row.get('expiresAt'))
        if game.get('completed') or (game.get('state') or 'pre') != 'pre' or (kickoff and kickoff <= now):
            state = 'closed'
        elif row.get('status') in ('expired', 'stale') or (expires and expires <= now):
            state = 'stale'
        elif row.get('odds') is None or row.get('status') == 'missing-price':
            state = 'unpriced'
        elif row.get('quoteType') != 'sportsbook':
            state = 'reference'
        else:
            state = 'open'
        abbr = row.get('team') or (game.get('home') or {}).get('abbreviation')
        out.append({**{k: row.get(k) for k in ('id', 'league', 'gameId', 'player', 'athleteId', 'position', 'market',
                                               'direction', 'line', 'odds', 'book', 'observedAt', 'expiresAt', 'source',
                                               'marketWindow', 'title')},
                    'state': state, 'kickoff': row.get('kickoff') or game.get('kickoff'),
                    'color': color(row.get('league'), abbr, identities)})
    return out


# ------------------------------------------------------------------ inputs

def load_store(folder):
    out = {}
    for path in sorted((ROOT / 'data' / folder).glob('*.jsonl')):
        for line in boxscores.read_store(path):
            out.setdefault(line.get('gameId') or f"{line['league']}-{line['eventId']}", []).append(line)
    return out


def snaps_by_event():
    """eventId -> athlete ID -> (snaps, share)."""
    out = {}
    for path in sorted((ROOT / 'data' / 'nflverse').glob('nfl-*.jsonl')):
        for event, line in boxscores.latest(boxscores.read_store(path)).items():
            out[event] = {p['id']: (p['snaps'], p['pct']) for p in line['players'] if p.get('id')}
    return out


def team_names(records, slate):
    """ESPN team ID -> abbreviation, display name and FBS flag, from what we store."""
    teams = {}
    for game in slate.get('games', []):
        for side in ('home', 'away'):
            team = game[side]
            teams[(game['league'], str(team['id']))] = {'abbr': team.get('abbreviation'), 'name': team.get('name'),
                                                        'short': team.get('short')}
    for game in records:
        for side in ('home', 'away'):
            key = (game['league'], game[side]['id'])
            teams.setdefault(key, {'abbr': game[side]['abbreviation'], 'name': game[side]['abbreviation'],
                                   'short': game[side]['abbreviation']})
    return teams


def color(league, abbr, identities):
    return NFL_COLORS.get(abbr, NEUTRAL) if league == 'NFL' else identities.get(abbr, NEUTRAL)


# ------------------------------------------------------------------ today and games

def market(game):
    """The book's current spread (home side) and total, next to the book's own opening numbers.

    Our first observation is not the open: on this slate it differs from the
    book's opener on more than half the games, so it is never labelled one.
    """
    raw = game.get('market') or {}
    if not raw:
        return None
    spread, opened = number(raw.get('spread')), number(raw.get('spreadOpen'))
    return {'book': BOOKS.get((raw.get('provider') or '').strip(), raw.get('provider')), 'spread': spread,
            'spreadOpen': opened, 'spreadMove': round(spread - opened, 1) if spread is not None and opened is not None
            else None, 'total': number(raw.get('total')), 'totalOpen': number(str(raw.get('totalOpen') or '').lstrip('ou')),
            'spreadOdds': american(raw.get('spreadOdds')), 'overOdds': american(raw.get('overOdds')),
            'underOdds': american(raw.get('underOdds')), 'retrievedAt': game.get('marketRetrievedAt')}


def v2_summary(snapshot):
    if not snapshot:
        return None
    return {'home': snapshot['home']['points'], 'away': snapshot['away']['points'],
            'margin': rnd(snapshot['margin']), 'total': rnd(snapshot['total']),
            'winProb': snapshot['homeWinProb'], 'range': snapshot['range80'], 'sparse': snapshot.get('sparse'),
            'publishedAt': snapshot['publishedAt'], 'model': snapshot['model']}


def lean(v2, mkt):
    """How far v2 sits from the market, from the home side and on the total."""
    if not v2 or not mkt:
        return None
    out = {}
    if mkt.get('spread') is not None:
        points = round(v2['margin'] - (-mkt['spread']), 1)
        out['spread'] = points
        out['side'] = 'home' if points > 0 else 'away' if points < 0 else None
    if mkt.get('total') is not None:
        out['total'] = round(v2['total'] - mkt['total'], 1)
    return out


def game_card(game, forecasts_v1, snapshot, names, identities):
    league = game['league']

    def side(key):
        team = game[key]
        return {'id': str(team['id']), 'abbr': team.get('abbreviation'), 'name': team.get('short') or team.get('name'),
                'color': color(league, team.get('abbreviation'), identities), 'score': team.get('score')}

    v1 = forecasts_v1.get(game['id'])
    mkt = market(game)
    v2 = v2_summary(snapshot)
    return {'id': game['id'], 'league': league, 'week': game.get('week'), 'seasonType': game.get('seasonType'),
            'season': game.get('season'), 'kickoff': game['kickoff'], 'state': game.get('state'),
            'completed': bool(game.get('completed')), 'status': game.get('status'), 'neutral': bool(game.get('neutral')),
            'home': side('home'), 'away': side('away'), 'market': mkt,
            'v1': {'home': v1['home'], 'away': v1['away'], 'publishedAt': v1['publishedAt']} if v1 else None,
            'v2': v2, 'lean': lean(v2, mkt)}


def recent_form(team, league, logs, before, count=5):
    rows = [r for r in logs.get(team, []) if features.when(r['kickoff']) < before][-count:]
    out = []
    for r in reversed(rows):
        off, dfn = r['offense'], r['defense']
        pbp = off.get('pbp') or {}
        out.append({'gameId': f"{league}-{r['eventId']}", 'date': day(r['kickoff']), 'opp': r['opp'], 'home': r['home'],
                    'pf': r['pointsFor'], 'pa': r['pointsAgainst'], 'yards': off.get('yards'),
                    'yardsAllowed': dfn.get('yards'), 'plays': pbp.get('plays'),
                    'success': rnd(pbp['successes'] / pbp['successPlays'], 3) if pbp.get('successPlays') else None,
                    'turnovers': off.get('turnovers'), 'close': r['close']})
    return out


def defense_table(league, defense_logs, season, last=None):
    """Per defense: games and per-game averages allowed to each position group."""
    out = {}
    for team, rows in defense_logs.items():
        rows = [r for r in rows if r['season'] == season and r['seasonType'] == 2]
        rows = rows[-last:] if last else rows
        if not rows:
            continue
        entry = {'g': len(rows)}
        for pos, keys in ALLOWED_KEYS.items():
            entry[pos] = {k: rnd(sum((r['allowed'].get(pos) or {}).get(k, 0) for r in rows) / len(rows)) for k in keys}
        out[team] = entry
    return out


def pregame(snapshots, kickoff):
    """Snapshots published before kickoff. One published after (a kickoff moved earlier) is never the forecast."""
    start = features.when(kickoff)
    return [s for s in snapshots if features.when(s['publishedAt']) < start]


def game_detail(card, game, record, snapshots, captures, lines, picks, names, team_logs, defense, injuries, now,
                grading):
    """snapshots: this game's pregame v2 snapshots, oldest first."""
    league = card['league']
    detail = dict(card)
    final = snapshots[-1] if snapshots else None
    kickoff = features.when(game['kickoff'])
    if final:
        people = {}
        for side in ('home', 'away'):
            block = final['players'].get(side) or {}
            people[side] = {'volume': block.get('volume'), 'players': [
                {**p, 'name': names.get(p['id'], p['id'])} for p in block.get('players', [])]}
        detail['forecast'] = {'publishedAt': final['publishedAt'], 'why': final['why'], 'range': final['range80'],
                              'sd': final['sd'], 'inputs': {k: final['inputs'][k] for k in
                                                            ('games', 'through', 'ratings', 'ruledOut', 'injuryCoverage')},
                              'players': people,
                              'history': [{'at': s['publishedAt'], 'margin': rnd(s['margin']), 'total': rnd(s['total'])}
                                          for s in snapshots]}
    capture = captures[-1] if captures else None
    if capture:
        detail['props'] = {'capturedAt': capture['retrievedAt'], 'lines': capture['lines'],
                           'source': capture['source'], 'provider': capture['provider']}
    detail['market'] = card['market']
    detail['marketHistory'] = [{'at': h.get('retrievedAt'), 'spread': number(h.get('spread')), 'total': number(h.get('total')),
                                'phase': h.get('phase')} for h in game.get('marketHistory') or []]
    detail['teams'] = {}
    for side in ('home', 'away'):
        team = card[side]['id']
        opponent = card['away' if side == 'home' else 'home']['id']
        detail['teams'][side] = {'form': recent_form(team, league, team_logs, kickoff),
                                 'defense': defense.get(team), 'opponentDefense': defense.get(opponent),
                                 'injuries': injuries.get(team, [])}
    detail['lines'] = [l for l in lines if l.get('gameId') == card['id'] and not l.get('gameMarket')]
    detail['picks'] = [p for p in picks if p.get('gameId') == card['id']]
    if record:
        detail['final'] = {'home': record['home']['score'], 'away': record['away']['score'],
                           'periods': {'home': record['home'].get('periods'), 'away': record['away'].get('periods')},
                           'close': (record.get('market') or {}).get('close'), 'open': (record.get('market') or {}).get('open'),
                           'provider': (record.get('market') or {}).get('provider'),
                           'leaders': leaders(record, names), 'source': record['sources']['page']}
        detail['grades'] = grading.get(card['id'], [])
    return detail


def leaders(record, names):
    """Top passer, rushers and receivers from the stored box score."""
    out = []
    players = record['players']
    for key, label, count in (('passYds', 'passing', 1), ('rushYds', 'rushing', 2), ('recYds', 'receiving', 3)):
        for team in (record['away']['id'], record['home']['id']):
            best = sorted((p for p in players if p.get('team') == team and p.get(key)), key=lambda p: -p[key])[:count]
            for p in best:
                out.append({'id': p['id'], 'name': p.get('name') or names.get(p['id'], p['id']), 'team': team,
                            'pos': p.get('pos'), 'kind': label,
                            'line': {k: p[k] for k in ('cmp', 'att', 'passYds', 'passTD', 'int', 'car', 'rushYds',
                                                       'rushTD', 'rec', 'tgt', 'recYds', 'recTD') if k in p}})
    return out


# ------------------------------------------------------------------ players and teams

def build_players(league, records, snaps, teams_meta):
    logs = features.player_logs(records)
    index, shards = [], defaultdict(dict)
    latest_season = max((g['season'] for g in records), default=None)
    for pid, rows in logs.items():
        last = rows[-1]
        if not last.get('name') or last['season'] < latest_season - 1:
            continue
        name = next((r['name'] for r in reversed(rows) if r.get('name')), None)
        pos = next((r['pos'] for r in reversed(rows) if r.get('pos')), None)
        table = []
        for r in rows:
            stats = dict(r['stats'])
            if league == 'NFL' and r['eventId'] in snaps and pid in snaps[r['eventId']]:
                stats['snaps'], stats['snapPct'] = snaps[r['eventId']][pid]
            table.append([r['eventId'], day(r['kickoff']), r['season'], r['week'], r['seasonType'], r['team'], r['opp'],
                          1 if r['home'] is True else 0 if r['home'] is False else -1]
                         + [stats.get(k) for k in LOG_KEYS])
        team = last['team']
        index.append([pid, name, pos, team, teams_meta.get((league, team), {}).get('abbr'), day(last['kickoff']), len(rows)])
        shards[int(pid) % SHARDS[league]][pid] = {'name': name, 'pos': pos, 'rows': table}
    index.sort(key=lambda row: (row[1] or '', row[0]))
    return index, shards


def build_teams(league, records, team_logs, defense_logs, teams_meta, identities, current):
    fbs = {team for team, rows in team_logs.items() if sum(1 for r in rows if r['season'] >= current - 1) >= 8} \
        if league == 'CFB' else set(team_logs)
    directory = {}
    for team in sorted(team_logs):
        meta = teams_meta.get((league, team), {})
        directory[team] = {'abbr': meta.get('abbr'), 'name': meta.get('name'), 'short': meta.get('short'),
                           'color': color(league, meta.get('abbr'), identities), 'fbs': team in fbs}
    table = {'season': current, 'rows': defense_table(league, defense_logs, current),
             'last5': defense_table(league, defense_logs, current, 5),
             'prior': {'season': current - 1, 'rows': defense_table(league, defense_logs, current - 1)}}
    files = {}
    for team in fbs:
        games = [{'gameId': f"{league}-{r['eventId']}", 'date': day(r['kickoff']), 'season': r['season'], 'week': r['week'],
                  'seasonType': r['seasonType'], 'opp': r['opp'], 'home': r['home'], 'pf': r['pointsFor'],
                  'pa': r['pointsAgainst'], 'close': r['close'],
                  'off': {k: r['offense'].get(k) for k in ('yards', 'passYds', 'rushYds', 'turnovers', 'plays')},
                  'def': {k: r['defense'].get(k) for k in ('yards', 'passYds', 'rushYds', 'turnovers')}}
                 for r in team_logs[team] if r['season'] >= current - 1]
        allowed = [{'gameId': f"{league}-{r['eventId']}", 'date': day(r['kickoff']), 'season': r['season'],
                    'week': r['week'], 'opp': r['opp'], 'allowed': r['allowed']}
                   for r in defense_logs.get(team, []) if r['season'] >= current - 1]
        files[team] = {'id': team, **directory[team], 'games': games, 'defense': allowed}
    return {'teams': directory, 'defense': table}, files


# ------------------------------------------------------------------ research

def build_research(context, reports, now):
    out = {'injuries': {}, 'changes': [], 'notes': []}
    for league in ('NFL', 'CFB'):
        block = (context.get('leagues') or {}).get(league) or {}
        teams = {}
        for team, data in (block.get('teams') or {}).items():
            listed = []
            for p in data.get('players', []):
                if str(p.get('status', '')).lower() == 'active':
                    continue
                try:
                    fresh = p.get('reportedAt') and now - features.when(p['reportedAt']) <= timedelta(days=21)
                except ValueError:
                    fresh = False
                if fresh:
                    listed.append({k: p.get(k) for k in ('id', 'name', 'position', 'status', 'injury', 'reportedAt', 'source')})
            if listed:
                teams[team] = {'name': data.get('name'), 'players': listed}
        out['injuries'][league] = {'teams': teams, 'checkedAt': block.get('checkedAt'), 'status': block.get('status'),
                                   'coverage': block.get('coverage')}
        out['changes'] += [{'league': league, **c} for c in (block.get('changes') or [])][-40:]
    recent = sorted(reports, key=lambda r: r.get('publishedAt') or '', reverse=True)[:12]
    for report in recent:
        note = {'league': report.get('league'), 'publishedAt': report.get('publishedAt'),
                'title': report.get('title') or report.get('headline'),
                'takeaways': report.get('takeaways') or [], 'weeklyReview': report.get('weeklyReview') or [],
                'watch': [{k: w.get(k) for k in ('id', 'title', 'gameId', 'why', 'needs', 'nextReviewAt', 'player')}
                          for w in report.get('gameWatch') or []]}
        if note['takeaways'] or note['weeklyReview'] or note['watch']:
            out['notes'].append(note)
    return out


# ------------------------------------------------------------------ build

def build(now=None):
    now = now or datetime.now(timezone.utc)
    slate = read(DATA / 'slate.json', {'games': []})
    reports = read(DATA / 'research.json', [])
    catalog = read(DATA / 'market-lines.json', {})
    identities = identity_colors(read(DATA / 'player-identity.json', {}))
    context = read(DATA / 'research-context.json', {})
    scoreboard = read(DATA / 'scoreboard.json', {})
    forecasts_v1 = {f['gameId']: f for f in read(DATA / 'forecasts.json', [])}
    records = features.load()
    stored = {f"{g['league']}-{g['eventId']}": g for g in records}
    forecasts = load_store('forecasts')
    captures = load_store('props')
    snaps = snaps_by_event()
    names = {}
    for game in records:
        for p in game['players']:
            if p.get('name'):
                names[p['id']] = p['name']
    teams_meta = team_names(records, slate)
    by_id = {g['id']: g for g in slate.get('games', [])}
    first, latest = first_publications(reports)
    picks = [p for p in board_picks(first, latest, by_id, identities)]
    lines = catalog_lines(catalog, by_id, identities, now) + game_market_lines(slate, now)

    if OUT.exists():
        shutil.rmtree(OUT)
    window = [g for g in slate.get('games', []) if g.get('league') in ('NFL', 'CFB')
              and now - WINDOW_BACK <= features.when(g['kickoff']) <= now + WINDOW_AHEAD]
    grading = defaultdict(list)
    for row in (read(DATA / 'scoreboard-games.json', {}) or {}).values():
        for r in row:
            grading[r['gameId']].append({k: r.get(k) for k in ('model', 'margin', 'total', 'side', 'ou', 'closeMargin',
                                                                'closeTotal', 'closerMargin', 'closerTotal')})
    cards = []
    league_data = {}
    for league in ('NFL', 'CFB'):
        league_records = [g for g in records if g['league'] == league]
        current = max((g['season'] for g in league_records), default=now.year)
        team_logs = features.team_logs(league_records)
        defense_logs = features.defense_logs(league_records)
        league_data[league] = {'team_logs': team_logs, 'defense': defense_table(league, defense_logs, current),
                               'defense_logs': defense_logs, 'current': current, 'records': league_records}
    injuries = {}
    for league in ('NFL', 'CFB'):
        block = ((context.get('leagues') or {}).get(league) or {}).get('teams') or {}
        for team, data in block.items():
            injuries[team] = [{k: p.get(k) for k in ('id', 'name', 'position', 'status', 'injury', 'reportedAt')}
                              for p in data.get('players', []) if str(p.get('status', '')).lower() != 'active']
    # Grade every open line before anything is written, so the board and the game pages agree.
    appearances = defaultdict(int)
    for game in records:
        if game['season'] == league_data[game['league']]['current']:
            for player in game['players']:
                appearances[player['id']] += 1
    cfb = league_data['CFB']
    fbs = model_v2.fbs_teams([g for g in cfb['records'] if g['season'] >= cfb['current'] - 1])
    for line in lines:
        game = by_id.get(line.get('gameId'))
        snapshot = (pregame(forecasts.get(game['id'], []), game['kickoff']) or [None])[-1] if game else None
        fcs = bool(game) and game['league'] == 'CFB' and not {str(game['home']['id']), str(game['away']['id'])} <= fbs
        thin = bool(snapshot and snapshot.get('sparse')) \
            or bool(line.get('athleteId')) and appearances[str(line['athleteId'])] < 3
        # v2 compresses FBS-FCS blowouts badly enough that any chance it gives there would mislead.
        line['grade'] = None if fcs else grade_line(line, snapshot, thin)
        line['gradeNote'] = 'FBS vs FCS: v2 is not reliable here' if fcs and line.get('state') == 'open' else None
    for game in sorted(window, key=lambda g: (g['kickoff'], g['id'])):
        snaps_for = pregame(forecasts.get(game['id'], []), game['kickoff'])
        card = game_card(game, forecasts_v1, snaps_for[-1] if snaps_for else None, names, identities)
        card['fcs'] = game['league'] == 'CFB' and not {str(game['home']['id']), str(game['away']['id'])} <= fbs
        cards.append(card)
        info = league_data[game['league']]
        write(OUT / 'games' / f"{game['id']}.json",
              game_detail(card, game, stored.get(game['id']), snaps_for, captures.get(game['id'], []), lines, picks,
                          names, info['team_logs'], info['defense'], injuries, now, grading))
    summary = {'live': [{k: g[k] for k in ('league', 'model', 'season', 'summary')} for g in scoreboard.get('live', [])],
               'backtest': [{k: g[k] for k in ('league', 'model', 'season', 'summary')} for g in scoreboard.get('backtest', [])],
               'picks': (scoreboard.get('picks') or {}).get('summary')}
    freshness = {'slate': slate.get('updatedAt'),
                 'boxscores': max((g['retrievedAt'] for g in records), default=None),
                 'forecasts': max((s['publishedAt'] for rows in forecasts.values() for s in rows), default=None),
                 'injuries': ((context.get('leagues') or {}).get('NFL') or {}).get('checkedAt'),
                 'props': max((c['retrievedAt'] for rows in captures.values() for c in rows), default=None)}
    write(OUT / 'today.json', {'generatedAt': stamp(now), 'freshness': freshness, 'games': cards, 'picks': picks,
                               'model': summary})
    write(OUT / 'lines.json', {'generatedAt': stamp(now), 'lines': lines})
    for league in ('NFL', 'CFB'):
        info = league_data[league]
        index, shards = build_players(league, info['records'], snaps if league == 'NFL' else {}, teams_meta)
        write(OUT / 'players' / f'{league}.json', {'keys': list(LOG_KEYS), 'shards': SHARDS[league], 'players': index})
        for shard, players in shards.items():
            write(OUT / 'players' / league / f'{shard}.json', {'keys': list(LOG_KEYS), 'players': players})
        directory, files = build_teams(league, info['records'], info['team_logs'], info['defense_logs'], teams_meta,
                                       identities, info['current'])
        write(OUT / 'teams' / f'{league}.json', directory)
        for team, payload in files.items():
            write(OUT / 'teams' / league / f'{team}.json', payload)
    write(OUT / 'research.json', {'generatedAt': stamp(now), **build_research(context, reports, now)})
    return len(cards)


# Week 1's "My final five", from the screenshot import, which predates the favorite flag. The report is
# part of the record and is never edited, so the five are named here, as the old site named them.
FAVORITES_BEFORE_FLAG = {'w1-loveland-rec', 'w1-mayfield-pass', 'w1-otton-rec', 'w1-pollard-carries', 'w1-bateman-rec'}


def board_picks(first, latest, by_id, identities):
    """The board's pick rows (first publication plus latest settlement), newest first.

    A pick is a favorite if it was one when first published; a later report cannot promote or demote it.
    """
    rows = []
    for key, pick in first.items():
        recent = latest.get(key, {})
        game = by_id.get((pick.get('gameIds') or [None])[0]) or {}
        rows.append({'id': key, 'league': pick.get('league'), 'kind': pick.get('kind'), 'title': pick.get('title'),
                     'player': pick.get('player'), 'athleteId': pick.get('athleteId'), 'position': pick.get('position'),
                     'gameId': (pick.get('gameIds') or [None])[0], 'line': pick.get('line'),
                     'direction': pick.get('direction'), 'book': pick.get('book'), 'odds': pick.get('odds'),
                     'projection': pick.get('projection'), 'confidence': pick.get('confidence'),
                     'favorite': pick.get('favorite') is True or key in FAVORITES_BEFORE_FLAG,
                     'marketType': pick.get('marketType'), 'parlayType': pick.get('parlayType'),
                     'cutoff': pick.get('cutoff'), 'why': pick.get('why'),
                     'risk': pick.get('risk'), 'edge': pick.get('edge'), 'quotedAt': pick.get('quotedAt'),
                     'expiresAt': pick.get('expiresAt'), 'publishedAt': pick.get('publishedAt'),
                     'historicalImport': pick.get('historicalImport'), 'sources': pick.get('sources') or [],
                     'legs': pick.get('legs'), 'correlation': pick.get('correlation'), 'riskTier': pick.get('riskTier'),
                     'marketWindow': pick.get('marketWindow'), 'entryNote': recent.get('entryNote') or pick.get('entryNote'),
                     'status': recent.get('status') or pick.get('status'),
                     'result': recent.get('result'), 'actual': recent.get('actual'), 'settledAt': recent.get('settledAt'),
                     'settlementReason': recent.get('settlementReason'), 'resultSource': recent.get('resultSource'),
                     'kickoff': game.get('kickoff'),
                     'color': color(pick.get('league'), (game.get('home') or {}).get('abbreviation'), identities)})
    rows.sort(key=lambda p: p.get('publishedAt') or '', reverse=True)
    return rows


def grade_line(line, snapshot, thin):
    """v2's read on one open, priced line: its chance at the line, what the price needs, and a tier.

    The same arithmetic as the research desk (scripts/pricing.py). thin: the game or the player has
    too little this season for v2 to read as strong. None when v2 has no number for the line.
    """
    odds = line.get('odds')
    if line.get('state') != 'open' or not snapshot or not isinstance(odds, (int, float)) or abs(odds) < 100 \
            or not isinstance(line.get('line'), (int, float)):
        return None
    if line.get('gameMarket'):
        market, side, athlete = ('spread', 'home', None) if line['market'] == 'point spread' \
            else ('total', line.get('direction'), None)
    else:
        market, side, athlete = pricing.market_of(line), str(line.get('direction') or '').lower(), line.get('athleteId')
        if not market or side not in ('over', 'under') or not athlete:
            return None
    try:
        p = pricing.price(snapshot, market, side, float(line['line']), int(odds), athlete)
    except ValueError:  # no projection for this player or market
        return None
    return {'chance': p['chance'], 'push': p['push'], 'needs': p['breakEven'], 'edge': p['edgePoints'],
            'projection': p['projection'], 'thin': thin, 'tier': pricing.tier(p['edgePoints'], thin),
            'model': p['model'], 'snapshotAt': p['snapshotAt']}


def game_market_lines(slate, now):
    """Current spread and total for each upcoming game, as board rows.

    The feed prices the home side of the spread and both sides of the total, so
    those are the rows. The away spread has no quoted price and is left out.
    """
    out = []
    for game in slate.get('games', []):
        m = market(game)
        if not m or game.get('state') != 'pre' or features.when(game['kickoff']) <= now:
            continue
        home, away = game['home']['abbreviation'], game['away']['abbreviation']
        rows = []
        if m['spread'] is not None:
            rows.append(('spread', 'point spread', m['spread'], m['spreadOdds'], f"{home} {m['spread']:+g}", None))
        if m['total'] is not None:
            rows += [('over', 'total points', m['total'], m['overOdds'], f"{away} @ {home} over {m['total']:g}", 'over'),
                     ('under', 'total points', m['total'], m['underOdds'], f"{away} @ {home} under {m['total']:g}",
                      'under')]
        for kind, name, value, odds, title, direction in rows:
            out.append({'id': f"game-{game['id']}-{kind}", 'league': game['league'], 'gameId': game['id'],
                        'market': name, 'line': value, 'odds': odds, 'direction': direction,
                        'book': m['book'], 'state': 'open', 'kickoff': game['kickoff'],
                        'observedAt': game.get('marketRetrievedAt'), 'title': title, 'gameMarket': True,
                        'marketWindow': 'Full game', 'move': m['spreadMove'] if kind == 'spread' else None})
    return out


def main():
    count = build()
    size = sum(p.stat().st_size for p in OUT.rglob('*.json'))
    files = sum(1 for _ in OUT.rglob('*.json'))
    print(f'Built {files} page files ({size // 1024} KB) covering {count} games in the window.')


if __name__ == '__main__':
    main()
