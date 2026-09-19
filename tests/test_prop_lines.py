import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import boxscores
import prop_lines

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
ATHLETE = 'http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/{}?lang=en'


def item(athlete, market, current, opening=None):
    return {'athlete': {'$ref': ATHLETE.format(athlete)}, 'type': {'name': market},
            'current': {'target': {'value': current}}, 'open': {'target': {'value': opening}}}


def game(event, kickoff, state='pre', league='NFL'):
    return {'id': f'{league}-{event}', 'league': league, 'state': state, 'season': 2026, 'kickoff': kickoff}


class ParseTests(unittest.TestCase):
    def test_a_main_line_listed_once_per_side_is_one_line(self):
        board = {'items': [item('1', 'Total Receiving Yards', 81.5, 79.5), item('1', 'Total Receiving Yards', 81.5, 79.5),
                           item('1', 'Total Receptions (incl. overtime)', 6.5)]}
        self.assertEqual(prop_lines.parse(board), {'1': {'recYds': [81.5, 79.5], 'rec': [6.5, None]}})

    def test_disagreeing_numbers_are_a_ladder_and_are_dropped(self):
        board = {'items': [item('1', 'Total Receiving Yards', 81.5), item('1', 'Total Receiving Yards', 99.5),
                           item('2', 'Anytime Touchdown Scorer', 1), item('3', 'Total Carries', 'OFF')]}
        self.assertEqual(prop_lines.parse(board), {})


class CaptureTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.board = {'items': [item('1', 'Total Receiving Yards', 81.5, 79.5)]}

    def stored(self):
        return [line for path in sorted(self.root.glob('*.jsonl')) for line in boxscores.read_store(path)]

    def test_only_upcoming_nfl_games_inside_the_window_are_read(self):
        slate = {'games': [game('1', '2026-09-20T17:00:00Z'), game('2', '2026-09-20T11:00:00Z'),
                           game('3', '2026-09-20T17:00:00Z', state='in'), game('4', '2026-09-20T17:00:00Z', league='CFB'),
                           game('5', '2026-09-24T17:00:00Z')]}
        asked = []
        written, problems = prop_lines.capture(slate, NOW, fetch=lambda url: asked.append(url) or self.board, root=self.root)
        self.assertEqual(list(written), ['NFL-1'])
        self.assertEqual(len(asked), 1)
        self.assertEqual(problems, [])

    def test_an_unchanged_board_is_not_appended_again(self):
        slate = {'games': [game('1', '2026-09-20T17:00:00Z')]}
        prop_lines.capture(slate, NOW, fetch=lambda url: self.board, root=self.root)
        later = NOW + timedelta(hours=2)
        written, _ = prop_lines.capture(slate, later, fetch=lambda url: self.board, root=self.root)
        self.assertEqual(written, {})
        self.assertEqual(len(self.stored()), 1)

    def test_a_board_is_stamped_when_fetched_and_dropped_if_that_is_after_kickoff(self):
        slate = {'games': [game('1', '2026-09-20T17:00:00Z'), game('2', '2026-09-20T12:30:00Z')]}
        clock = iter([datetime(2026, 9, 20, 12, 10, tzinfo=timezone.utc), datetime(2026, 9, 20, 12, 30, tzinfo=timezone.utc)])
        written, problems = prop_lines.capture(slate, NOW, fetch=lambda url: self.board, root=self.root,
                                               clock=lambda: next(clock))
        self.assertEqual(list(written), ['NFL-1'])
        self.assertEqual(self.stored()[0]['retrievedAt'], '2026-09-20T12:10:00Z')
        self.assertEqual(problems, ['NFL-2: kicked off before the board was read'])


if __name__ == '__main__':
    unittest.main()
