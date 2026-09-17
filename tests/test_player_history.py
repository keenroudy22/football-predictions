import unittest
import json
import io
from datetime import datetime, timedelta, timezone
from pathlib import Path
from scripts.player_history import defense_context, fetch, game_rows, number, prop_history
from unittest.mock import patch


class PlayerHistoryTests(unittest.TestCase):
    def test_excludes_recommendation_game_and_missing_stat(self):
        log = {
            'names': ['receivingYards'],
            'events': {
                '1': {'id': '1', 'gameDate': '2026-09-01T17:00Z'},
                '2': {'id': '2', 'gameDate': '2026-09-08T17:00Z'},
                '3': {'id': '3', 'gameDate': '2026-09-10T17:00Z'},
            },
            'seasonTypes': [{'categories': [{'type': 'event', 'splitType': '2', 'events': [
                {'eventId': '1', 'stats': ['52']},
                {'eventId': '2', 'stats': ['-']},
                {'eventId': '3', 'stats': ['90']},
            ]}]}],
        }
        rows = game_rows(log, 'receivingYards', '2026-09-10T17:00Z')
        self.assertEqual([(r[1], r[3]) for r in rows], [('1', 52.0)])

    def test_touches_require_carries_and_receptions(self):
        log = {'names': ['rushingAttempts','receptions','receivingTargets'],
               'events': {'1': {'id':'1','gameDate':'2026-09-13','opponent':{'id':'18','abbreviation':'NO'}}},
               'seasonTypes':[{'categories':[{'type':'event','splitType':'2','events':[{'eventId':'1','stats':['29','5','5']}]}]}]}
        game = {'id':'NFL-2','season':2026,'kickoff':'2026-09-17T20:00:00Z'}
        with patch('scripts.player_history.fetch', return_value=log):
            f=prop_history({'title':'Player OVER 3.5 receptions'},game,'123','18',checked_at='2026-09-17T19:00:00Z')
        self.assertEqual(f['games'][0]['workload']['touches'],34)
        self.assertEqual(f['games'][0]['workload']['receivingTargets'],5)
        log['seasonTypes'][0]['categories'][0]['events'][0]['stats'][0]='-'
        with patch('scripts.player_history.fetch', return_value=log):
            f=prop_history({'title':'Player OVER 3.5 receptions'},game,'123','18',checked_at='2026-09-17T19:00:00Z')
        self.assertNotIn('touches',f['games'][0]['workload'])

    def test_stat_format(self):
        self.assertEqual(number('1,234'), 1234)
        self.assertIsNone(number('-'))
        self.assertIsNone(number('NaN'))
        self.assertIsNone(number('Infinity'))

    @staticmethod
    def sample_log(count=12):
        first = datetime(2026, 1, 1, 18, tzinfo=timezone.utc)
        events = {}
        values = []
        for index in range(count):
            event_id = str(index + 100)
            events[event_id] = {'id': event_id, 'gameDate': (first + timedelta(days=index)).isoformat(),
                                'opponent': {'id': '18' if index == 0 else '2',
                                             'displayName': 'Historical Opponent', 'abbreviation': 'OPP'},
                                'team': {'id': '8', 'displayName': 'Historical Team', 'abbreviation': 'OLD'},
                                'homeTeamId': '8' if index % 2 == 0 else '2',
                                'awayTeamId': '8' if index % 2 else '2'}
            values.append({'eventId': event_id, 'stats': [str(index)]})
        return {'names': ['receptions'], 'events': events,
                'seasonTypes': [{'displayName': '2026 Regular Season', 'categories': [
                    {'type': 'event', 'splitType': '2', 'events': values}]}]}

    def test_full_regular_history_keeps_older_opponent_and_explicit_push(self):
        log = self.sample_log()
        game = {'id': 'NFL-999', 'season': 2026, 'kickoff': '2026-09-17T20:00:00Z'}
        with patch('scripts.player_history.fetch', return_value=log):
            form = prop_history({'title': 'Player OVER 9 receptions'}, game, '123', '18',
                                checked_at='2026-09-17T18:00:00Z', team_id='8')
        self.assertEqual(len(form['games']), 10)
        self.assertEqual(len(form['historyGames']), 12)
        self.assertEqual(form['vsOpponent']['sample'], 1)
        prior = form['vsOpponent']['games'][0]
        self.assertEqual(prior['eventId'], '100')
        self.assertEqual(prior['opponent']['id'], '18')
        self.assertEqual(prior['team']['id'], '8')
        self.assertTrue(prior['isHome'])
        self.assertEqual(prior['season'], 2026)
        self.assertEqual(prior['seasonType'], 'regular')
        self.assertEqual(form['statKey'], 'receptions')
        self.assertEqual(form['direction'], 'OVER')
        self.assertEqual(form['teamId'], '8')
        self.assertEqual(form['opponentId'], '18')
        self.assertEqual(form['coverage']['seasons'], [2024, 2025, 2026])
        self.assertEqual(form['last5'], {'hits': 2, 'pushes': 1, 'misses': 2, 'sample': 5, 'decisions': 4})
        self.assertEqual(form['cutoffAt'], '2026-09-17T18:00:00Z')

    def test_regular_only_strict_dates_ids_dnp_and_zeros(self):
        log = self.sample_log(5)
        category = log['seasonTypes'][0]['categories'][0]
        category['events'][1]['didNotPlay'] = True
        category['events'][2]['stats'] = ['-']
        log['events']['103']['gameDate'] = 'not a date'
        log['events']['104']['id'] = '105'
        log['seasonTypes'][0]['categories'] += [
            {'type': 'event', 'splitType': '1', 'events': [{'eventId': '100', 'stats': ['70']}]},
            {'type': 'event', 'splitType': '3', 'events': [{'eventId': '100', 'stats': ['80']}]}]
        rows = game_rows(log, 'receptions', '2026-02-01T00:00:00Z', 2026)
        self.assertEqual([(r[1], r[3]) for r in rows], [('100', 0.0)])

    def test_own_event_future_and_timezone_boundary_are_excluded(self):
        log = self.sample_log(4)
        log['events']['101']['gameDate'] = '2026-09-17T19:00:00Z'
        log['events']['102']['gameDate'] = '2026-09-17T14:00:00-04:00'
        log['events']['103']['gameDate'] = '2026-09-17T17:59:00Z'
        game = {'id': 'NFL-100', 'season': 2026, 'kickoff': '2026-09-17T20:00:00Z'}
        with patch('scripts.player_history.fetch', return_value=log):
            form = prop_history({'title': 'Player UNDER 4 receptions'}, game, '123', '18',
                                checked_at='2026-09-17T18:00:00Z')
        self.assertEqual([g['eventId'] for g in form['historyGames']], ['103'])

    def test_partial_source_failure_preserves_successful_history(self):
        prior = {'stat': 'receptions', 'games': [{'value': 4}], 'checkedAt': '2026-09-16T18:00:00Z', 'status': 'ok'}
        game = {'id': 'NFL-999', 'season': 2026, 'kickoff': '2026-09-17T20:00:00Z'}
        with patch('scripts.player_history.fetch', side_effect=[self.sample_log(), TimeoutError(), self.sample_log()]):
            form = prop_history({'title': 'Player OVER 3.5 receptions'}, game, '123', '18', previous=prior,
                                checked_at='2026-09-17T18:00:00Z')
        self.assertEqual(form['games'], prior['games'])
        self.assertEqual(form['checkedAt'], prior['checkedAt'])
        self.assertEqual(form['lastAttemptAt'], '2026-09-17T18:00:00Z')
        self.assertEqual(form['status'], 'stale')
        self.assertEqual(prior['status'], 'ok')
        self.assertEqual(len(form['sourceFailures']), 1)

    def test_explicitly_unlisted_prior_season_is_coverage_not_zero_or_failure(self):
        unavailable = {'filters': [
            {'name': 'league', 'value': 'nfl'},
            {'name': 'season', 'value': '2024', 'options': [{'value': '2025'}, {'value': '2026'}]}]}
        game = {'id': 'NFL-999', 'season': 2026, 'kickoff': '2026-09-17T20:00:00Z'}
        with patch('scripts.player_history.fetch', side_effect=[unavailable, self.sample_log(), self.sample_log()]):
            form = prop_history({'title': 'Player OVER 3.5 receptions'}, game, '123', '18',
                                checked_at='2026-09-17T18:00:00Z')
        self.assertEqual(form['status'], 'ok')
        self.assertEqual(form['coverage']['unavailableSeasons'][0]['season'], 2024)
        self.assertEqual(len(form['historyGames']), 12)
        self.assertTrue(all(row['season'] == 2026 for row in form['historyGames']))

    def test_requests_are_cached_per_url(self):
        fetch.cache_clear()
        with patch('scripts.player_history.urlopen', return_value=io.StringIO('{"events":{}}')) as request:
            self.assertEqual(fetch('https://example.test/gamelog?season=2026'), {'events': {}})
            self.assertEqual(fetch('https://example.test/gamelog?season=2026'), {'events': {}})
            request.assert_called_once()
        fetch.cache_clear()

    def test_defense_individuals_preserve_aggregate_and_source_boundary(self):
        summary = {'boxscore': {'players': [
            {'team': {'id': '8', 'displayName': 'Defense'}, 'statistics': []},
            {'team': {'id': '18', 'displayName': 'Historical Opponent', 'abbreviation': 'OPP'},
             'statistics': [
                 {'keys': ['receptions', 'receivingYards'], 'athletes': [
                     {'athlete': {'id': '123', 'displayName': 'Receiver', 'position': {'abbreviation': 'WR'}},
                      'stats': ['5', '60']},
                     {'athlete': {'id': '124', 'displayName': 'Scratched', 'position': {'abbreviation': 'WR'}},
                      'didNotPlay': True, 'stats': ['0', '0']}]},
                 {'keys': ['completions/passingAttempts', 'passingYards'], 'athletes': [
                     {'athlete': {'id': '125', 'displayName': 'Quarterback', 'position': {'abbreviation': 'QB'}},
                      'stats': ['20/30', '250']}]},
                 {'keys': ['totalTackles'], 'athletes': [
                     {'athlete': {'id': '999', 'displayName': 'Unrelated defender'},
                      'stats': ['9']}]}]}]}}
        game = {'kickoff': '2026-09-17T20:00:00Z'}
        previous = {'id': 'NFL-100', 'kickoff': '2026-09-13T17:00:00Z', 'defenseId': '8'}
        with patch('scripts.player_history.position', side_effect=AssertionError('Unrelated position lookup')):
            result = defense_context(game, previous, summary, {})
        self.assertEqual(result['defenseId'], '8')
        self.assertEqual(result['eventId'], '100')
        self.assertEqual(result['sample'], 1)
        self.assertEqual(result['positions']['WR']['receptions'], 5)
        self.assertEqual(result['positions']['QB']['passingAttempts'], 30)
        self.assertEqual(len(result['players']), 2)
        receiver = next(p for p in result['players'] if p['athleteId'] == '123')
        self.assertEqual(receiver['stats']['receivingYards'], 60)
        self.assertIsNone(defense_context(game, {**previous, 'defenseId': '99'}, summary, {}))
        self.assertIsNone(defense_context(game, {**previous, 'kickoff': game['kickoff']}, summary, {}))

    def test_published_snapshot_consistency(self):
        path = Path(__file__).resolve().parents[1] / 'site' / 'data' / 'player-history.json'
        if not path.exists():
            self.skipTest('No sourced snapshot yet')
        data = json.loads(path.read_text(encoding='utf-8'))
        for item in data['picks'].values():
            form = item['recentForm']
            game_id = item['gameId'].split('-')[-1]
            self.assertNotIn(game_id, [g['source'].rsplit('/', 1)[-1] for g in form['games']])
            self.assertTrue(all(g['source'].startswith('https://www.espn.com/nfl/boxscore/') for g in form['games']))
            if 'lastVsOpponent' in form:
                self.assertNotEqual(form['lastVsOpponent']['source'].rsplit('/', 1)[-1], game_id)
            for usage in form.get('usage', []):
                self.assertTrue(usage['stat'])
                for count in (5, 10):
                    values = usage.get(f'last{count}')
                    if values:
                        self.assertGreaterEqual(len(form['games']), count)
                        self.assertLessEqual(values['low'], values['average'])
                        self.assertLessEqual(values['average'], values['high'])
            # Resolve exact line direction from the immutable recommendation.
        reports = json.loads((path.parent / 'research.json').read_text(encoding='utf-8'))
        picks = {p['id']: p for r in reports for p in r.get('props', []) + r.get('riskyProps', [])}
        for id_, item in data['picks'].items():
            direction = 'OVER' if ' OVER ' in picks[id_]['title'] else 'UNDER'
            form = item['recentForm']
            self.assertTrue(all(g['hit'] == (g['value'] > form['line'] if direction == 'OVER' else g['value'] < form['line'])
                                for g in form['games']))
            for count in (5, 10):
                window = form.get(f'last{count}')
                if window:
                    self.assertEqual(window['hits'], sum(g['hit'] for g in form['games'][-count:]))


if __name__ == '__main__':
    unittest.main()
