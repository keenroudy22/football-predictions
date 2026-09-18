"""Freeze the published record.

Builds a hash per immutable record: every pick at its FIRST publication, every
settled outcome, and every baseline forecast. `python scripts/integrity.py`
rewrites the ledger; the test suite compares against it and fails on any change.

New records may be appended freely. An existing record may never change or
disappear. This is deliberately stricter than validate_ledger in refresh.py,
which leaves projection, odds, confidence, book and cutoff mutable across
revisions of the same pick id.
"""
import glob
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, 'tests', 'integrity-ledger.json')

# Frozen at first publication. A later report may add fields, never rewrite these.
PICK_FIELDS = ('league', 'kind', 'title', 'gameId', 'gameIds', 'player', 'athleteId',
               'line', 'direction', 'marketType', 'marketTitle', 'lineLabel', 'favorite',
               'book', 'odds', 'quotedAt', 'projection', 'confidence', 'publishedAt')
# Frozen once a game is graded.
RESULT_FIELDS = ('result', 'actual', 'actualValue', 'settledAt', 'resultSource')
FORECAST_FIELDS = ('gameId', 'publishedAt', 'home', 'away', 'model', 'type',
                   'confidence', 'sparse')
PICK_KINDS = ('props', 'riskyProps', 'gamePicks', 'parlays', 'scores')


def digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode('utf-8')).hexdigest()[:16]


def reports(root=ROOT):
    out = []
    for path in sorted(glob.glob(os.path.join(root, 'research', '*.json'))):
        with open(path, encoding='utf-8') as handle:
            out.append((os.path.basename(path), json.load(handle)))
    # First publication wins, so order by the report's own timestamp then filename.
    return sorted(out, key=lambda item: (item[1].get('publishedAt') or '', item[0]))


def build(root=ROOT):
    picks, results, seen = {}, {}, set()
    for name, report in reports(root):
        league, published = report.get('league'), report.get('publishedAt')
        for kind in PICK_KINDS:
            for pick in report.get(kind) or []:
                key = pick.get('id')
                if not key:
                    continue
                ref = '%s:%s:%s' % (league, kind, key)
                if ref not in seen:
                    seen.add(ref)
                    frozen = {f: pick.get(f) for f in PICK_FIELDS if pick.get(f) is not None}
                    frozen.setdefault('league', league)
                    frozen.setdefault('publishedAt', published)
                    frozen['kind'] = kind
                    picks[ref] = {'digest': digest(frozen), 'firstReport': name}
                if pick.get('result') and ref not in results:
                    graded = {f: pick.get(f) for f in RESULT_FIELDS if pick.get(f) is not None}
                    results[ref] = {'digest': digest(graded), 'settledIn': name}

    forecasts = {}
    path = os.path.join(root, 'site', 'data', 'forecasts.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as handle:
            for row in json.load(handle):
                key = row.get('gameId')
                if key and key not in forecasts:
                    frozen = {f: row.get(f) for f in FORECAST_FIELDS if row.get(f) is not None}
                    forecasts[key] = {'digest': digest(frozen)}

    return {'version': 1, 'picks': picks, 'results': results, 'forecasts': forecasts}


def load(path=LEDGER):
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def compare(current, saved):
    """Return a list of human-readable violations. Appending is always allowed."""
    problems = []
    for section in ('picks', 'results', 'forecasts'):
        was, now = (saved or {}).get(section, {}), current.get(section, {})
        for key, record in was.items():
            if key not in now:
                problems.append('%s: %s disappeared from the published record' % (section, key))
            elif now[key]['digest'] != record['digest']:
                problems.append('%s: %s was changed after publication' % (section, key))
    return problems


def main():
    ledger = build()
    with open(LEDGER, 'w', encoding='utf-8') as handle:
        json.dump(ledger, handle, indent=1, sort_keys=True)
        handle.write('\n')
    print('Froze %d picks, %d settled results, %d forecasts -> %s'
          % (len(ledger['picks']), len(ledger['results']), len(ledger['forecasts']),
             os.path.relpath(LEDGER, ROOT)))


if __name__ == '__main__':
    main()
