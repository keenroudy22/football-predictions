import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import boxscores
import fakegames
import forecast
import test_projections

GAMES = test_projections.league(weeks=6)
NOW = forecast.features.when(GAMES[-1]['kickoff']) + timedelta(days=2)


def slate_game(event, kickoff, home='A', away='B'):
    return {'id': f'NFL-{event}', 'league': 'NFL', 'season': 2025, 'seasonType': 2, 'week': 7, 'state': 'pre',
            'timeValid': True, 'neutral': False, 'kickoff': fakegames.stamp(kickoff),
            'home': {'id': home, 'abbreviation': home}, 'away': {'id': away, 'abbreviation': away}}


class InjuryTests(unittest.TestCase):
    def test_only_fresh_out_ir_and_doubtful_entries_remove_a_player(self):
        def entry(pid, status, days_ago):
            return {'id': pid, 'status': status, 'reportedAt': fakegames.stamp(NOW - timedelta(days=days_ago))}
        context = {'leagues': {'NFL': {'teams': {'1': {'players': [
            entry('a', 'Out', 1), entry('b', 'Injured Reserve', 10), entry('c', 'Questionable', 1),
            entry('d', 'Doubtful', 2), entry('e', 'Out', 400), {'id': 'f', 'status': 'Out', 'reportedAt': 'garbage'}]}}}}}
        self.assertEqual(forecast.injuries(context, 'NFL', NOW), {'1': {'a': 'Out', 'b': 'Injured Reserve', 'd': 'Doubtful'}})
        self.assertEqual(forecast.injuries({}, 'CFB', NOW), {})


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.slate = {'games': [slate_game(801, NOW + timedelta(days=2)),
                                slate_game(802, NOW + timedelta(minutes=30), 'C', 'D'),
                                slate_game(803, NOW + timedelta(days=10), 'C', 'A')]}

    def tearDown(self):
        self.dir.cleanup()

    def publish(self, games=GAMES, context=None, now=NOW):
        return forecast.publish(now, self.root, self.slate, context or {}, {'NFL': games}, {}, log=lambda *_: None)

    def lines(self):
        return boxscores.read_store(self.root / 'nfl-2025.jsonl')

    def test_games_inside_the_hour_or_beyond_eight_days_get_no_forecast(self):
        self.assertEqual(self.publish(), {'nfl-2025.jsonl': 1})
        self.assertEqual([line['gameId'] for line in self.lines()], ['NFL-801'])

    def test_a_snapshot_is_pregame_and_carries_its_inputs_and_uncertainty(self):
        self.publish()
        line = self.lines()[0]
        self.assertLess(forecast.features.when(line['publishedAt']), forecast.features.when(line['kickoff']))
        self.assertEqual(line['inputs']['games'], len(GAMES))
        self.assertEqual(line['inputs']['through'], GAMES[-1]['kickoff'])
        low, high = line['range80']['margin']
        self.assertAlmostEqual((low + high) / 2, line['margin'], delta=0.1)
        self.assertAlmostEqual(line['home']['points'] - line['away']['points'], line['margin'], delta=0.2)
        self.assertTrue(line['why'] and line['model'] == forecast.model_v2.VERSION)
        self.assertIn('A-w1', {p['id'] for p in line['players']['home']['players']})

    def test_an_unchanged_forecast_is_not_republished_and_a_changed_one_supersedes(self):
        self.publish()
        self.assertEqual(self.publish(now=NOW + timedelta(hours=3)), {})
        ruled_out = {'leagues': {'NFL': {'teams': {'A': {'players': [
            {'id': 'A-w1', 'status': 'Out', 'reportedAt': fakegames.stamp(NOW)}]}}}}}
        self.assertEqual(self.publish(context=ruled_out, now=NOW + timedelta(hours=4)), {'nfl-2025.jsonl': 1})
        first, second = self.lines()
        self.assertEqual(second['supersedes'], first['publishedAt'])
        self.assertEqual(second['inputs']['ruledOut']['home'], ['A-w1'])
        self.assertNotIn('A-w1', {p['id'] for p in second['players']['home']['players']})

    def test_small_moves_are_not_material_but_real_ones_are(self):
        self.publish()
        base = self.lines()[0]
        nudged = {**base, 'margin': base['margin'] + 0.3, 'total': base['total'] - 0.4}
        self.assertFalse(forecast.material(nudged, base))
        self.assertTrue(forecast.material({**base, 'margin': base['margin'] + 0.6}, base))
        self.assertTrue(forecast.material({**base, 'model': 'v2.1'}, base))
        self.assertTrue(forecast.material({**base, 'kickoff': '2099-01-01T00:00Z'}, base), 'a moved kickoff republishes')

    def test_the_committed_forecast_store_is_append_only(self):
        self.assertEqual(boxscores.verify(forecast.STORE), [])


if __name__ == '__main__':
    unittest.main()
