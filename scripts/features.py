"""Derived stats from the append-only box-score store. No network.

Everything here is a deterministic function of data/boxscores/*.jsonl, so any
number can be traced to ESPN event IDs and source URLs. Functions that feed a
forecast take `before` and use only games that kicked off earlier.

  player_logs     every stat line per athlete, oldest first
  team_logs       per team per game: points, own stats, opponent stats
  defense_logs    per defense per game: what each opposing position produced
  form / splits   last 5/10/20 and home/away/opponent summaries of a log

Usage: python scripts/features.py   prints coverage and data-quality checks
Stdlib only.
"""
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores

GROUP = {'QB': 'QB', 'RB': 'RB', 'FB': 'RB', 'WR': 'WR', 'TE': 'TE'}
WINDOWS = (5, 10, 20)
LONGEST = {'rushLong', 'recLong', 'fgLong'}
PLAYER_KEYS = ('cmp', 'att', 'passYds', 'passTD', 'int', 'sacked', 'car', 'rushYds', 'rushTD', 'rushLong',
               'rec', 'recYds', 'recTD', 'recLong', 'tgt', 'pbpTgt', 'rzTgt', 'i10Tgt', 'rzCar', 'i10Car',
               'i5Car', 'rzAtt', 'scrambles', 'fum', 'fumLost', 'fgm', 'fga', 'fgLong', 'xpm', 'xpa', 'kPts')
# What a defense allows to each position group, summed over that group's players.
ALLOWED = {'QB': ('cmp', 'att', 'passYds', 'passTD', 'int', 'sacks', 'car', 'rushYds', 'rushTD'),
           'RB': ('car', 'rushYds', 'rushTD', 'targets', 'rec', 'recYds', 'recTD'),
           'WR': ('targets', 'rec', 'recYds', 'recTD'),
           'TE': ('targets', 'rec', 'recYds', 'recTD')}


def when(value):
    return datetime.fromisoformat(str(value).replace('Z', '+00:00'))


def load(leagues=('NFL', 'CFB'), seasons=None, root=boxscores.STORE):
    """Current version of every stored game, oldest kickoff first."""
    games = {}
    for league in leagues:
        for path in sorted(root.glob(f'{league.lower()}-*.jsonl')):
            if seasons and int(path.stem.split('-')[1]) not in seasons:
                continue
            games.update(boxscores.latest(boxscores.read_store(path)))
    return sorted(games.values(), key=lambda g: (g['kickoff'], g['eventId']))


def usual_positions(records):
    """Each athlete's most frequent provider tag across stored games.

    Fills a game where the feed tagged no position, never overrides a tag.
    """
    seen = defaultdict(Counter)
    for game in records:
        for player in game['players']:
            if player.get('pos'):
                seen[player['id']][player['pos']] += 1
    return {athlete: min(tags.items(), key=lambda item: (-item[1], item[0]))[0] for athlete, tags in seen.items()}


def position(player, fallback):
    """(position, source) for a player line."""
    if player.get('pos'):
        return player['pos'], 'game'
    if player['id'] in fallback:
        return fallback[player['id']], 'other games'
    return None, None


def played_before(records, before):
    if before is None:
        return records
    cutoff = when(before) if isinstance(before, str) else before
    return [g for g in records if when(g['kickoff']) < cutoff]


def unified(player, league):
    """Targets and sacks with one meaning in both leagues.

    The official box-score count wherever it exists (NFL). College box scores
    list neither, so college values come from play-by-play. An NFL line with
    no official count stays unknown rather than borrowing the derived one.
    """
    out = {}
    if 'tgt' in player:
        out['targets'] = player['tgt']
    elif league == 'CFB':
        out['targets'] = player.get('pbpTgt', 0)
    if 'sacked' in player:
        out['sacks'], out['sackYds'] = player['sacked'], player.get('sackYds', 0)
    elif league == 'CFB' and any(k in player for k in ('att', 'pbpAtt', 'pbpSacked')):
        out['sacks'], out['sackYds'] = player.get('pbpSacked', 0), player.get('pbpSackYds', 0)
    return out


def sides(game):
    """(team, opponent, is_home) for both teams; is_home is None at neutral sites."""
    home, away = game['home']['id'], game['away']['id']
    neutral = game.get('neutral')
    return ((home, away, None if neutral else True), (away, home, None if neutral else False))


def context(game, team, opponent, is_home):
    return {'eventId': game['eventId'], 'league': game['league'], 'kickoff': game['kickoff'],
            'season': game['season'], 'seasonType': game['seasonType'], 'week': game['week'],
            'team': team, 'opp': opponent, 'home': is_home, 'source': game['sources']['page']}


def player_logs(records, before=None):
    logs = defaultdict(list)
    fallback = usual_positions(records)
    for game in played_before(records, before):
        where = {team: (team, opponent, is_home) for team, opponent, is_home in sides(game)}
        for player in game['players']:
            if player.get('team') not in where:
                continue
            row = context(game, *where[player['team']])
            pos, source = position(player, fallback)
            row.update(name=player.get('name'), pos=pos, stats={k: player[k] for k in PLAYER_KEYS if k in player})
            if source == 'other games':
                row['posSource'] = source
            row['stats'].update(unified(player, game['league']))
            logs[player['id']].append(row)
    return dict(logs)


def team_logs(records, before=None):
    logs = defaultdict(list)
    for game in played_before(records, before):
        for team, opponent, is_home in sides(game):
            own, other = game['teams'].get(team, {}), game['teams'].get(opponent, {})
            row = context(game, team, opponent, is_home)
            row.update(pointsFor=own.get('points'), pointsAgainst=other.get('points'),
                       offense={k: v for k, v in own.items() if k != 'points'},
                       defense={k: v for k, v in other.items() if k != 'points'},
                       close=(game.get('market') or {}).get('close'))
            logs[team].append(row)
    return dict(logs)


def defense_logs(records, before=None):
    """Per defense per game, the opposing QB/RB/WR/TE groups' combined lines.

    Positions are the provider's tags for that game, else the athlete's usual
    tag in other stored games. Fullbacks count with running backs. Players
    with no tag anywhere are counted, not assigned.
    """
    logs = defaultdict(list)
    fallback = usual_positions(records)
    for game in played_before(records, before):
        for defense, offense, is_home in sides(game):
            groups = {pos: Counter() for pos in ALLOWED}
            players = {pos: [] for pos in ALLOWED}
            untagged = 0
            for player in game['players']:
                if player.get('team') != offense:
                    continue
                pos, _ = position(player, fallback)
                group = GROUP.get(pos)
                if not group:
                    untagged += pos is None and any(k in player for k in ALLOWED['RB'] + ('att',))
                    continue
                values = {**player, **unified(player, game['league'])}
                line = {k: values[k] for k in ALLOWED[group] if k in values}
                if not line:
                    continue
                groups[group].update(line)
                players[group].append({'id': player['id'], 'name': player.get('name'), **line})
            row = context(game, defense, offense, is_home)
            row.update(allowed={pos: dict(values) for pos, values in groups.items()},
                       players={pos: rows for pos, rows in players.items() if rows}, untagged=untagged)
            logs[defense].append(row)
    return dict(logs)


def summarize(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {'n': len(values), 'avg': round(sum(values) / len(values), 2),
            'median': statistics.median(values), 'min': min(values), 'max': max(values)}


def value(row, stat):
    """A stat from any log row: player stats, allowed-by-position ('WR.recYds') or team fields.

    ESPN lists a player under a category only when he recorded something
    there, so a player row without a counting stat means zero. Longest-play
    stats have no zero, and team stats a league does not report stay missing.
    """
    if '.' in stat:
        group, key = stat.split('.', 1)
        return (row.get('allowed', {}).get(group) or {}).get(key, 0 if group in row.get('allowed', {}) else None)
    if 'stats' in row:
        return row['stats'].get(stat, None if stat in LONGEST else 0)
    return row.get(stat, (row.get('offense') or {}).get(stat))


def form(rows, stat, windows=WINDOWS, season_type=None):
    """Last-N summaries, most recent games first. Short logs report their true n."""
    rows = [r for r in rows if season_type is None or r['seasonType'] == season_type]
    recent = [value(r, stat) for r in reversed(rows)]
    return {f'last{n}': summarize(recent[:n]) for n in windows}


def splits(rows, stat, opponent=None):
    out = {'home': summarize([value(r, stat) for r in rows if r['home'] is True]),
           'away': summarize([value(r, stat) for r in rows if r['home'] is False]),
           'neutral': summarize([value(r, stat) for r in rows if r['home'] is None])}
    if opponent is not None:
        meetings = [r for r in rows if r['opp'] == str(opponent)]
        out['vsOpponent'] = {'summary': summarize([value(r, stat) for r in meetings]),
                             'games': [{'eventId': r['eventId'], 'kickoff': r['kickoff'], 'value': value(r, stat),
                                        'source': r['source']} for r in meetings]}
    return out


def defense_table(logs, stat, last=None, season=None):
    """Every defense's average allowed for a stat such as 'WR.recYds', best first."""
    table = []
    for defense, rows in logs.items():
        rows = [r for r in rows if season is None or r['season'] == season]
        rows = rows[-last:] if last else rows
        summary = summarize([value(r, stat) for r in rows])
        if summary:
            table.append({'defense': defense, **summary})
    table.sort(key=lambda row: (row['avg'], row['defense']))
    for rank, row in enumerate(table, 1):
        row['rank'] = rank
    return table


def coverage(records):
    """Per league-season counts and agreement with the official box score."""
    report = defaultdict(lambda: Counter())
    for game in records:
        key = f"{game['league']} {game['season']}"
        stats, quality = report[key], game['quality']
        stats['games'] += 1
        stats['withPlays'] += quality.get('plays') == 'ok'
        stats['withClose'] += bool((game.get('market') or {}).get('close', {}).get('spread') is not None)
        stats['closeTotal'] += bool((game.get('market') or {}).get('close', {}).get('total') is not None)
        stats['players'] += len(game['players'])
        stats['untaggedSkill'] += sum(1 for p in game['players'] if not p.get('pos')
                                      and any(k in p for k in ('car', 'rec', 'att', 'pbpTgt')))
        for check, values in quality.get('check', {}).items():
            stats[f'{check}Box'] += values['box']
            stats[f'{check}Pbp'] += values['pbp']
            stats[f'{check}Players'] += values['players']
            stats[f'{check}Exact'] += values['exact']
        stats.update({f"provider {(game.get('market') or {}).get('provider')}": 1})
    return {key: dict(values) for key, values in sorted(report.items())}


def main():
    records = load()
    if not records:
        sys.exit('No box scores stored yet. Run scripts/boxscores.py first.')
    for key, stats in coverage(records).items():
        games = stats['games']
        print(f"{key}: {games} games, plays {stats['withPlays'] / games:.1%}, closing spread {stats['withClose'] / games:.1%},"
              f" closing total {stats['closeTotal'] / games:.1%}, untagged skill rows {stats['untaggedSkill']}")
        for check in ('carries', 'receptions', 'targets'):
            if stats.get(f'{check}Players'):
                print(f"   {check}: box {stats[f'{check}Box']}, play-by-play {stats[f'{check}Pbp']},"
                      f" exact for {stats[f'{check}Exact'] / stats[f'{check}Players']:.1%} of players")
        providers = {k.split(' ', 1)[1]: v for k, v in stats.items() if k.startswith('provider ')}
        print('   providers:', providers)


if __name__ == '__main__':
    main()
