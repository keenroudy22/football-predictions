import copy
import unittest
from unittest.mock import patch

from scripts.opponent_history import MAX_GAMES, past_games, refresh, selected_games, validate_summary


NOW = '2026-09-17T18:00:00Z'
OLD = '2026-09-16T18:00:00Z'


def target(event_id='900', kickoff='2026-09-18T18:00:00Z', **extra):
    return {'id': 'NFL-' + event_id, 'league': 'NFL', 'season': 2026,
            'state': 'pre', 'kickoff': kickoff,
            'home': {'id': '2', 'name': 'Buffalo'},
            'away': {'id': '8', 'name': 'Detroit'}, **extra}


def event(event_id='701', date='2026-09-14T18:00:00Z', season=2025,
          season_type='2', completed=True, teams=('2', '8')):
    return {'id': event_id, 'date': date, 'season': {'year': season},
            'seasonType': {'type': season_type},
            'competitions': [{'status': {'type': {'completed': completed}},
                              'competitors': [{'team': {'id': team}} for team in teams]}]}


def schedule(defense='2', events=None):
    return {'team': {'id': defense}, 'season': {'year': 2099},
            'events': events if events is not None else [event()]}


def summary(event_id='701', completed=True, teams=('2', '8')):
    return {'header': {'id': event_id, 'competitions': [
        {'status': {'type': {'completed': completed}},
         'competitors': [{'team': {'id': team}} for team in teams]}]},
        'boxscore': {'players': [{'team': {'id': team}, 'statistics': []} for team in teams]}}


class OpponentHistoryTests(unittest.TestCase):
    def test_schedule_keeps_only_prior_final_regular_events_for_the_verified_team(self):
        events = [event(), event('702', season_type='1'), event('703', season_type='3'),
                  event('704', completed=False), event('705', teams=('3', '8')),
                  event('706', teams=('2', '8', '9')), event('900'),
                  event('707', date=NOW), event('708', date='2026-09-19T18:00:00Z')]
        rows = past_games(schedule(events=events), '2', NOW, '900')
        self.assertEqual([row['id'] for row in rows], ['NFL-701'])
        self.assertEqual(rows[0]['season'], 2025, 'The event season must win over the misleading envelope')
        self.assertEqual(rows[0]['defenseId'], '2')
        with self.assertRaises(ValueError):
            past_games(schedule(defense='99'), '2', NOW, '900')

    def test_schedule_accepts_numeric_provider_identity_and_season_type_id(self):
        item = event(event_id=701)
        item['seasonType'] = {'id': 2}
        item['competitions'][0]['competitors'][0]['team']['id'] = 2
        rows = past_games(schedule(defense=2, events=[item]), '2', NOW, '900')
        self.assertEqual([row['id'] for row in rows], ['NFL-701'])

    def test_selected_games_are_followed_upcoming_nfl_games_and_capped_at_four(self):
        upcoming = [target(str(900 + i), f'2026-09-{18 + i}T18:00:00Z') for i in range(6)]
        past = target('800', '2026-09-17T17:00:00Z')
        underway = target('801', '2026-09-18T18:00:00Z', state='in')
        college = target('802', league='CFB')
        unidentified = target('803')
        unfollowed = target('804')
        props = [{'athleteId': '12', 'gameIds': [game['id']]} for game in upcoming + [past, underway, college]]
        props.append({'gameIds': [unidentified['id']]})
        slate = {'games': list(reversed(upcoming)) + [past, underway, college, unidentified, unfollowed]}
        selected = selected_games(slate, [{'league': 'NFL', 'props': props}], NOW)
        self.assertEqual(MAX_GAMES, 4)
        self.assertEqual([game['id'] for game in selected], ['NFL-900', 'NFL-901', 'NFL-902', 'NFL-903'])

    def test_boxscore_must_match_the_final_event_with_verified_defense_among_two_teams(self):
        prior = {'id': 'NFL-701', 'defenseId': '2'}
        self.assertIsNone(validate_summary(summary(), prior))
        for payload in [summary(event_id='999'), summary(completed=False),
                        summary(teams=('3', '8')), summary(teams=('2',)),
                        summary(teams=('2', '8', '9'))]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                validate_summary(payload, prior)

    def test_refresh_deduplicates_source_events_and_keeps_each_event_season(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if '/schedule?' in url:
                defense = url.split('/teams/')[1].split('/')[0]
                return schedule(defense, [event(), event()])
            if '/summary?' in url:
                return summary()
            self.fail('Unexpected network request: ' + url)

        def context(game, prior, boxscore, positions):
            return {'eventId': prior['id'].split('-')[-1], 'defenseId': prior['defenseId'],
                    'kickoff': prior['kickoff'], 'positions': {'RB': {'receptions': 0}},
                    'players': [], 'source': 'https://www.espn.com/nfl/boxscore/_/gameId/701'}

        with patch('scripts.opponent_history.defense_context', side_effect=context):
            result = refresh({'games': [target()]}, [{'league': 'NFL', 'props': [
                {'athleteId': '12', 'gameIds': ['NFL-900']}]}], {}, fetch, NOW)
        self.assertEqual(result['failures'], [])
        for side in ('home', 'away'):
            bucket = result['games']['NFL-900'][side]
            self.assertEqual(bucket['sample'], 1)
            self.assertEqual(bucket['games'][0]['season'], 2025)
            self.assertEqual(bucket['games'][0]['positions']['RB']['receptions'], 0)
            self.assertEqual(bucket['status'], 'ok')
            self.assertEqual(bucket['checkedAt'], NOW)
        self.assertEqual(sum('/summary?' in url for url in calls), 1, 'The same event is fetched only once')

    def test_failed_refresh_preserves_last_good_values_and_success_timestamp(self):
        previous = {'updatedAt': OLD, 'games': {'NFL-900': {'home': {
            'status': 'ok', 'checkedAt': OLD, 'lastAttemptAt': OLD,
            'games': [{'eventId': '701', 'positions': {'RB': {'receptions': 0}}, 'players': []}]}}}}
        untouched = copy.deepcopy(previous)

        def failed(_):
            raise TimeoutError('Fixture source failure')

        result = refresh({'games': [target()]}, [{'league': 'NFL', 'gameWatch': [
            {'athleteId': '12', 'gameId': 'NFL-900'}]}], previous, failed, NOW)
        bucket = result['games']['NFL-900']['home']
        self.assertEqual(bucket['checkedAt'], OLD)
        self.assertEqual(bucket['lastAttemptAt'], NOW)
        self.assertEqual(bucket['games'], untouched['games']['NFL-900']['home']['games'])
        self.assertEqual(bucket['status'], 'stale')
        self.assertEqual(result['games']['NFL-900']['away']['status'], 'unavailable')
        self.assertNotIn('checkedAt', result['games']['NFL-900']['away'])
        self.assertEqual(len(result['failures']), 2)
        self.assertEqual(previous, untouched)


if __name__ == '__main__':
    unittest.main()
