import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path

spec = importlib.util.spec_from_file_location('sports_refresh', Path(__file__).resolve().parents[1] / 'scripts/sports_refresh.py')
sports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sports)
NOW = '2026-09-17T15:30:00Z'


def event(identifier='123', kickoff='2026-09-17T23:00Z', state='pre', completed=False):
    return {'id': identifier, 'date': kickoff, 'season': {'year': 2026, 'slug': 'regular-season'},
            'links': [{'rel': ['summary'], 'href': f'https://www.espn.com/mlb/game/_/gameId/{identifier}'}],
            'competitions': [{'date': kickoff, 'timeValid': True,
                'status': {'type': {'name': 'STATUS_FINAL' if completed else 'STATUS_SCHEDULED',
                                    'state': state, 'completed': completed, 'shortDetail': 'Final' if completed else 'Scheduled'}},
                'competitors': [
                    {'homeAway': 'away', 'team': {'id': '1', 'displayName': 'Away Team', 'abbreviation': 'AWY'}, 'score': '3' if completed else '0'},
                    {'homeAway': 'home', 'team': {'id': '2', 'displayName': 'Home Team', 'abbreviation': 'HME'}, 'score': '2' if completed else '0'}]}]}


def payload(events=None, league='MLB'):
    return {'leagues': [{'abbreviation': league}], 'events': events or []}


class SportsRefreshTests(unittest.TestCase):
    def normalize(self, events):
        return sports.normalize(payload(events), 'MLB', NOW, 'https://example.com/provider')

    def test_upcoming_scores_are_not_pregame_zero_placeholders(self):
        game = self.normalize([event()])[0]
        self.assertEqual(game['id'], 'MLB-123')
        self.assertEqual(game['status'], 'scheduled')
        self.assertEqual(game['scores'], {'away': None, 'home': None})
        self.assertEqual(game['season'], 2026)
        self.assertNotIn('week', game)
        self.assertEqual(game['source']['url'], 'https://www.espn.com/mlb/game/_/gameId/123')

    def test_final_and_in_progress_are_not_forecasts(self):
        final = self.normalize([event(state='post', completed=True)])[0]
        live_event = event(state='in')
        live_event['competitions'][0]['status']['type']['name'] = 'STATUS_IN_PROGRESS'
        live = self.normalize([live_event])[0]
        self.assertEqual(final['status'], 'final')
        self.assertEqual(final['scores'], {'away': 3, 'home': 2})
        self.assertEqual(live['status'], 'in_progress')
        self.assertEqual(live['scores'], {'away': 0, 'home': 0})
        self.assertNotIn('prediction', final)

    def test_doubleheader_same_teams_same_date_keeps_both_event_ids(self):
        games = self.normalize([event('123'), event('456', '2026-09-18T00:30Z')])
        self.assertEqual([game['id'] for game in games], ['MLB-123', 'MLB-456'])
        self.assertEqual([game['date'] for game in games], ['2026-09-17', '2026-09-17'])

    def test_postponement_is_not_a_final_even_with_post_state(self):
        postponed = event(state='post', completed=True)
        postponed['competitions'][0]['status']['type']['name'] = 'STATUS_POSTPONED'
        game = self.normalize([postponed])[0]
        self.assertEqual(game['status'], 'postponed')
        self.assertEqual(game['scores'], {'away': None, 'home': None})

    def test_empty_verified_league_is_success(self):
        result = sports.refresh({}, lambda url: payload(league='NBA' if '/nba/' in url else 'MLB'), NOW)
        for league in result['leagues'].values():
            self.assertEqual(league['status'], 'ok')
            self.assertEqual(league['games'], [])
            self.assertFalse(league['coverage']['picks'])

    def test_failed_league_preserves_snapshot_and_success_time(self):
        old = sports.refresh({}, lambda url: payload([event()] if '/mlb/' in url else [], 'MLB' if '/mlb/' in url else 'NBA'), NOW)
        untouched = deepcopy(old)
        def fetch(url):
            if '/mlb/' in url:
                raise OSError('upstream unavailable')
            return payload(league='NBA')
        result = sports.refresh(old, fetch, '2026-09-18T04:30:00Z')
        mlb = result['leagues']['MLB']
        self.assertEqual(mlb['status'], 'stale')
        self.assertEqual(mlb['games'], old['leagues']['MLB']['games'])
        self.assertEqual(mlb['checkedAt'], NOW)
        self.assertEqual(mlb['lastSuccessfulAt'], NOW)
        self.assertEqual(mlb['lastAttemptAt'], '2026-09-18T04:30:00Z')
        self.assertEqual(mlb['window']['from'], '2026-09-17')
        self.assertEqual(mlb['requestedWindow']['from'], '2026-09-18')
        self.assertEqual(result['leagues']['NBA']['status'], 'ok')
        self.assertEqual(old, untouched)

    def test_new_feed_failure_is_unavailable_not_empty_success(self):
        result = sports.refresh({}, lambda url: {}, NOW)
        self.assertEqual(result['leagues']['MLB']['status'], 'unavailable')
        self.assertIsNone(result['leagues']['MLB']['checkedAt'])

    def test_partial_day_failure_retains_entire_last_good_snapshot(self):
        old = sports.refresh({}, lambda url: payload([event()] if '/mlb/' in url else [], 'MLB' if '/mlb/' in url else 'NBA'), NOW)
        def fetch(url):
            if 'dates=20260918' in url and '/mlb/' in url:
                raise OSError('one date failed')
            return payload([event('999')] if '/mlb/' in url else [], 'MLB' if '/mlb/' in url else 'NBA')
        result = sports.refresh(old, fetch, NOW)
        self.assertEqual(result['leagues']['MLB']['games'], old['leagues']['MLB']['games'])
        self.assertEqual(result['leagues']['MLB']['status'], 'stale')

    def test_malformed_provider_data_fails_closed(self):
        with self.assertRaises(ValueError):
            sports.normalize({}, 'MLB', NOW, 'url')
        with self.assertRaises(ValueError):
            sports.normalize(payload(league='NBA'), 'MLB', NOW, 'url')
        malformed = event(completed=True)
        malformed['competitions'][0]['competitors'][0]['score'] = None
        with self.assertRaises(ValueError):
            self.normalize([malformed])

    def test_date_window_is_et_and_duplicates_do_not_double_count(self):
        calls = []
        def fetch(url):
            calls.append(url)
            return payload([event()] if '/mlb/' in url else [], 'MLB' if '/mlb/' in url else 'NBA')
        result = sports.refresh({}, fetch, '2026-09-18T02:00:00Z')
        self.assertEqual(len(calls), 6)
        self.assertEqual(len(result['leagues']['MLB']['games']), 1)
        self.assertEqual(result['leagues']['MLB']['window']['from'], '2026-09-17')
        self.assertEqual(result['leagues']['MLB']['window']['through'], '2026-09-19')

    def test_et_date_respects_winter_and_summer_offsets(self):
        self.assertEqual(str(sports.eastern_date('2026-07-01T04:30:00Z')), '2026-07-01')
        self.assertEqual(str(sports.eastern_date('2026-01-01T04:30:00Z')), '2025-12-31')
        self.assertEqual(str(sports.eastern_date('2026-03-08T04:30:00Z')), '2026-03-07')
        self.assertEqual(str(sports.eastern_date('2026-11-01T04:30:00Z')), '2026-11-01')


if __name__ == '__main__':
    unittest.main()
