import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import prop_lines
import scoreboard as sb


def game(home_points=27, away_points=20, spread=-3.0, total=44.5, open_spread=-2.5, week=1, season_type=2):
    market = {'close': {'spread': spread, 'total': total}, 'open': {'spread': open_spread, 'total': total}}
    return {'league': 'NFL', 'eventId': '1', 'season': 2026, 'week': week, 'seasonType': season_type,
            'kickoff': '2026-09-13T17:00Z', 'home': {'id': 'H', 'abbreviation': 'H', 'score': home_points},
            'away': {'id': 'A', 'abbreviation': 'A', 'score': away_points}, 'market': market, 'players': []}


class GradingTests(unittest.TestCase):
    def test_a_forecast_takes_the_side_it_disagrees_with_the_close_on(self):
        row = sb.grade(game(), margin=5.0, total=41.0)
        self.assertEqual((row['closeMargin'], row['side'], row['ou']), (3.0, 'W', 'L'))
        self.assertEqual(sb.grade(game(), margin=1.0, total=50)['side'], 'L')
        self.assertIsNone(sb.grade(game(), margin=3.0, total=44.5)['side'], 'agreeing with the close takes no side')
        self.assertEqual(sb.grade(game(home_points=23, away_points=20), margin=5.0, total=41)['side'], 'P')

    def test_closer_than_the_close_and_market_movement_toward_the_model(self):
        row = sb.grade(game(), margin=6.0, total=46.0)
        self.assertTrue(row['closerMargin'])                   # 1 point off vs 4
        self.assertTrue(row['movedToward'])                    # opened 2.5, closed 3, model 6
        self.assertFalse(sb.grade(game(), margin=1.0, total=46.0)['movedToward'])
        self.assertNotIn('movedToward', sb.grade(game(open_spread=-3.0), margin=6.0, total=46.0))

    def test_ranges_and_probabilities_are_scored_when_present(self):
        row = sb.grade(game(), margin=6.0, total=46.0, sd=13.0, home_prob=0.7)
        self.assertTrue(row['within80'])
        self.assertAlmostEqual(row['brier'], 0.09)
        self.assertNotIn('brier', sb.grade(game(20, 20), 6.0, 46.0, 13.0, 0.7), 'a tie has no winner to score')

    def test_summaries_count_records_and_misses_by_week(self):
        rows = [sb.row_for(game(week=w), 'v2.0', None, sb.grade(game(week=w), m, 44.0)) for w, m in ((1, 5), (1, 1), (2, 5))]
        grouped = sb.group(rows)
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]['summary']['side'], [2, 1, 0])
        self.assertEqual([w['week'] for w in grouped[0]['weeks']], ['1', '2'])
        self.assertEqual(grouped[0]['summary']['marginMiss'], round((2 + 6 + 2) / 3, 2))

    def test_timestamps_compare_as_instants_not_text(self):
        self.assertFalse(sb.before('2026-09-18T00:15:00Z', '2026-09-18T00:15Z'))
        self.assertTrue(sb.before('2026-09-18T00:14:59Z', '2026-09-18T00:15Z'))


class PickTests(unittest.TestCase):
    def test_prop_titles_parse_into_direction_line_and_market(self):
        self.assertEqual(sb.parse_prop({'title': 'Jahmyr Gibbs OVER 29.5 receiving yards'}), ('OVER', 29.5, 'recYds'))
        self.assertEqual(sb.parse_prop({'title': 'Patrick Mahomes UNDER 21.5 completions'}), ('UNDER', 21.5, 'cmp'))
        self.assertIsNone(sb.parse_prop({'title': 'Anytime touchdown: someone'}))

    def test_clv_is_positive_when_the_posted_number_beat_the_last_pregame_line(self):
        g = game()
        g['players'] = [{'id': '9', 'name': 'Jahmyr Gibbs', 'team': 'H'}]
        report = {'league': 'NFL', 'publishedAt': '2026-09-12T12:00:00Z'}
        over = {'id': 'p1', 'title': 'Jahmyr Gibbs OVER 29.5 receiving yards', 'gameIds': ['NFL-1'], 'status': 'active'}
        under = {'id': 'p2', 'title': 'Jahmyr Gibbs UNDER 33.5 receiving yards', 'gameIds': ['NFL-1'], 'status': 'active'}
        observations = {('NFL-1', '9', 'recYds'): [('2026-09-13T14:00:00Z', 31.5, -110, 'OVER', 'DraftKings', 'x'),
                                                   ('2026-09-13T18:00:00Z', 40.5, -110, 'OVER', 'DraftKings', 'late')]}
        rows = {r['id']: r for r in sb.pick_rows([('r.json', {**report, 'props': [over, under]})],
                                                 {'NFL-1': g}, {}, observations)}
        self.assertEqual((rows['p1']['closeLine'], rows['p1']['clv']), (31.5, 2.0), 'an observation after kickoff is ignored')
        self.assertEqual(rows['p2']['clv'], 2.0)
        self.assertEqual(rows['p1']['minutesBeforeKickoff'], 180)

    def test_spread_and_total_picks_use_the_espn_close(self):
        report = {'league': 'NFL', 'publishedAt': '2026-09-12T12:00:00Z'}
        picks = [{'id': 's', 'title': 'H -2.5', 'marketType': 'spread', 'direction': 'home', 'line': -2.5, 'gameIds': ['NFL-1']},
                 {'id': 'a', 'title': 'A +3.5', 'marketType': 'spread', 'direction': 'away', 'line': 3.5, 'gameIds': ['NFL-1']},
                 {'id': 't', 'title': 'Under 46.5', 'marketType': 'total', 'direction': 'under', 'line': 46.5, 'gameIds': ['NFL-1']}]
        rows = {r['id']: r for r in sb.pick_rows([('r.json', {**report, 'gamePicks': picks})], {'NFL-1': game()}, {}, {})}
        self.assertEqual(rows['s']['clv'], 0.5)   # took -2.5, closed -3
        self.assertEqual(rows['a']['clv'], 0.5)   # took +3.5, closed +3
        self.assertEqual(rows['t']['clv'], 2.0)   # took under 46.5, closed 44.5


class PropLineTests(unittest.TestCase):
    def item(self, athlete, name, current, opening=None):
        return {'athlete': {'$ref': f'/athletes/{athlete}'}, 'type': {'name': name},
                'current': {'target': {'value': current}}, 'open': {'target': {'value': opening or current}}}

    def test_main_lines_are_kept_and_disagreeing_ladders_dropped(self):
        payload = {'items': [
            self.item(1, 'Total Receiving Yards (incl. overtime)', 55.5, 52.5),
            self.item(1, 'Total Receiving Yards (incl. overtime)', 55.5, 52.5),  # the other side, same numbers
            self.item(2, 'Total Rushing Yards (incl. overtime)', 60.5),
            self.item(2, 'Total Rushing Yards (incl. overtime)', 70.5),          # an alternate: ambiguous
            self.item(3, 'Receiving Yards Milestones', 50),
            self.item(3, 'Total Receptions (incl. overtime)', 4.5)]}
        self.assertEqual(prop_lines.parse(payload), {'1': {'recYds': [55.5, 52.5]}, '3': {'rec': [4.5, 4.5]}})


if __name__ == '__main__':
    unittest.main()
