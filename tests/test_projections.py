import sys
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fakegames
import projections as pj

ROLE = {'qb': {'pos': 'QB', 'att': 30, 'cmp': 20, 'passYds': 240},
        'w1': {'pos': 'WR', 'tgt': 9, 'rec': 6, 'recYds': 80},
        'w2': {'pos': 'WR', 'tgt': 6, 'rec': 4, 'recYds': 50},
        'rb': {'pos': 'RB', 'car': 15, 'rushYds': 60, 'tgt': 3, 'rec': 2, 'recYds': 15},
        'te': {'pos': 'TE', 'tgt': 4, 'rec': 3, 'recYds': 30}}
PRIORS = {'WR': {'catchRate': 0.65, 'yardsPerTarget': 8.0}, 'TE': {'catchRate': 0.7, 'yardsPerTarget': 7.5},
          'RB': {'catchRate': 0.78, 'yardsPerTarget': 6.0, 'yardsPerCarry': 4.3},
          'QB': {'completionRate': 0.65, 'yardsPerAttempt': 7.0}}


def roster(team, skip=()):
    return [{'id': f'{team}-{key}', 'team': team, 'name': f'{team} {key}', **line}
            for key, line in ROLE.items() if key not in skip]


def league(weeks=6, moved=False):
    games = fakegames.season({'A': 0, 'B': 0, 'C': 0, 'D': 0}, weeks=weeks)
    for game in games:
        for side in ('home', 'away'):
            team = game[side]['id']
            game['players'] += roster(team)
            game['teams'][team].update(rushAtt=15, att=30, sacked=2)
            game['teams'][team]['pbp'].update(plays=47, dropbacks=32, rushes=15)
    if moved:
        # A's top receiver then plays a game for B.
        later = pj.features.when(games[-1]['kickoff']) + timedelta(days=7)
        games.append(fakegames.game(999, later, 'B', 'C', 20, 17, players=[
            {'id': 'A-w1', 'team': 'B', 'name': 'A w1', 'pos': 'WR', 'tgt': 5, 'rec': 3, 'recYds': 40}]))
    return games


def cutoff(games):
    return pj.features.when(games[-1]['kickoff']) + timedelta(days=1)


class ProjectionTests(unittest.TestCase):
    def project(self, games, unavailable=()):
        history = pj.History(games)
        return pj.project_team(history, 'NFL', 'A', 'B', cutoff(games), 2025, 0.0, 0.0, PRIORS, set(unavailable))

    def test_volume_and_shares_follow_recent_games(self):
        result = self.project(league())
        self.assertAlmostEqual(result['volume']['plays'], 47, places=1)
        self.assertAlmostEqual(result['volume']['targets'], 22, places=1)
        players = {p['id']: p for p in result['players']}
        self.assertAlmostEqual(players['A-w1']['targets']['mean'], 9, delta=0.15)
        self.assertAlmostEqual(players['A-rb']['carries']['mean'], 15, delta=0.15)
        self.assertAlmostEqual(players['A-qb']['att']['mean'], 30, delta=0.15)
        self.assertEqual(players['A-w1']['pos'], 'WR')

    def test_a_ruled_out_players_share_goes_to_the_rest(self):
        players = {p['id']: p for p in self.project(league(), unavailable={'A-w1'})['players']}
        self.assertNotIn('A-w1', players)
        self.assertAlmostEqual(sum(p.get('targets', {}).get('mean', 0) for p in players.values()), 22, delta=0.3)
        self.assertAlmostEqual(players['A-w2']['targets']['mean'], 6 * 22 / 13, delta=0.2)

    def test_ranges_bracket_the_projection_and_never_go_negative(self):
        for player in self.project(league())['players']:
            for stat in pj.STATS:
                if stat in player:
                    value = player[stat]
                    self.assertTrue(0 <= value['low'] <= value['mean'] <= value['high'], (player['id'], stat, value))

    def test_a_player_whose_latest_game_was_for_another_team_is_not_projected(self):
        games = league(moved=True)
        self.assertNotIn('A-w1', {p['id'] for p in self.project(games)['players']})

    def next_season(self, games, lineups):
        """Append 2026 games for A against B, one lineup (list of player lines) per game."""
        start = pj.features.when(games[-1]['kickoff'])
        for week, lineup in enumerate(lineups, 1):
            game = fakegames.game(2000 + week, start + timedelta(days=200 + 7 * week), 'A', 'B', 20, 17, season=2026,
                                  week=week, players=[{'team': 'A', 'name': f"A {p['id']}", **p} for p in lineup])
            for team in ('A', 'B'):
                game['teams'][team].update(rushAtt=15, att=30, sacked=2)
                game['teams'][team]['pbp'].update(plays=47, dropbacks=32, rushes=15)
            games.append(game)
        return games

    def test_a_player_who_has_not_played_for_the_team_this_season_is_not_projected(self):
        new_back = {'id': 'A-rb2', 'pos': 'RB', 'car': 15, 'rushYds': 70}
        games = self.next_season(league(), [[{'id': 'A-qb', **ROLE['qb']}, new_back]])
        result = pj.project_team(pj.History(games), 'NFL', 'A', 'B', cutoff(games), 2026, 0.0, 0.0, PRIORS)
        players = {p['id']: p for p in result['players']}
        self.assertNotIn('A-rb', players, "last season's back has not played for A this season")
        self.assertAlmostEqual(players['A-rb2']['carries']['mean'], 15, delta=0.3)

    def test_the_nfl_starter_is_whoever_threw_in_the_latest_game(self):
        first, benched = {'id': 'A-qb', **ROLE['qb']}, {'id': 'A-qb2', 'pos': 'QB', 'att': 30, 'cmp': 19, 'passYds': 220}
        games = self.next_season(league(), [[first], [benched]])
        for league_name, starter_share in (('NFL', 1.0), ('CFB', None)):
            result = pj.project_team(pj.History(games), league_name, 'A', 'B', cutoff(games), 2026, 0.0, 0.0, PRIORS)
            players = {p['id']: p for p in result['players']}
            if starter_share:
                self.assertAlmostEqual(players['A-qb2']['share']['att'], starter_share, places=3)
                self.assertNotIn('att', players.get('A-qb', {}), 'the benched passer keeps no attempts')
            else:
                self.assertGreater(players['A-qb2']['share']['att'], players['A-qb']['share']['att'],
                                   'college weights the latest game most but keeps some memory')

    def test_efficiency_is_shrunk_toward_the_position(self):
        games = league(weeks=1)
        history = pj.History(games)
        rates = pj.efficiency(history, 'A-w1', cutoff(games), 'NFL', PRIORS['WR'])
        self.assertAlmostEqual(rates['yardsPerTarget'], (80 + 8.0 * pj.SHRINK['yardsPerTarget']) / (9 + pj.SHRINK['yardsPerTarget']))

    def test_an_option_team_that_never_passes_has_zero_dropbacks_not_missing(self):
        game = league(weeks=1)[0]
        team = game['home']['id']
        game['teams'][team]['pbp'] = {'plays': 60, 'rushes': 60, 'successPlays': 60, 'successes': 25}
        self.assertEqual(pj.team_line(game, team, 'CFB')['dropbacks'], 0)

    def test_snap_counts_decide_who_played_when_the_game_has_them(self):
        game = league(weeks=1)[0]
        self.assertTrue(pj.played(game, 'A-w1', {}))
        self.assertFalse(pj.played(game, 'A-w1', {game['eventId']: {'A-w2'}}))


if __name__ == '__main__':
    unittest.main()
