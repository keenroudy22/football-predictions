import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import boxscores
import odds_api

NOW = datetime(2026, 9, 19, 14, 0, tzinfo=timezone.utc)   # Saturday 10:00 AM ET


def game(gid, league, kickoff, home, away):
    return {'id': gid, 'league': league, 'season': 2026, 'state': 'pre', 'kickoff': kickoff,
            'home': {'id': '1', 'name': home, 'abbreviation': 'H'}, 'away': {'id': '2', 'name': away, 'abbreviation': 'A'}}


def event(home, away, commence, books):
    return {'id': 'abc', 'sport_key': 'americanfootball_ncaaf', 'commence_time': commence, 'home_team': home,
            'away_team': away, 'bookmakers': books}


def book(key, spread_home, home_price, away_price, total, over, under):
    return {'key': key, 'title': key.title(), 'last_update': '2026-09-19T13:50:00Z', 'markets': [
        {'key': 'spreads', 'outcomes': [{'name': 'Texas A&M Aggies', 'price': home_price, 'point': spread_home},
                                        {'name': 'Kentucky Wildcats', 'price': away_price, 'point': -spread_home}]},
        {'key': 'totals', 'outcomes': [{'name': 'Over', 'price': over, 'point': total},
                                       {'name': 'Under', 'price': under, 'point': total}]}]}


SLATE = [game('CFB-1', 'CFB', '2026-09-19T19:30Z', 'Texas A&M Aggies', 'Kentucky Wildcats'),
         game('NFL-1', 'NFL', '2026-09-20T17:00Z', 'Atlanta Falcons', 'Carolina Panthers')]
EVENT = event('Texas A&M Aggies', 'Kentucky Wildcats', '2026-09-19T19:30:00Z', [
    book('draftkings', -16.5, -118, -102, 49.5, -112, -108),
    book('fanduel', -16.5, -110, -110, 50.5, -110, -110),
    book('betmgm', -17.0, -105, -115, 49.5, -105, -115)])


class ParseTests(unittest.TestCase):
    def test_events_match_slate_games_by_both_names_and_kickoff(self):
        pairs, unmatched = odds_api.match([EVENT, event('Ohio Bobcats', 'Kent State Golden Flashes', '2026-09-19T19:30:00Z', [])],
                                          SLATE)
        self.assertEqual([g['id'] for _, g in pairs], ['CFB-1'])
        self.assertEqual(len(unmatched), 1)
        far = dict(EVENT, commence_time='2026-09-26T19:30:00Z')
        self.assertEqual(odds_api.match([far], SLATE)[0], [], 'same teams a week later is a different game')
        self.assertEqual(odds_api.normal('Texas A&M Aggies'), 'texas a and m aggies')
        self.assertEqual(odds_api.normal('Miami (OH) RedHawks'), 'miami redhawks')

    def test_the_two_providers_spellings_match_and_a_swapped_home_team_is_read_the_slate_way(self):
        for a, b in (('UMass Minutemen', 'Massachusetts Minutemen'), ('Southern Miss Golden Eagles', 'Southern Mississippi Golden Eagles'),
                     ('UL Monroe Warhawks', 'Louisiana-Monroe Warhawks'), ('App State Mountaineers', 'Appalachian State Mountaineers'),
                     ('Sam Houston Bearkats', 'Sam Houston State Bearkats'), ('Hawaii Rainbow Warriors', "Hawai'i Rainbow Warriors")):
            self.assertTrue(odds_api.same_team(a, b), (a, b))
        self.assertFalse(odds_api.same_team('Ohio State Buckeyes', 'Ohio Bobcats'))
        self.assertFalse(odds_api.same_team('Michigan Wolverines', 'Michigan State Spartans'))
        slate = [game('CFB-9', 'CFB', '2026-09-19T16:00Z', 'Kansas Jayhawks', 'Arizona State Sun Devils')]
        swapped = event('Arizona State Sun Devils', 'Kansas Jayhawks', '2026-09-19T16:00:00Z', [
            {'key': 'draftkings', 'title': 'DraftKings', 'last_update': 'x', 'markets': [
                {'key': 'spreads', 'outcomes': [{'name': 'Arizona State Sun Devils', 'price': -110, 'point': -5.5},
                                                {'name': 'Kansas Jayhawks', 'price': -110, 'point': 5.5}]}]}])
        pairs, unmatched = odds_api.match([swapped], slate)
        self.assertEqual(unmatched, [])
        self.assertTrue(pairs[0][0]['swapped'])
        books = odds_api.books_of(pairs[0][0], 'Kansas Jayhawks', 'Arizona State Sun Devils')
        self.assertEqual(books['draftkings']['spread']['home'], 5.5, "the slate's home team, Kansas, is +5.5")

    def test_each_book_yields_the_home_spread_and_the_total(self):
        books = odds_api.books_of(EVENT, 'Texas A&M Aggies', 'Kentucky Wildcats')
        self.assertEqual(sorted(books), ['betmgm', 'draftkings', 'fanduel'])
        self.assertEqual(books['draftkings']['spread'], {'home': -16.5, 'homePrice': -118, 'awayPrice': -102})
        self.assertEqual(books['fanduel']['total'], {'line': 50.5, 'over': -110, 'under': -110})

    def test_best_price_prefers_the_number_then_the_price(self):
        record = {'books': odds_api.books_of(EVENT, 'Texas A&M Aggies', 'Kentucky Wildcats')}
        self.assertEqual(odds_api.best(record, 'home'), ('fanduel', -16.5, -110), 'same number as DK, better price')
        self.assertEqual(odds_api.best(record, 'away'), ('betmgm', 17.0, -115), 'half a point beats a better price')
        self.assertEqual(odds_api.best(record, 'over'), ('betmgm', 49.5, -105))
        self.assertEqual(odds_api.best(record, 'under'), ('fanduel', 50.5, -110))
        self.assertIsNone(odds_api.best({'books': {}}, 'home'))


class BudgetTests(unittest.TestCase):
    def test_a_league_is_captured_only_when_due(self):
        self.assertIsNone(odds_api.due('CFB', SLATE, {}, NOW))
        self.assertIn('no game', odds_api.due('CFB', SLATE, {}, NOW - timedelta(days=3)))
        status = {'usage': {'remaining': 25}}
        self.assertIn('reserve', odds_api.due('CFB', SLATE, status, NOW))
        status = {'leagues': {'CFB': {'lastAt': '2026-09-19T12:00:00Z'}}}
        self.assertIn('gap', odds_api.due('CFB', SLATE, status, NOW))
        status = {'leagues': {'CFB': {'lastAt': '2026-09-19T06:00:00Z', 'day': '2026-09-19', 'count': 4}}}
        self.assertIn('already today', odds_api.due('CFB', SLATE, status, NOW), 'four on a Saturday')
        status = {'leagues': {'NFL': {'lastAt': '2026-09-19T06:00:00Z', 'day': '2026-09-19', 'count': 3}}}
        self.assertIn('already today', odds_api.due('NFL', SLATE, status, NOW), 'three on any other day')

    def test_capture_appends_only_changes_and_never_logs_the_key(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        calls, logs = [], []
        headers = {'x-requests-remaining': '496', 'x-requests-used': '4', 'x-requests-last': '2'}

        def fake(sport, key):
            calls.append(sport)
            return ([EVENT] if sport.endswith('ncaaf') else []), headers

        status = odds_api.capture({'games': SLATE}, NOW, 'SECRET-KEY', {}, fetch=fake, root=root, log=logs.append)
        self.assertEqual(sorted(calls), ['americanfootball_ncaaf', 'americanfootball_nfl'])
        stored = [l for p in root.glob('*.jsonl') for l in boxscores.read_store(p)]
        self.assertEqual([r['gameId'] for r in stored], ['CFB-1'])
        self.assertEqual(status['usage']['remaining'], 496)
        self.assertEqual(status['leagues']['CFB']['count'], 1)
        self.assertNotIn('SECRET-KEY', json.dumps(stored) + ' '.join(logs))
        again = odds_api.capture({'games': SLATE}, NOW + timedelta(hours=4), 'SECRET-KEY', status, fetch=fake, root=root,
                                 log=logs.append)
        self.assertEqual(len([l for p in root.glob('*.jsonl') for l in boxscores.read_store(p)]), 1, 'unchanged books are not appended')
        self.assertEqual(again['leagues']['CFB']['count'], 2)


if __name__ == '__main__':
    unittest.main()
