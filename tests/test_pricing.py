import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pricing

SNAPSHOT = {'gameId': 'NFL-1', 'model': 'v2.0', 'publishedAt': '2026-09-20T10:00:00Z', 'kickoff': '2026-09-20T17:00:00Z',
            'margin': 3.0, 'total': 44.0, 'sd': {'margin': 13.0, 'total': 12.0},
            'range80': {'margin': [-13.7, 19.7], 'total': [28.6, 59.4]},
            'players': {'home': {'players': [{'id': '10', 'pos': 'WR', 'recYds': [60.0, 30.5, 89.5],
                                              'receptions': [5.0, 2.4, 7.6]}]}, 'away': None}}


class ArithmeticTests(unittest.TestCase):
    def test_a_line_at_the_mean_is_a_coin_flip(self):
        over, push, under = pricing.chances(44.0, 12.0, 44.5)
        self.assertAlmostEqual(over, 0.4834, places=3)
        self.assertEqual(push, 0.0)
        self.assertAlmostEqual(over + under, 1.0)

    def test_whole_number_lines_can_push(self):
        over, push, under = pricing.chances(3.0, 13.0, 3)
        self.assertAlmostEqual(push, 0.0307, places=3)
        self.assertAlmostEqual(over, under, places=6)

    def test_prices(self):
        self.assertAlmostEqual(pricing.break_even(-110), 110 / 210)
        self.assertAlmostEqual(pricing.break_even(150), 0.4)
        self.assertEqual(pricing.payout(-125), 0.8)
        self.assertEqual(pricing.worse_price(-110), -125)
        self.assertEqual(pricing.worse_price(110), -105, 'fifteen cents from +110 crosses even money')
        self.assertEqual(pricing.worse_price(120), 105)


class PriceTests(unittest.TestCase):
    def test_a_player_market_uses_the_stored_range(self):
        p = pricing.price(SNAPSHOT, 'recYds', 'over', 55.5, -115, athlete='10')
        self.assertEqual(p['projection'], 60.0)
        self.assertAlmostEqual(p['sd'], 29.5 / pricing.Z80, places=2)
        self.assertAlmostEqual(p['chance'], 0.5, delta=0.1)
        self.assertEqual(p['breakEven'], round(115 / 215, 3))
        self.assertIn('not calibrated at this line', p['edge'])
        self.assertEqual(p['cutoff'], 'OVER 55.5 at -115 or better. Closed to new entries at 56+, or at -130 or worse at 55.5.')
        self.assertEqual(pricing.price(SNAPSHOT, 'receptions', 'under', 4.5, 120, athlete='10')['market'], 'rec')

    def test_home_and_away_spreads_are_the_same_game(self):
        home = pricing.price(SNAPSHOT, 'spread', 'home', -2.5, -110)
        away = pricing.price(SNAPSHOT, 'spread', 'away', 2.5, -110)
        self.assertAlmostEqual(home['chance'] + away['chance'], 1.0, places=3)
        self.assertGreater(home['chance'], 0.5)
        self.assertIn('if the line reaches -3', home['cutoff'])
        self.assertIn('on any move against it', pricing.price(SNAPSHOT, 'spread', 'away', 3, -110)['cutoff'])

    def test_bad_requests_are_refused(self):
        for args in (('spread', 'over', 3.5, -110, None), ('recYds', 'over', 55.5, -110, None),
                     ('recYds', 'over', 55.5, -110, '99'), ('kPts', 'over', 7.5, -110, '10')):
            with self.assertRaises(ValueError):
                pricing.price(SNAPSHOT, *args[:4], athlete=args[4])


class TierTests(unittest.TestCase):
    def test_board_tiers_follow_the_edge_and_a_thin_sample_never_reads_strong(self):
        self.assertEqual(pricing.tier(8.0), 'strong')
        self.assertEqual(pricing.tier(5.0), 'strong')
        self.assertEqual(pricing.tier(4.9), 'lean')
        self.assertEqual(pricing.tier(2.0), 'lean')
        self.assertEqual(pricing.tier(1.9), 'pass')
        self.assertEqual(pricing.tier(-3.0), 'pass')
        self.assertEqual(pricing.tier(19.6, thin=True), 'lean')
        self.assertIsNone(pricing.tier(None))

    def test_older_pick_titles_still_name_their_market(self):
        self.assertEqual(pricing.market_of({'title': 'Jahmyr Gibbs OVER 29.5 receiving yards'}), 'recYds')
        self.assertEqual(pricing.market_of({'market': 'rec', 'title': 'anything'}), 'rec')
        self.assertIsNone(pricing.market_of({'title': 'Anytime touchdown'}))


if __name__ == '__main__':
    unittest.main()
