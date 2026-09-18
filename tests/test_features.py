import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import boxscores
import features as ft


def game(eid, kickoff, home='1', away='2', players=(), league='NFL', season=2025, neutral=False,
         scores=(24, 17), market=None, season_type=2):
    return {'eventId': eid, 'league': league, 'season': season, 'seasonType': season_type, 'week': 1,
            'kickoff': kickoff, 'neutral': neutral,
            'home': {'id': home, 'score': scores[0]}, 'away': {'id': away, 'score': scores[1]},
            'teams': {home: {'points': scores[0], 'yards': 350}, away: {'points': scores[1], 'yards': 280}},
            'players': list(players), 'market': market, 'quality': {'plays': 'ok'},
            'sources': {'page': f'https://www.espn.com/nfl/boxscore/_/gameId/{eid}'}}


def wr(pid, team, rec, yds, tgt=None, pos='WR', **extra):
    line = {'id': pid, 'team': team, 'name': f'Player {pid}', 'pos': pos, 'rec': rec, 'recYds': yds, **extra}
    if tgt is not None:
        line['tgt'] = tgt
    return line


class LogTests(unittest.TestCase):
    def test_player_log_is_chronological_with_home_away_and_neutral(self):
        records = [game('2', '2025-09-14T17:00Z', home='2', away='1', players=[wr('10', '1', 4, 50, 6)]),
                   game('1', '2025-09-07T17:00Z', players=[wr('10', '1', 7, 90, 9)]),
                   game('3', '2025-09-21T17:00Z', neutral=True, players=[wr('10', '1', 2, 20, 3)])]
        records.sort(key=lambda g: g['kickoff'])
        rows = ft.player_logs(records)['10']
        self.assertEqual([r['eventId'] for r in rows], ['1', '2', '3'])
        self.assertEqual([r['home'] for r in rows], [True, False, None])
        self.assertEqual([r['opp'] for r in rows], ['2', '2', '2'])
        self.assertEqual(rows[0]['stats'], {'rec': 7, 'recYds': 90, 'tgt': 9, 'targets': 9})
        self.assertTrue(rows[0]['source'].endswith('/1'))

    def test_a_forecast_cutoff_excludes_the_game_itself_and_later_games(self):
        records = [game('1', '2025-09-07T17:00Z', players=[wr('10', '1', 7, 90, 9)]),
                   game('2', '2025-09-14T17:00Z', players=[wr('10', '1', 4, 50, 6)])]
        self.assertEqual([r['eventId'] for r in ft.player_logs(records, before='2025-09-14T17:00Z')['10']], ['1'])
        self.assertEqual(ft.team_logs(records, before='2025-09-07T17:00Z'), {})

    def test_college_targets_fall_back_to_play_by_play_but_nfl_never_does(self):
        college = game('1', '2025-09-06T16:00Z', league='CFB', players=[wr('10', '1', 3, 30, pbpTgt=5)])
        pro = game('2', '2025-09-07T17:00Z', players=[wr('11', '1', 3, 30, pbpTgt=5)])
        logs = ft.player_logs([college, pro])
        self.assertEqual(logs['10'][0]['stats']['targets'], 5)
        self.assertNotIn('targets', logs['11'][0]['stats'], 'an NFL line without official targets stays unknown')

    def test_sacks_are_official_in_the_nfl_and_play_by_play_in_college(self):
        college_qb = {'id': '1', 'team': '1', 'pos': 'QB', 'att': 20, 'car': 8, 'pbpSacked': 2, 'pbpSackYds': 11}
        pro_qb = {'id': '2', 'team': '1', 'pos': 'QB', 'att': 30, 'sacked': 3, 'sackYds': 10, 'pbpSacked': 3}
        college = ft.player_logs([game('1', '2025-09-06T16:00Z', league='CFB', players=[college_qb, wr('10', '1', 3, 30)])])
        pro = ft.player_logs([game('2', '2025-09-07T17:00Z', players=[pro_qb])])
        self.assertEqual((college['1'][0]['stats']['sacks'], college['1'][0]['stats']['sackYds']), (2, 11))
        self.assertNotIn('sacks', college['10'][0]['stats'], 'a receiver has no sack line')
        self.assertEqual(pro['2'][0]['stats']['sacks'], 3)
        allowed = ft.defense_logs([game('1', '2025-09-06T16:00Z', league='CFB', home='2', away='1', players=[college_qb])])['2'][0]
        self.assertEqual(allowed['allowed']['QB']['sacks'], 2)

    def test_team_log_pairs_own_and_opponent_stats_with_the_close(self):
        close = {'spread': -3.0, 'total': 44.5}
        rows = ft.team_logs([game('1', '2025-09-07T17:00Z', market={'close': close})])
        home, away = rows['1'][0], rows['2'][0]
        self.assertEqual((home['pointsFor'], home['pointsAgainst'], home['offense'], home['defense']),
                         (24, 17, {'yards': 350}, {'yards': 280}))
        self.assertEqual((away['pointsFor'], away['home'], away['close']), (17, False, close))


class DefenseTests(unittest.TestCase):
    def test_a_defense_is_charged_what_each_opposing_position_group_produced(self):
        players = [wr('10', '2', 5, 70, 8), wr('11', '2', 2, 15, 3), wr('12', '2', 4, 40, 5, pos='TE'),
                   {'id': '13', 'team': '2', 'pos': 'FB', 'car': 2, 'rushYds': 5},
                   {'id': '14', 'team': '2', 'pos': 'RB', 'car': 15, 'rushYds': 60, 'rec': 1, 'recYds': 4, 'tgt': 2},
                   {'id': '15', 'team': '2', 'car': 1, 'rushYds': 3},
                   wr('20', '1', 9, 120, 12)]
        row = ft.defense_logs([game('1', '2025-09-07T17:00Z', players=players)])['1'][0]
        self.assertEqual(row['opp'], '2')
        self.assertEqual(row['allowed']['WR'], {'rec': 7, 'recYds': 85, 'targets': 11})
        self.assertEqual(row['allowed']['TE'], {'rec': 4, 'recYds': 40, 'targets': 5})
        self.assertEqual(row['allowed']['RB'], {'car': 17, 'rushYds': 65, 'rec': 1, 'recYds': 4, 'targets': 2})
        self.assertEqual(row['untagged'], 1, 'a player with no tag anywhere is counted, not assigned')
        self.assertEqual([p['id'] for p in row['players']['WR']], ['10', '11'])

    def test_a_missing_tag_uses_the_athletes_tag_from_other_games(self):
        records = [game('1', '2025-09-07T17:00Z', players=[wr('12', '2', 4, 40, 5, pos='TE')]),
                   game('2', '2025-09-14T17:00Z', players=[wr('12', '2', 3, 33, 4, pos=None)])]
        rows = ft.defense_logs(records)['1']
        self.assertEqual(rows[1]['allowed']['TE']['recYds'], 33)
        self.assertEqual(ft.player_logs(records)['12'][1]['posSource'], 'other games')

    def test_defense_table_ranks_fewest_allowed_first_over_a_recent_window(self):
        logs = {'A': [{'season': 2025, 'allowed': {'WR': {'recYds': v}}} for v in (300, 100, 100)],
                'B': [{'season': 2025, 'allowed': {'WR': {'recYds': v}}} for v in (50, 200, 200)]}
        self.assertEqual([(r['defense'], r['avg'], r['rank']) for r in ft.defense_table(logs, 'WR.recYds')],
                         [('B', 150.0, 1), ('A', 166.67, 2)])
        self.assertEqual([r['defense'] for r in ft.defense_table(logs, 'WR.recYds', last=2)], ['A', 'B'])


class SummaryTests(unittest.TestCase):
    def rows(self, values, **extra):
        return [{'eventId': str(i), 'kickoff': f'2025-09-{i + 1:02d}T17:00Z', 'home': i % 2 == 0, 'opp': str(i % 3),
                 'seasonType': 2, 'source': f'https://x/{i}', 'stats': {} if v is None else {'recYds': v, 'recLong': v},
                 **extra} for i, v in enumerate(values)]

    def test_windows_count_back_from_the_latest_game_and_report_true_samples(self):
        result = ft.form(self.rows([10, 20, 30, 40, 50, 60, 70]), 'recYds')
        self.assertEqual(result['last5'], {'n': 5, 'avg': 50.0, 'median': 50, 'min': 30, 'max': 70})
        self.assertEqual(result['last10']['n'], 7)
        self.assertEqual(result['last20']['n'], 7)

    def test_a_listed_player_without_the_stat_had_zero_but_longest_is_unknown(self):
        rows = self.rows([30, None, 10])
        self.assertEqual(ft.form(rows, 'recYds')['last5'], {'n': 3, 'avg': 13.33, 'median': 10, 'min': 0, 'max': 30})
        self.assertEqual(ft.form(rows, 'recLong')['last5']['n'], 2)

    def test_home_away_and_head_to_head_splits_keep_their_sources(self):
        result = ft.splits(self.rows([10, 20, 30, 40]), 'recYds', opponent='0')
        self.assertEqual((result['home']['avg'], result['away']['avg'], result['neutral']), (20.0, 30.0, None))
        self.assertEqual([g['eventId'] for g in result['vsOpponent']['games']], ['0', '3'])
        self.assertEqual(result['vsOpponent']['games'][1]['source'], 'https://x/3')


class StoreTests(unittest.TestCase):
    def test_the_latest_revision_of_a_game_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = game('1', '2025-09-07T17:00Z', players=[wr('10', '1', 7, 90, 9)])
            revised = json.loads(json.dumps(first))
            revised['players'][0]['recYds'], revised['revision'] = 95, 2
            boxscores.append(root / 'nfl-2025.jsonl', [first, game('2', '2025-09-14T17:00Z'), revised])
            loaded = ft.load(leagues=('NFL',), root=root)
            self.assertEqual([g['eventId'] for g in loaded], ['1', '2'])
            self.assertEqual(loaded[0]['players'][0]['recYds'], 95)


if __name__ == '__main__':
    unittest.main()
