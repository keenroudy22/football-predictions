"""How much to trust v2's chance at a line, from the backtest against the close.

v2's raw chance is a normal curve around its own number. Against the 2024-25
closing lines the side it favoured won about half the time whatever the raw
number said, so a raw chance is shrunk toward 50%:

    calibrated = 50% + k * (raw - 50%)

k is fit by log-likelihood on data/model/backtest-v2.json (the scoreboard's
cached walk-forward) per league and market, and copied into
scripts/pricing.py CALIBRATION. Rerun after a season and update the constants
in the same commit. Player props have no graded history against a line yet.

Usage: python scripts/calibrate.py
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_v2

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data' / 'model' / 'backtest-v2.json'


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def samples(rows):
    """(league, market) -> [(raw chance of the side v2 favoured, whether it beat the close)]."""
    out = defaultdict(list)
    for r in rows:
        if r.get('model') != model_v2.VERSION:
            continue
        params = model_v2.PARAMS[r['league']]
        for market, mean, close, actual, sd in (('spread', r['margin'], r['closeMargin'], r['actualMargin'], params['sdMargin']),
                                                ('total', r['total'], r['closeTotal'], r['actualTotal'], params['sdTotal'])):
            if None in (mean, close, actual) or actual == close:
                continue
            raw = 1 - phi((close - mean) / sd)      # chance the home side, or the over, beats the close
            high = raw >= 0.5
            out[(r['league'], market)].append((raw if high else 1 - raw, (actual > close) == high))
    return out


def fit(data, steps=100):
    """The k in [0, 1] that maximises the log-likelihood of the outcomes."""
    def loglik(k):
        return sum(math.log(max(1e-9, p if won else 1 - p)) for c, won in data for p in [0.5 + k * (c - 0.5)])
    return max((i / steps for i in range(steps + 1)), key=loglik)


def main():
    rows = json.loads(CACHE.read_text(encoding='utf-8'))['rows']
    print('calibrated = 50% + k * (raw - 50%), fit on', CACHE.relative_to(ROOT))
    for (league, market), data in sorted(samples(rows).items()):
        k = fit(data)
        won = sum(w for _, w in data) / len(data)
        print(f'{league} {market:<6} n={len(data):>5}  won {100 * won:.1f}% against the close  k={k:.2f}  '
              f'(raw 70% reads as {100 * (0.5 + k * 0.2):.1f}%)')


if __name__ == '__main__':
    main()
