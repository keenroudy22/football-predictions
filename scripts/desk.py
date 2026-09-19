"""The research desk's numbers. A research run writes the reasons; the numbers come from here.

  python scripts/desk.py slate [NFL|CFB]
      Upcoming games where v2 and the market line differ most, and NFL player
      props where the v2 projection sits furthest from DraftKings' main line.
  python scripts/desk.py price GAME MARKET SIDE LINE ODDS [--player ATHLETE_ID]
      Everything a pick needs from code, as JSON: the v2 projection and 80%
      range, the chance of winning at LINE, the break-even of ODDS, the edge
      between them, and the cutoff past which the pick closes to new entries.
      MARKET is spread or total, or a player market (recYds, rec, rushYds,
      car, passYds, cmp, att). SIDE is home/away or over/under.
  python scripts/desk.py moves
      Every open published pick against the latest captured line, with the
      entry rule it now breaks, if any.

Chances are a normal approximation around the stored v2 mean, with the spread
its 80% range implies; results are whole numbers, so a whole-number line can
push. Team ranges held about 80% in backtests and player ranges 80-84%. A
chance at one exact line has not been calibrated on its own, and every output
says so.

Entry rules (the brief's): a pick closes to new entries when the number moves
against it by 0.5+ on a player prop, 1.5+ on a total, onto or across 3 or 7 on
a spread, or when the price at the same number moves 15+ cents against it. The
original stays in the record at its published price and is graded as posted.
Stdlib only.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import build_site
import features
import model_v2
from pricing import CAVEAT, KEYS, PROJECTED, RULES, cents, fmt, market_of, player_line, price, signed

ROOT = Path(__file__).resolve().parents[1]


# ------------------------------------------------------------------ inputs

def snapshots(root=ROOT / 'data' / 'forecasts'):
    """gameId -> v2 snapshots, oldest first."""
    out = {}
    for path in sorted(root.glob('*.jsonl')):
        for line in boxscores.read_store(path):
            out.setdefault(line['gameId'], []).append(line)
    return out


def captures(root=ROOT / 'data' / 'props'):
    """gameId -> DraftKings prop boards, oldest first."""
    out = {}
    for path in sorted(root.glob('*.jsonl')):
        for line in boxscores.read_store(path):
            out.setdefault(line['gameId'], []).append(line)
    return out


def current(snaps, kickoff, now):
    """The v2 snapshot a pick published now would stand on: the latest before now and before kickoff."""
    start = features.when(kickoff)
    usable = [s for s in snaps if features.when(s['publishedAt']) <= now and features.when(s['publishedAt']) < start]
    return usable[-1] if usable else None


# ------------------------------------------------------------------ entry rules

def breaks(kind, side, published, now_line, published_odds=None, now_odds=None):
    """The entry rule a later number breaks, or None. Moves toward the pick never close it."""
    if kind == 'spread':
        ours, theirs = published, now_line
        if theirs < ours and any(theirs <= k <= ours for k in KEYS):
            return f'spread moved from {signed(ours)} to {signed(theirs)}, onto or across 3 or 7'
    elif now_line is not None and now_line != published:
        step = RULES['total'] if kind == 'total' else RULES['prop']
        against = now_line - published if side == 'over' else published - now_line
        if against >= step - 1e-9:
            return f'{"total" if kind == "total" else "line"} moved {against:g} against, from {fmt(published)} to {fmt(now_line)}'
    if published_odds is not None and now_odds is not None and now_line == published:
        drop = cents(published_odds) - cents(now_odds)
        if drop >= RULES['cents']:
            return f'price moved {drop:g} cents against, from {published_odds:+d} to {now_odds:+d}'
    return None


def moves(picks, games, boards, now):
    """Open picks against the latest pregame number, with the rule each now breaks."""
    rows = []
    for pick in picks:
        if pick.get('result') or pick.get('historicalImport') or pick.get('kind') == 'parlays':
            continue
        game = games.get(pick.get('gameId')) or {}
        if not game or features.when(game['kickoff']) <= now:
            continue
        line, direction = pick.get('line'), str(pick.get('direction') or '').lower()
        row = {'id': pick['id'], 'title': pick.get('title'), 'gameId': game['id'], 'published': line,
               'odds': pick.get('odds'), 'now': None, 'nowOdds': None, 'seenAt': None, 'breaks': None}
        if pick.get('kind') == 'gamePicks':
            m = build_site.market(game) or {}
            if pick.get('marketType') == 'spread' and m.get('spread') is not None:
                row['now'] = m['spread'] if direction == 'home' else -m['spread']
                row['nowOdds'] = m.get('spreadOdds') if direction == 'home' else None
            elif pick.get('marketType') == 'total' and m.get('total') is not None:
                row['now'] = m['total']
                row['nowOdds'] = m.get('overOdds') if direction == 'over' else m.get('underOdds')
            row['seenAt'] = m.get('retrievedAt')
            kind = pick.get('marketType')
        else:
            key, athlete = market_of(pick), str(pick.get('athleteId') or '')
            board = (boards.get(game['id']) or [None])[-1]
            if board and key and athlete in board['lines'] and key in board['lines'][athlete]:
                row['now'], row['seenAt'] = board['lines'][athlete][key][0], board['retrievedAt']
            kind = 'prop'
        if line is None or row['now'] is None:
            row['breaks'] = 'no comparable current line'
        else:
            row['breaks'] = breaks(kind, direction, line, row['now'], pick.get('odds'), row['nowOdds'])
        rows.append(row)
    return rows


# ------------------------------------------------------------------ screens

def slate_screen(league, now, games, snaps, boards, names, season_games=None, fbs=None, top=12):
    """The biggest differences between v2 and the market, flagged where v2 is known to be weak.

    season_games: athlete -> games this season (a one-game role is a thin sample).
    fbs: FBS team IDs; v2 compresses FBS-FCS blowouts, so those games are marked.
    """
    season_games, fbs = season_games or {}, fbs
    lines = []
    ahead = [g for g in games.values() if g['league'] == league and g.get('state') == 'pre'
             and now < features.when(g['kickoff']) <= now + build_site.WINDOW_AHEAD]
    rows, props = [], []
    for game in ahead:
        snap = current(snaps.get(game['id'], []), game['kickoff'], now)
        m = build_site.market(game)
        if not snap or not m:
            continue
        label = f"{game['away']['abbreviation']} @ {game['home']['abbreviation']}"
        fcs = fbs is not None and league == 'CFB' and not {str(game['home']['id']), str(game['away']['id'])} <= fbs
        flags = ('FCS ' if fcs else '') + ('thin ' if snap.get('sparse') else '')
        if m.get('spread') is not None and m.get('spreadOdds'):
            p = price(snap, 'spread', 'home', m['spread'], m['spreadOdds'])
            q = price(snap, 'spread', 'away', -m['spread'], -110)
            best = max((p, 'home'), (q, 'away'), key=lambda x: x[0]['chance'])
            rows.append((abs(best[0]['chance'] - 0.5), game, label, f"spread {game['home']['abbreviation']} "
                         f"{signed(m['spread'])}", f"v2 margin {snap['margin']:+.1f}", best[1], best[0]['chance'], flags))
        if m.get('total') is not None and m.get('overOdds'):
            p = price(snap, 'total', 'over', m['total'], m['overOdds'])
            side = 'over' if p['chance'] >= 0.5 else 'under'
            chance = p['chance'] if side == 'over' else 1 - p['chance'] - p['push']
            rows.append((abs(chance - 0.5), game, label, f"total {fmt(m['total'])}", f"v2 total {snap['total']:.1f}",
                         side, chance, flags))
        board = (boards.get(game['id']) or [None])[-1]
        if league == 'NFL' and board:
            for athlete, markets in board['lines'].items():
                for key, (main, _) in markets.items():
                    if key not in PROJECTED:
                        continue
                    _, player = player_line(snap, athlete)
                    if not player or PROJECTED[key] not in player:
                        continue
                    p = price(snap, key, 'over', main, -110, athlete)
                    side = 'over' if p['chance'] >= 0.5 else 'under'
                    chance = p['chance'] if side == 'over' else 1 - p['chance'] - p['push']
                    props.append((abs(chance - 0.5), game, label, names.get(athlete, athlete), athlete, key, main,
                                  p['projection'], side, chance, season_games.get(athlete, 0), board['retrievedAt']))
    rows.sort(key=lambda r: -r[0])
    props.sort(key=lambda r: -r[0])
    lines.append(f'{league} games, v2 against the current line ({len(rows)} markets with a v2 forecast):')
    for _, game, label, market, model, side, chance, flags in rows[:top]:
        lines.append(f"  {game['id']}  {label:<12} {market:<16} {model:<18} v2 favors {side} {100 * chance:.1f}%"
                     f"{'  ' + flags.strip() if flags else ''}")
    if league == 'CFB':
        lines.append('  FCS: an FBS-FCS game, where v2 compresses blowouts. thin: a team with under three games '
                     'this season.')
    if league == 'NFL':
        lines.append('NFL props, v2 against the DraftKings main line (no price in the feed; get one before pricing).')
        lines.append('  g = games this season. A role set by one or two games is a question for research, not an edge.')
        for _, game, label, name, athlete, key, main, mean, side, chance, played, seen in props[:top * 2]:
            lines.append(f"  {game['id']}  {label:<12} {name[:24]:<24} {athlete:>8} {key:<8} line {fmt(main):>6}  "
                         f"v2 {mean:>6.1f}  {side} {100 * chance:.1f}%  g{played}  seen {seen}")
    lines.append(CAVEAT)
    return '\n'.join(lines)


# ------------------------------------------------------------------ command line

def load_games():
    slate = json.loads((ROOT / 'site' / 'data' / 'slate.json').read_text(encoding='utf-8'))
    return {g['id']: g for g in slate.get('games', []) if g.get('league') in ('NFL', 'CFB')}


def load_picks(games):
    reports = [json.loads(p.read_text(encoding='utf-8')) for p in sorted((ROOT / 'research').glob('*.json'))]
    first, latest = build_site.first_publications(reports)
    rows = build_site.board_picks(first, latest, games, {})
    for row in rows:
        original = first[row['id']]
        row['marketType'] = original.get('marketType')
        row['market'] = original.get('market')
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('slate')
    s.add_argument('league', nargs='?', default='NFL', choices=('NFL', 'CFB'))
    p = sub.add_parser('price')
    p.add_argument('game')
    p.add_argument('market')
    p.add_argument('side', choices=('home', 'away', 'over', 'under'))
    p.add_argument('line', type=float)
    p.add_argument('odds', type=int)
    p.add_argument('--player')
    sub.add_parser('moves')
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    games = load_games()
    if args.command == 'slate':
        records = features.load((args.league,))
        season = max((g['season'] for g in records), default=now.year)
        names, season_games = {}, {}
        for game in records:
            for player in game['players']:
                if player.get('name'):
                    names[player['id']] = player['name']
                if game['season'] == season:
                    season_games[player['id']] = season_games.get(player['id'], 0) + 1
        fbs = model_v2.fbs_teams([g for g in records if g['season'] >= season - 1]) if args.league == 'CFB' else None
        print(slate_screen(args.league, now, games, snapshots(), captures(), names, season_games, fbs))
    elif args.command == 'price':
        game = games.get(args.game)
        if not game:
            sys.exit(f'{args.game} is not in the slate')
        if features.when(game['kickoff']) <= now:
            sys.exit(f'{args.game} has kicked off; nothing can be published on it')
        if abs(args.odds) < 100:
            sys.exit('odds are American: -110, +150')
        snap = current(snapshots().get(args.game, []), game['kickoff'], now)
        if not snap:
            sys.exit(f'no v2 snapshot for {args.game} yet; the hosted workflow publishes them')
        try:
            print(json.dumps(price(snap, args.market, args.side, args.line, args.odds, args.player), indent=1))
        except ValueError as error:
            sys.exit(str(error))
    else:
        rows = moves(load_picks(games), games, captures(), now)
        if not rows:
            print('No open picks on games that have not started.')
        for row in rows:
            unknown = row['breaks'] == 'no comparable current line'
            state = 'CHECK' if unknown else 'CLOSE' if row['breaks'] else 'OPEN '
            now_price = f" at {row['nowOdds']:+d}" if row['nowOdds'] else ''
            reason = f": {row['breaks']}" if row['breaks'] else ''
            print(f"{state} {row['id']}: published {row['published']} at {row['odds']}, "
                  f"now {row['now']}{now_price} (seen {row['seenAt']}){reason}")


if __name__ == '__main__':
    main()
