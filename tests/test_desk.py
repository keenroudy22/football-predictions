import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import desk

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
SNAPSHOT = {'gameId': 'NFL-1', 'model': 'v2.0', 'publishedAt': '2026-09-20T10:00:00Z', 'kickoff': '2026-09-20T17:00:00Z',
            'margin': 3.0, 'total': 44.0, 'sd': {'margin': 13.0, 'total': 12.0},
            'range80': {'margin': [-13.7, 19.7], 'total': [28.6, 59.4]},
            'players': {'home': {'players': [{'id': '10', 'pos': 'WR', 'recYds': [60.0, 30.5, 89.5],
                                              'receptions': [5.0, 2.4, 7.6]}]}, 'away': None}}


class ArithmeticTests(unittest.TestCase):
    def test_a_line_at_the_mean_is_a_coin_flip(self):
        over, push, under = desk.chances(44.0, 12.0, 44.5)
        self.assertAlmostEqual(over, 0.4834, places=3)
        self.assertEqual(push, 0.0)
        self.assertAlmostEqual(over + under, 1.0)

    def test_whole_number_lines_can_push(self):
        over, push, under = desk.chances(3.0, 13.0, 3)
        self.assertAlmostEqual(push, 0.0307, places=3)
        self.assertAlmostEqual(over, under, places=6)

    def test_prices(self):
        self.assertAlmostEqual(desk.break_even(-110), 110 / 210)
        self.assertAlmostEqual(desk.break_even(150), 0.4)
        self.assertEqual(desk.payout(-125), 0.8)
        self.assertEqual(desk.worse_price(-110), -125)
        self.assertEqual(desk.worse_price(110), -105, 'fifteen cents from +110 crosses even money')
        self.assertEqual(desk.worse_price(120), 105)


class PriceTests(unittest.TestCase):
    def test_a_player_market_uses_the_stored_range(self):
        p = desk.price(SNAPSHOT, 'recYds', 'over', 55.5, -115, athlete='10')
        self.assertEqual(p['projection'], 60.0)
        self.assertAlmostEqual(p['sd'], 29.5 / desk.Z80, places=2)
        self.assertAlmostEqual(p['chance'], 0.5, delta=0.1)
        self.assertEqual(p['breakEven'], round(115 / 215, 3))
        self.assertIn('not calibrated at this line', p['edge'])
        self.assertEqual(p['cutoff'], 'OVER 55.5 at -115 or better. Closed to new entries at 56+, or at -130 or worse at 55.5.')
        self.assertEqual(desk.price(SNAPSHOT, 'receptions', 'under', 4.5, 120, athlete='10')['market'], 'rec')

    def test_home_and_away_spreads_are_the_same_game(self):
        home = desk.price(SNAPSHOT, 'spread', 'home', -2.5, -110)
        away = desk.price(SNAPSHOT, 'spread', 'away', 2.5, -110)
        self.assertAlmostEqual(home['chance'] + away['chance'], 1.0, places=3)
        self.assertGreater(home['chance'], 0.5)
        self.assertIn('if the line reaches -3', home['cutoff'])
        self.assertIn('on any move against it', desk.price(SNAPSHOT, 'spread', 'away', 3, -110)['cutoff'])

    def test_bad_requests_are_refused(self):
        for args in (('spread', 'over', 3.5, -110, None), ('recYds', 'over', 55.5, -110, None),
                     ('recYds', 'over', 55.5, -110, '99'), ('kPts', 'over', 7.5, -110, '10')):
            with self.assertRaises(ValueError):
                desk.price(SNAPSHOT, *args[:4], athlete=args[4])


class EntryRuleTests(unittest.TestCase):
    def test_props_close_at_half_a_point_against(self):
        self.assertIsNotNone(desk.breaks('prop', 'over', 29.5, 30.0))
        self.assertIsNotNone(desk.breaks('prop', 'under', 4.5, 4.0))
        self.assertIsNone(desk.breaks('prop', 'over', 29.5, 28.5), 'a better number keeps the pick open')

    def test_totals_close_at_a_point_and_a_half(self):
        self.assertIsNone(desk.breaks('total', 'over', 44.5, 45.5))
        self.assertIsNotNone(desk.breaks('total', 'over', 44.5, 46.0))
        self.assertIsNotNone(desk.breaks('total', 'under', 44.5, 43.0))

    def test_spreads_close_onto_or_across_three_and_seven(self):
        closes = [(-2.5, -3), (-3, -3.5), (3.5, 3), (-6.5, -7.5), (7.5, 2.5)]
        stays = [(-3.5, -4.5), (-7.5, -9), (-2.5, -1.5), (3, 3.5), (4.5, 4)]
        for ours, now in closes:
            self.assertIsNotNone(desk.breaks('spread', 'home', ours, now), (ours, now))
        for ours, now in stays:
            self.assertIsNone(desk.breaks('spread', 'home', ours, now), (ours, now))

    def test_price_moves_count_in_cents_across_even_money(self):
        self.assertIsNotNone(desk.breaks('prop', 'over', 29.5, 29.5, -110, -125))
        self.assertIsNotNone(desk.breaks('prop', 'over', 29.5, 29.5, 105, -110))
        self.assertIsNone(desk.breaks('prop', 'over', 29.5, 29.5, 105, -105))
        self.assertIsNone(desk.breaks('prop', 'over', 29.5, 29.5, -120, -110))


class ScreenTests(unittest.TestCase):
    def test_the_screen_flags_fcs_games_and_thin_roles(self):
        game = {'id': 'CFB-1', 'league': 'CFB', 'state': 'pre', 'kickoff': '2026-09-20T17:00:00Z',
                'home': {'id': '1', 'abbreviation': 'OKST'}, 'away': {'id': '2', 'abbreviation': 'MUR'},
                'market': {'provider': 'Draft Kings', 'spread': '-56.5', 'spreadOdds': '-110', 'total': 70.5,
                           'overOdds': '-110', 'underOdds': '-110'}}
        snap = dict(SNAPSHOT, gameId='CFB-1', sparse=True, margin=29.1, total=55.4)
        text = desk.slate_screen('CFB', NOW, {'CFB-1': game}, {'CFB-1': [snap]}, {}, {}, fbs={'1'})
        self.assertIn('v2 favors away', text)
        self.assertIn('FCS thin', text)
        nfl = dict(game, id='NFL-1', league='NFL')
        board = {'retrievedAt': '2026-09-20T11:00:00Z', 'lines': {'10': {'recYds': [70.5, 70.5]}}}
        text = desk.slate_screen('NFL', NOW, {'NFL-1': nfl}, {'NFL-1': [dict(SNAPSHOT, gameId='NFL-1')]},
                                 {'NFL-1': [board]}, {'10': 'Player Ten'}, {'10': 1})
        self.assertRegex(text, r'Player Ten .* recYds .* under \d+\.\d%  g1')


class MoveTests(unittest.TestCase):
    def test_open_picks_are_checked_against_the_latest_number(self):
        games = {'NFL-1': {'id': 'NFL-1', 'league': 'NFL', 'kickoff': '2026-09-20T17:00:00Z', 'state': 'pre',
                           'home': {'abbreviation': 'DET'}, 'away': {'abbreviation': 'BUF'},
                           'market': {'provider': 'Draft Kings', 'spread': '-3.5', 'spreadOdds': '-110', 'total': 47.5,
                                      'overOdds': '-110', 'underOdds': '-110'}},
                 'NFL-2': {'id': 'NFL-2', 'league': 'NFL', 'kickoff': '2026-09-20T11:00:00Z', 'state': 'post'}}
        boards = {'NFL-1': [{'retrievedAt': '2026-09-20T11:30:00Z', 'lines': {'4429795': {'recYds': [31.5, 29.5]}}}]}
        picks = [{'id': 'gibbs', 'kind': 'props', 'gameId': 'NFL-1', 'athleteId': '4429795', 'line': 29.5,
                  'direction': 'OVER', 'odds': -115, 'title': 'Jahmyr Gibbs OVER 29.5 receiving yards'},
                 {'id': 'det', 'kind': 'gamePicks', 'gameId': 'NFL-1', 'marketType': 'spread', 'direction': 'home',
                  'line': -2.5, 'odds': -110},
                 {'id': 'under', 'kind': 'gamePicks', 'gameId': 'NFL-1', 'marketType': 'total', 'direction': 'under',
                  'line': 48.5, 'odds': -110},
                 {'id': 'settled', 'kind': 'props', 'gameId': 'NFL-1', 'result': 'win'},
                 {'id': 'started', 'kind': 'props', 'gameId': 'NFL-2', 'line': 5.5, 'direction': 'over'}]
        rows = {r['id']: r for r in desk.moves(picks, games, boards, NOW)}
        self.assertEqual(sorted(rows), ['det', 'gibbs', 'under'])
        self.assertIn('moved 2 against', rows['gibbs']['breaks'])
        self.assertIn('onto or across 3 or 7', rows['det']['breaks'])
        self.assertIsNone(rows['under']['breaks'], 'the total fell only 1 point')


if __name__ == '__main__':
    unittest.main()
