import unittest
import json
from pathlib import Path
from scripts.player_history import game_rows, number


class PlayerHistoryTests(unittest.TestCase):
    def test_excludes_recommendation_game_and_missing_stat(self):
        log = {
            'names': ['receivingYards'],
            'events': {
                '1': {'id': '1', 'gameDate': '2026-09-01T17:00Z'},
                '2': {'id': '2', 'gameDate': '2026-09-08T17:00Z'},
                '3': {'id': '3', 'gameDate': '2026-09-10T17:00Z'},
            },
            'seasonTypes': [{'categories': [{'type': 'event', 'events': [
                {'eventId': '1', 'stats': ['52']},
                {'eventId': '2', 'stats': ['-']},
                {'eventId': '3', 'stats': ['90']},
            ]}]}],
        }
        rows = game_rows(log, 'receivingYards', '2026-09-10T17:00Z')
        self.assertEqual([(r[1], r[3]) for r in rows], [('1', 52.0)])

    def test_stat_format(self):
        self.assertEqual(number('1,234'), 1234)
        self.assertIsNone(number('-'))

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
