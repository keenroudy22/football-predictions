import unittest

from scripts.player_identity import candidates, color, load_identity, refresh


NOW = '2026-09-17T18:00:00Z'
OLD = '2026-09-16T18:00:00Z'


def detail(athlete_id='12', team=None):
    return {'athlete': {'id': athlete_id, 'displayName': 'Sourced Player',
                        'position': {'abbreviation': 'WR'},
                        'team': team if team is not None else {
                            'id': '8', 'displayName': 'Source Team',
                            'abbreviation': 'SRC', 'color': '00abcd',
                            'alternateColor': 'bbbbbb'}}}


class PlayerIdentityTests(unittest.TestCase):
    def test_candidates_deduplicate_and_keep_leagues_separate(self):
        reports = [{'league': 'NFL', 'publishedAt': '2026-09-16',
                    'props': [{'athleteId': '12'}, {'athleteId': 'invalid'}]},
                   {'league': 'CFB', 'publishedAt': '2026-09-17',
                    'gameWatch': [{'athleteId': '12'}]}]
        history = {'picks': {'old': {'gameId': 'NFL-123', 'athleteId': '12'},
                             'linked': {'gameId': 'NFL-124', 'recentForm': {
                                 'source': 'https://www.espn.com/nfl/player/gamelog/_/id/34'}}}}
        self.assertEqual(candidates(reports, history), [('CFB', '12'), ('NFL', '12'), ('NFL', '34')])

    def test_direct_team_is_sourced_and_bad_colors_omitted(self):
        row = load_identity('NFL', '12', lambda _: detail(team={
            'id': '8', 'displayName': 'Verified Team', 'abbreviation': 'VER',
            'color': '#00abcd', 'alternateColor': 'url(evil)'}), NOW)
        self.assertEqual(row['team'], {'id': '8', 'name': 'Verified Team',
                                     'abbreviation': 'VER', 'color': '00ABCD'})
        self.assertEqual(row['checkedAt'], NOW)
        self.assertEqual(row['status'], 'ok')
        self.assertIsNone(color('red'))
        self.assertIsNone(color('123456; background: red'))

    def test_partial_affiliation_fetches_same_team_from_official_endpoint(self):
        urls = []

        def fetch(url):
            urls.append(url)
            return detail(team={'id': '8'}) if '/athletes/' in url else {'team': detail()['athlete']['team']}

        row = load_identity('CFB', '12', fetch, NOW)
        self.assertEqual(row['team']['id'], '8')
        self.assertEqual(row['teamSource'], urls[1])
        self.assertTrue(urls[1].endswith('/college-football/teams/8'))

    def test_mismatched_athlete_and_team_are_rejected(self):
        with self.assertRaises(ValueError):
            load_identity('NFL', '12', lambda _: detail('13'), NOW)

        def fetch(url):
            return detail(team={'id': '8'}) if '/athletes/' in url else {'team': {**detail()['athlete']['team'], 'id': '9'}}

        with self.assertRaises(ValueError):
            load_identity('NFL', '12', fetch, NOW)

    def test_failure_preserves_last_good_check_and_identity(self):
        old = load_identity('NFL', '12', lambda _: detail(), OLD)

        def failed(_):
            raise TimeoutError('Source unavailable')

        result = refresh([{'league': 'NFL', 'props': [{'athleteId': '12'}, {'athleteId': '13'}]}],
                         {}, {'players': {'NFL/12': old}}, failed, NOW)
        row = result['players']['NFL/12']
        self.assertEqual(row['checkedAt'], OLD)
        self.assertEqual(row['lastAttemptAt'], NOW)
        self.assertEqual(row['team'], old['team'])
        self.assertEqual(row['status'], 'stale')
        self.assertNotIn('NFL/13', result['players'])
        self.assertEqual(len(result['failures']), 2)
        self.assertEqual(old['status'], 'ok')

    def test_missing_current_team_does_not_reuse_old_affiliation(self):
        result = refresh([{'league': 'NFL', 'props': [{'athleteId': '12'}]}], {},
                         {'players': {'NFL/12': load_identity('NFL', '12', lambda _: detail(), OLD)}},
                         lambda _: detail(team={}), NOW)
        self.assertIsNone(result['players']['NFL/12']['team'])
        self.assertEqual(result['players']['NFL/12']['status'], 'team-unavailable')

    def test_requests_are_hard_bounded(self):
        reports = [{'league': 'NFL', 'props': [{'athleteId': str(i)} for i in range(1, 46)]}]
        calls = []

        def fetch(url):
            calls.append(url)
            return detail(url.rsplit('/', 1)[-1])

        result = refresh(reports, {}, {}, fetch, NOW, max_athletes=100)
        self.assertEqual(len(calls), 40)
        self.assertEqual(result['attempted'], 40)
        self.assertEqual(result['deferred'], 5)


if __name__ == '__main__':
    unittest.main()
