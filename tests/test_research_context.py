import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('context', Path(__file__).resolve().parents[1] / 'scripts/research_context.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContextTests(unittest.TestCase):
    def payload(self, status='Questionable'):
        return {'injuries': [{'id': '1', 'displayName': 'Team', 'injuries': [{'status': status, 'athlete': {'id': '9', 'displayName': 'Player', 'position': {'abbreviation': 'OT'}}}]}]}

    def test_changes_and_missing_players_do_not_imply_health(self):
        first = module.normalize(self.payload(), 'NFL', '2026-09-17T00:00:00Z')
        self.assertEqual(first['changes'], [])
        second = module.normalize(self.payload('Out'), 'NFL', '2026-09-17T01:00:00Z', first)
        self.assertEqual(second['changes'][0]['from'], 'Questionable')
        self.assertEqual(second['teams']['1']['players'][0]['position'], 'OT')
        absent = module.normalize({'injuries': []}, 'NFL', '2026-09-17T02:00:00Z', second)
        self.assertEqual(absent['changes'], second['changes'])

    def test_failed_refresh_preserves_success_time_and_records_failure(self):
        old = module.normalize(self.payload(), 'NFL', '2026-09-17T00:00:00Z')
        def fail(url):
            raise OSError('unavailable')
        new = module.refresh({'leagues': {'NFL': old}}, fail, '2026-09-17T01:00:00Z')['leagues']['NFL']
        self.assertEqual(new['status'], 'failed')
        self.assertEqual(new['checkedAt'], old['checkedAt'])
        self.assertEqual(new['teams'], old['teams'])
        self.assertNotEqual(new['lastAttemptAt'], new['checkedAt'])

    def test_provider_player_link_supplies_missing_athlete_id(self):
        payload = self.payload()
        athlete = payload['injuries'][0]['injuries'][0]['athlete']
        del athlete['id']
        athlete['links'] = [{'rel': ['playercard'], 'href': 'https://www.espn.com/nfl/player/_/id/123/player'}]
        result = module.normalize(payload, 'NFL', '2026-09-17')
        self.assertEqual(result['teams']['1']['players'][0]['id'], '123')

    def test_malformed_payload_fails_closed(self):
        with self.assertRaises(ValueError):
            module.normalize({}, 'NFL', '2026-09-17')


class LedgerTests(unittest.TestCase):
    def test_revised_market_cannot_regrade_original(self):
        from refresh import validate_ledger
        reports = [{'league': 'NFL', 'publishedAt': '2026-09-01', 'props': [{'id': 'a', 'title': 'Over 50.5'}]}, {'league': 'NFL', 'publishedAt': '2026-09-02', 'props': [{'id': 'a', 'title': 'Over 40.5'}]}]
        with self.assertRaisesRegex(AssertionError, 'Original title'):
            validate_ledger(reports)
        reports[1]['props'][0] = {'id': 'a', 'title': 'Over 50.5', 'favorite': True}
        with self.assertRaisesRegex(AssertionError, 'Favorite changed'):
            validate_ledger(reports)
