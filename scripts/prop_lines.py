"""DraftKings NFL player prop lines, captured before kickoff from ESPN's feed.

ESPN relays DraftKings' main prop lines (one number per player per market, with
the opening number) but no prices; college props are not in the feed. Each run
reads the board for NFL games kicking off in the next three days and appends a
line to data/props/nfl-<season>.jsonl only when a number changed, with the
retrieval time. The scoreboard treats the last capture before kickoff as the
line at kickoff and says how long before kickoff it was taken.

Usage: python scripts/prop_lines.py
Stdlib only.
"""
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import features

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'props'
WINDOW = timedelta(days=3)
BOARD = boxscores.CORE + 'nfl/events/{event}/competitions/{event}/odds/100/propBets?limit=1000'
# Main full-game markets and the box-score stat each settles on.
MARKETS = {
    'Total Passing Yards': 'passYds', 'Total Pass Completions': 'cmp', 'Total Passing Attempts': 'att',
    'Total Passing Touchdowns': 'passTD', 'Total Passing Interceptions': 'int',
    'Total Passing Plus Rushing Yards': 'passRushYds', 'Total Rushing Yards': 'rushYds', 'Total Carries': 'car',
    'Total Receiving Yards': 'recYds', 'Total Receptions': 'rec', 'Total Rushing Plus Receiving Yards': 'rushRecYds',
    'Longest Reception': 'recLong', 'Longest Rush': 'rushLong', 'Total Kicking Points': 'kPts',
    'Total Field Goals Made': 'fgm', 'Total Extra Points Made': 'xpm',
}


def market_key(name):
    return MARKETS.get(re.sub(r'\s*\(incl\. overtime\)\s*$', '', str(name or '')).strip())


def parse(payload):
    """athlete ID -> {market: [current line, opening line]} for main markets.

    The feed lists each main line once per side with identical numbers. Entries
    that disagree for one player and market are an alternate ladder, not a main
    line, and are dropped rather than guessed between.
    """
    seen = {}
    for item in (payload or {}).get('items', []):
        key = market_key(item.get('type', {}).get('name'))
        athlete = boxscores.ref_id(item.get('athlete'), 'athletes')
        current = ((item.get('current') or {}).get('target') or {}).get('value')
        if not key or not athlete or not isinstance(current, (int, float)):
            continue
        opening = ((item.get('open') or {}).get('target') or {}).get('value')
        seen.setdefault((athlete, key), set()).add((current, opening if isinstance(opening, (int, float)) else None))
    lines = {}
    for (athlete, key), values in sorted(seen.items()):
        if len(values) == 1:
            lines.setdefault(athlete, {})[key] = list(next(iter(values)))
    return lines


def capture(slate, now, fetch=boxscores.fetch_json, root=STORE):
    """Append changed boards for NFL games kicking off within the window."""
    latest = {}
    for path in sorted(root.glob('*.jsonl')):
        for line in boxscores.read_store(path):
            latest[line['eventId']] = line
    written, problems = {}, []
    for game in slate.get('games', []):
        if game.get('league') != 'NFL' or game.get('state') != 'pre':
            continue
        kickoff = features.when(game['kickoff'])
        if not now < kickoff <= now + WINDOW:
            continue
        event = game['id'].split('-', 1)[1]
        url = BOARD.format(event=event)
        try:
            lines = parse(fetch(url))
        except Exception as error:  # a missing board is reported, never fatal
            problems.append(f'{game["id"]}: {type(error).__name__}')
            continue
        if not lines or (event in latest and latest[event]['lines'] == lines):
            continue
        record = {'league': 'NFL', 'eventId': event, 'gameId': game['id'], 'season': game['season'],
                  'kickoff': game['kickoff'], 'provider': 'DraftKings', 'source': url,
                  'retrievedAt': boxscores.stamp(now), 'lines': lines}
        record['hash'] = boxscores.content_hash(record)
        boxscores.append(boxscores.store_path('NFL', game['season'], root), [record])
        written[game['id']] = sum(len(markets) for markets in lines.values())
    return written, problems


def main():
    problems = boxscores.verify(STORE)
    if problems:
        sys.exit('Refusing to append to a prop store whose recorded lines changed:\n  ' + '\n  '.join(problems))
    STORE.mkdir(parents=True, exist_ok=True)
    slate = json.loads((ROOT / 'site' / 'data' / 'slate.json').read_text(encoding='utf-8'))
    written, problems = capture(slate, datetime.now(timezone.utc))
    boxscores.write_json(STORE / 'ledger.json', boxscores.ledger(STORE))
    print(f'Captured {len(written)} changed boards ({sum(written.values())} lines); {len(problems)} unavailable.')


if __name__ == '__main__':
    main()
