import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_site
from fakegames import game

ROOT = Path(__file__).resolve().parents[1]


def slate_game(game_id, kickoff, state='pre', **market):
    return {'id': game_id, 'league': 'NFL', 'kickoff': kickoff, 'state': state, 'marketRetrievedAt': '2026-09-18T12:00:00Z',
            'home': {'id': '1', 'abbreviation': 'ATL'}, 'away': {'id': '2', 'abbreviation': 'CAR'},
            'market': {'provider': 'Draft Kings', 'spread': '-3.5', 'spreadOdds': '-112', 'spreadOpen': '-2.5',
                       'total': 44.5, 'totalOpen': 'o45.5', 'overOdds': '-108', 'underOdds': '-112', **market}}


class PickTests(unittest.TestCase):
    def test_board_rows_keep_the_first_published_price(self):
        reports = [{'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                    'props': [{'id': 'a', 'odds': -110, 'line': 60.5, 'gameIds': ['NFL-1']}]},
                   {'league': 'NFL', 'publishedAt': '2026-09-02T12:00:00Z',
                    'props': [{'id': 'a', 'odds': 120, 'line': 58.5, 'result': 'win', 'actual': 71}]}]
        first, latest = build_site.first_publications(reports)
        rows = build_site.board_picks(first, latest, {'NFL-1': {'kickoff': '2026-09-03T17:00:00Z'}}, {})
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['odds'], rows[0]['line'], rows[0]['result'], rows[0]['actual']), (-110, 60.5, 'win', 71))
        self.assertEqual(rows[0]['publishedAt'], '2026-09-01T12:00:00Z')
        self.assertEqual(rows[0]['kickoff'], '2026-09-03T17:00:00Z')

    def test_favorite_status_is_fixed_at_first_publication(self):
        reports = [{'league': 'NFL', 'publishedAt': '2026-09-01T12:00:00Z',
                    'props': [{'id': 'a', 'favorite': True}, {'id': 'b'}, {'id': 'w1-otton-rec'}]},
                   {'league': 'NFL', 'publishedAt': '2026-09-02T12:00:00Z',
                    'props': [{'id': 'a', 'favorite': False}, {'id': 'b', 'favorite': True}]}]
        rows = {r['id']: r for r in build_site.board_picks(*build_site.first_publications(reports), {}, {})}
        self.assertEqual({k: r['favorite'] for k, r in rows.items()}, {'a': True, 'b': False, 'w1-otton-rec': True})

    def test_the_published_record_flags_seven_favorites(self):
        reports = [json.loads(p.read_text(encoding='utf-8')) for p in sorted((ROOT / 'research').glob('*.json'))]
        rows = build_site.board_picks(*build_site.first_publications(reports), {}, {})
        favorites = sorted(r['id'] for r in rows if r['favorite'])
        self.assertEqual(len(favorites), 7, favorites)
        self.assertIn('NFL-2026-W2-gibbs-over-29-5-recyd-dk', favorites)
        self.assertNotIn('NFL-2026-W2-det-buf-volume-fun-sgp-dk', favorites)


class GameLineTests(unittest.TestCase):
    now = datetime(2026, 9, 19, 12, tzinfo=timezone.utc)

    def test_each_row_carries_the_price_quoted_for_that_side(self):
        rows = {r['id']: r for r in build_site.game_market_lines({'games': [slate_game('NFL-1', '2026-09-20T17:00:00Z')]},
                                                                  self.now)}
        self.assertEqual(sorted(rows), ['game-NFL-1-over', 'game-NFL-1-spread', 'game-NFL-1-under'])
        self.assertEqual((rows['game-NFL-1-spread']['title'], rows['game-NFL-1-spread']['odds']), ('ATL -3.5', -112))
        self.assertEqual((rows['game-NFL-1-over']['title'], rows['game-NFL-1-over']['odds']), ('CAR @ ATL over 44.5', -108))
        self.assertEqual((rows['game-NFL-1-under']['direction'], rows['game-NFL-1-under']['odds']), ('under', -112))

    def test_started_games_and_games_without_a_line_are_left_out(self):
        games = [slate_game('NFL-1', '2026-09-19T11:00:00Z'), slate_game('NFL-2', '2026-09-20T17:00:00Z', state='in'),
                 slate_game('NFL-3', '2026-09-20T17:00:00Z', spread=None, total=None)]
        self.assertEqual(build_site.game_market_lines({'games': games}, self.now), [])


class GradeTests(unittest.TestCase):
    snapshot = {'gameId': 'NFL-1', 'model': 'v2.0', 'publishedAt': '2026-09-19T10:00:00Z', 'margin': 5.0, 'total': 41.0,
                'sd': {'margin': 13.0, 'total': 12.0}, 'range80': {'margin': [-11.7, 21.7], 'total': [25.6, 56.4]},
                'players': {'home': {'players': [{'id': '10', 'pos': 'WR', 'recYds': [70.0, 40.5, 99.5]}]}}}

    def line(self, **extra):
        return {'state': 'open', 'odds': -110, 'line': 44.5, 'gameMarket': True, 'market': 'total points',
                'direction': 'under', **extra}

    def test_a_game_line_is_graded_with_the_desk_arithmetic(self):
        grade = build_site.grade_line(self.line(), self.snapshot, thin=False)
        self.assertEqual(grade['tier'], 'strong')
        self.assertGreater(grade['chance'], grade['needs'])
        self.assertEqual(grade['needs'], round(110 / 210, 3))
        spread = build_site.grade_line(self.line(market='point spread', line=-2.5, direction=None), self.snapshot, False)
        self.assertGreater(spread['chance'], 0.5, 'v2 has the home side by 5 against -2.5')

    def test_a_thin_sample_never_reads_strong_and_closed_or_unpriced_lines_get_no_grade(self):
        self.assertEqual(build_site.grade_line(self.line(), self.snapshot, thin=True)['tier'], 'lean')
        self.assertIsNone(build_site.grade_line(self.line(state='closed'), self.snapshot, False))
        self.assertIsNone(build_site.grade_line(self.line(odds=None), self.snapshot, False))
        self.assertIsNone(build_site.grade_line(self.line(), None, False))

    def test_a_prop_needs_a_v2_projection_for_that_player(self):
        prop = {'state': 'open', 'odds': -115, 'line': 55.5, 'direction': 'OVER', 'athleteId': '10',
                'title': 'Player Ten OVER 55.5 receiving yards'}
        self.assertEqual(build_site.grade_line(prop, self.snapshot, False)['projection'], 70.0)
        self.assertIsNone(build_site.grade_line(dict(prop, athleteId='99'), self.snapshot, False))


class ForecastTests(unittest.TestCase):
    def test_a_snapshot_published_after_kickoff_is_never_the_forecast(self):
        snaps = [{'publishedAt': '2026-09-20T12:00:00Z'}, {'publishedAt': '2026-09-20T16:30:00Z'}]
        self.assertEqual(build_site.pregame(snaps, '2026-09-20T17:00:00Z'), snaps)
        self.assertEqual(build_site.pregame(snaps, '2026-09-20T16:00:00Z'), snaps[:1])
        self.assertEqual(build_site.pregame(snaps, '2026-09-20T11:00:00Z'), [])

    def test_lean_is_model_margin_against_the_market_margin(self):
        market = {'spread': -3.0, 'total': 44.5}
        self.assertEqual(build_site.lean({'margin': 5.0, 'total': 42.0}, market), {'spread': 2.0, 'side': 'home', 'total': -2.5})
        self.assertEqual(build_site.lean({'margin': 1.0, 'total': 44.5}, market)['side'], 'away')
        self.assertIsNone(build_site.lean({'margin': 1.0, 'total': 44.5}, None))
        self.assertIsNone(build_site.lean({'margin': 3.0, 'total': 44.5}, market)['side'])


class TableTests(unittest.TestCase):
    def wr(self, pid, team, rec, yds):
        return {'id': pid, 'team': team, 'name': f'Player {pid}', 'pos': 'WR', 'rec': rec, 'recYds': yds, 'tgt': rec + 2}

    def test_player_rows_keep_the_log_layout_and_home_flags(self):
        records = [game('1', datetime(2025, 9, 7, 17, tzinfo=timezone.utc), 'A', 'B', 24, 17, players=[self.wr('10', 'A', 5, 70)]),
                   game('2', datetime(2025, 9, 14, 17, tzinfo=timezone.utc), 'B', 'A', 20, 13, players=[self.wr('10', 'A', 3, 30)]),
                   game('3', datetime(2025, 9, 21, 17, tzinfo=timezone.utc), 'A', 'C', 21, 20, neutral=True,
                        players=[self.wr('10', 'A', 8, 101)])]
        index, shards = build_site.build_players('NFL', records, {'3': {'10': (61, 0.92)}}, {('NFL', 'A'): {'abbr': 'AAA'}})
        self.assertEqual(index, [['10', 'Player 10', 'WR', 'A', 'AAA', '2025-09-21', 3]])
        rows = shards[10 % build_site.SHARDS['NFL']]['10']['rows']
        keys = list(build_site.LOG_KEYS)
        self.assertEqual([r[:8] for r in rows], [['1', '2025-09-07', 2025, 1, 2, 'A', 'B', 1],
                                                 ['2', '2025-09-14', 2025, 1, 2, 'A', 'B', 0],
                                                 ['3', '2025-09-21', 2025, 1, 2, 'A', 'C', -1]])
        self.assertEqual([r[8 + keys.index('recYds')] for r in rows], [70, 30, 101])
        self.assertEqual(rows[2][8 + keys.index('snaps')], 61)
        self.assertIsNone(rows[0][8 + keys.index('snapPct')], 'no snap count is unknown, not zero')

    def test_dates_are_eastern_calendar_dates(self):
        self.assertEqual(build_site.day('2026-09-18T00:15Z'), '2026-09-17')
        self.assertEqual(build_site.day('2026-12-01T01:15Z'), '2026-11-30')
        self.assertEqual(build_site.day('2026-09-13T17:00Z'), '2026-09-13')

    def test_defense_table_averages_regular_season_games_allowed(self):
        logs = {'A': [{'season': 2026, 'seasonType': 1, 'allowed': {'WR': {'recYds': 500}}},
                      {'season': 2026, 'seasonType': 2, 'allowed': {'WR': {'recYds': 150, 'rec': 12}}},
                      {'season': 2026, 'seasonType': 2, 'allowed': {'WR': {'recYds': 90, 'rec': 8}}},
                      {'season': 2025, 'seasonType': 2, 'allowed': {'WR': {'recYds': 10}}}]}
        table = build_site.defense_table('NFL', logs, 2026)
        self.assertEqual(table['A']['g'], 2)
        self.assertEqual((table['A']['WR']['recYds'], table['A']['WR']['rec']), (120.0, 10.0))
        self.assertEqual(table['A']['QB']['att'], 0.0)
        self.assertEqual(build_site.defense_table('NFL', logs, 2026, last=1)['A']['WR']['recYds'], 90.0)
        self.assertEqual(build_site.defense_table('NFL', logs, 2024), {})


if __name__ == '__main__':
    unittest.main()
