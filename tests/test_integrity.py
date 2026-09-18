import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))

import integrity


class LedgerTests(unittest.TestCase):
    def test_published_record_is_unchanged(self):
        """The published record must never change. Fails loudly if it did.

        To add new picks or forecasts, run: python scripts/integrity.py
        Only do that when the diff shows additions. A changed or missing
        record means a past prediction, price or outcome was rewritten.
        """
        saved = integrity.load()
        self.assertIsNotNone(saved, 'tests/integrity-ledger.json is missing. Run python scripts/integrity.py')
        problems = integrity.compare(integrity.build(), saved)
        self.assertEqual(problems, [], 'The published record changed:\n  ' + '\n  '.join(problems))

    def test_ledger_covers_every_settled_pick(self):
        ledger = integrity.build()
        self.assertTrue(ledger['picks'], 'no picks were frozen')
        for ref in ledger['results']:
            self.assertIn(ref, ledger['picks'], '%s has a result but no frozen pick' % ref)

    def test_appending_a_new_pick_is_allowed(self):
        saved = integrity.build()
        current = json.loads(json.dumps(saved))
        current['picks']['NFL:props:brand-new'] = {'digest': 'abc123', 'firstReport': 'new.json'}
        current['forecasts']['NFL-999'] = {'digest': 'def456'}
        self.assertEqual(integrity.compare(current, saved), [])

    def test_rewriting_a_projection_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'research'))
            first = {'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                     'props': [{'id': 'p1', 'title': 'X OVER 1.5', 'projection': 2.0, 'odds': -110}]}
            self._write(root, '2026-09-01-a.json', first)
            saved = integrity.build(root)

            revised = json.loads(json.dumps(first))
            revised['props'][0]['projection'] = 9.9
            self._write(root, '2026-09-01-a.json', revised)
            problems = integrity.compare(integrity.build(root), saved)
            self.assertEqual(len(problems), 1)
            self.assertIn('changed after publication', problems[0])

    def test_a_later_report_cannot_alter_the_first_publication(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'research'))
            self._write(root, '2026-09-01-a.json', {
                'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                'props': [{'id': 'p1', 'title': 'X OVER 1.5', 'odds': -110, 'projection': 2.0}]})
            saved = integrity.build(root)
            # A revision publishes the same id with a friendlier price.
            self._write(root, '2026-09-02-b.json', {
                'league': 'NFL', 'publishedAt': '2026-09-02T12:00:00Z',
                'props': [{'id': 'p1', 'title': 'X OVER 1.5', 'odds': +140, 'projection': 2.0}]})
            self.assertEqual(integrity.compare(integrity.build(root), saved), [],
                             'a later revision must not disturb the frozen first publication')

    def test_deleting_a_settled_result_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'research'))
            graded = {'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                      'props': [{'id': 'p1', 'title': 'X OVER 1.5', 'result': 'loss', 'actual': '0'}]}
            self._write(root, '2026-09-01-a.json', graded)
            saved = integrity.build(root)

            os.remove(os.path.join(root, 'research', '2026-09-01-a.json'))
            problems = integrity.compare(integrity.build(root), saved)
            self.assertTrue(any('disappeared' in p for p in problems), problems)

    def test_flipping_a_loss_to_a_win_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'research'))
            graded = {'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                      'props': [{'id': 'p1', 'title': 'X OVER 1.5', 'result': 'loss', 'actual': '0'}]}
            self._write(root, '2026-09-01-a.json', graded)
            saved = integrity.build(root)

            graded['props'][0]['result'] = 'win'
            self._write(root, '2026-09-01-a.json', graded)
            problems = integrity.compare(integrity.build(root), saved)
            self.assertTrue(any('results:' in p and 'changed' in p for p in problems), problems)

    def _write(self, root, name, payload):
        with open(os.path.join(root, 'research', name), 'w', encoding='utf-8') as handle:
            json.dump(payload, handle)


if __name__ == '__main__':
    unittest.main()
