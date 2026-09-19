import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import boxscores
import nflverse

NOW = datetime(2026, 9, 18, 21, 0, tzinfo=timezone.utc)
SCHEDULE = {'game_id': '2026_01_NE_SEA', 'season': '2026', 'game_type': 'REG', 'week': '1', 'espn': '401872656',
            'home_team': 'SEA', 'away_team': 'NE', 'home_score': '13', 'away_score': '10', 'roof': 'outdoors',
            'surface': 'fieldturf', 'temp': '74', 'wind': '6', 'home_rest': '7', 'away_rest': '7', 'div_game': '0',
            'home_qb_name': 'Sam Darnold', 'away_qb_name': 'Drake Maye'}


def record(players=()):
    return {'league': 'NFL', 'eventId': '401872656', 'season': 2026, 'kickoff': '2026-09-10T00:20Z',
            'home': {'id': '26', 'score': 13}, 'away': {'id': '17', 'score': 10}, 'players': list(players),
            'quality': {'plays': 'ok'}, 'sources': {'page': 'https://www.espn.com/nfl/boxscore/_/gameId/401872656'}}


def snap(player, pfr, team, position, snaps, pct):
    return {'game_id': '2026_01_NE_SEA', 'player': player, 'pfr_player_id': pfr, 'team': team,
            'position': position, 'offense_snaps': str(snaps), 'offense_pct': str(pct)}


ROWS = [snap('Drake Maye', 'MayeDr00', 'NE', 'QB', 71, 1), snap('Mike Onwenu', 'OnweMi00', 'NE', 'G', 71, 1),
        snap('Rhamondre Stevenson', 'StevRh00', 'NE', 'RB', 60, 0.85),
        snap('Kayshon Boutte Jr.', 'BoutKa00', 'NE', 'WR', 40, 0.56), snap('Practice Squad', 'PracSq00', 'NE', 'WR', 3, 0.04),
        snap('Sam Darnold', 'DarnSa00', 'SEA', 'QB', 50, 1), snap('Jaxon Smith-Njigba', 'SmitJa05', 'SEA', 'WR', 0, 0)]
CROSSWALK = {'MayeDr00': '4431452', 'StevRh00': '4569173', 'DarnSa00': '3912547'}
BOX_PLAYERS = [{'id': '4432588', 'team': '17', 'name': 'Kayshon Boutte'}]


class BuildTests(unittest.TestCase):
    def line(self, rows=ROWS, schedule=SCHEDULE):
        return nflverse.build(rows, schedule, record(BOX_PLAYERS), CROSSWALK, {'snaps': 'https://x'}, '2026-09-18T21:00:00Z')

    def test_players_are_matched_by_crosswalk_then_by_name_and_never_guessed(self):
        players = {p['pfr']: p for p in self.line()['players']}
        self.assertEqual(players['MayeDr00']['id'], '4431452')
        self.assertEqual((players['BoutKa00']['id'], players['BoutKa00']['matchedBy']), ('4432588', 'name'))
        self.assertNotIn('id', players['PracSq00'], 'no ESPN ID is invented for an unmatched player')
        self.assertEqual(self.line()['quality'], {'crosswalk': 3, 'name': 1, 'unmatched': 1})

    def test_linemen_count_toward_team_snaps_but_only_skill_players_are_listed(self):
        line = self.line()
        self.assertEqual(line['teams'], {'17': {'snaps': 71}, '26': {'snaps': 50}})
        self.assertNotIn('OnweMi00', {p['pfr'] for p in line['players']})
        self.assertNotIn('SmitJa05', {p['pfr'] for p in line['players']}, 'zero offensive snaps is not a snap line')

    def test_teams_map_through_the_verified_final_and_context_is_kept(self):
        line = self.line()
        self.assertEqual({p['pfr']: p['team'] for p in line['players']}['DarnSa00'], '26')
        self.assertEqual(line['context'], {'roof': 'outdoors', 'surface': 'fieldturf', 'temp': 74, 'wind': 6,
                                           'homeRest': 7, 'awayRest': 7, 'divisional': False,
                                           'homeQB': 'Sam Darnold', 'awayQB': 'Drake Maye'})
        with self.assertRaisesRegex(ValueError, 'finals disagree'):
            self.line(schedule={**SCHEDULE, 'home_score': '14'})

    def test_name_keys_ignore_suffixes_and_punctuation(self):
        self.assertEqual(nflverse.name_key('D.K. Metcalf Jr.'), nflverse.name_key('DK Metcalf'))
        self.assertNotEqual(nflverse.name_key('Josh Allen'), nflverse.name_key('Josh Allan'))


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root, self.box = Path(self.dir.name) / 'nflverse', Path(self.dir.name) / 'box'
        boxscores.append(self.box / 'nfl-2026.jsonl', [record(BOX_PLAYERS)])
        self.rows = [dict(r) for r in ROWS]

    def tearDown(self):
        self.dir.cleanup()

    def fetch(self, url):
        if url == nflverse.GAMES:
            return [SCHEDULE]
        if url == nflverse.PLAYERS:
            return [{'pfr_id': k, 'espn_id': v + '.0'} for k, v in CROSSWALK.items()]
        if 'snap_counts_2026' in url:
            return self.rows
        raise OSError('missing')

    def test_new_games_append_unchanged_games_do_not_and_changes_append_a_revision(self):
        self.assertEqual(nflverse.refresh([2026], self.fetch, NOW, self.root, self.box), ({'nfl-2026.jsonl': 1}, []))
        self.assertEqual(nflverse.refresh([2026], self.fetch, NOW, self.root, self.box), ({}, []))
        self.rows[0]['offense_snaps'] = '70'
        nflverse.refresh([2026], self.fetch, NOW, self.root, self.box)
        lines = boxscores.read_store(self.root / 'nfl-2026.jsonl')
        self.assertEqual([l.get('revision', 1) for l in lines], [1, 2])
        self.assertEqual(lines[0]['players'][0]['snaps'], 71, 'the first line is untouched')

    def test_missing_seasons_and_games_are_reported_not_fatal(self):
        added, problems = nflverse.refresh([2025, 2026], self.fetch, NOW, self.root, self.box)
        self.assertEqual(added, {'nfl-2026.jsonl': 1})
        self.assertEqual(problems, ['2025: snap counts unavailable (OSError)'])
        self.rows = [dict(r, game_id='2026_01_XX_YY') for r in ROWS]
        self.assertIn('no stored ESPN box score', nflverse.refresh([2026], self.fetch, NOW, self.root, self.box)[1][0])

    def test_the_committed_snap_store_is_append_only(self):
        self.assertEqual(boxscores.verify(nflverse.STORE), [])


if __name__ == '__main__':
    unittest.main()
