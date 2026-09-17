import copy
import unittest

from scripts.market_lines import build, exact_identity, normalize, parse_title


NOW = '2026-09-17T20:00:00Z'
GAME = {'id': 'NFL-1', 'league': 'NFL', 'kickoff': '2026-09-18T00:15:00Z', 'state': 'pre'}


def quote(**changes):
    return {'league': 'NFL', 'gameId': 'NFL-1', 'athleteId': '123', 'player': 'Player Name',
            'position': 'RB', 'market': 'receptions', 'direction': 'OVER', 'line': 4.5,
            'book': 'DraftKings', 'odds': 110, 'observedAt': '2026-09-17T19:45:00Z',
            'source': 'https://sportsbook.draftkings.com/event/example/1',
            'quoteType': 'sportsbook', 'marketWindow': 'Full game', **changes}


def catalog(observations, now=NOW, game=GAME):
    return build([], {}, {'games': [game]}, [{'observations': observations}], now)


class MarketLineTests(unittest.TestCase):
    def test_only_fresh_direct_pregame_price_is_current(self):
        row = catalog([quote()])['lines'][0]
        self.assertEqual(row['status'], 'current')
        self.assertTrue(row['builderEligible'])
        self.assertEqual(row['expiresAt'], '2026-09-17T20:45:00Z')
        self.assertEqual(row['checkedAt'], '2026-09-17T19:45:00Z')
        stale = catalog([quote()], now='2026-09-17T20:46:00Z')['lines'][0]
        self.assertEqual(stale['status'], 'stale')
        self.assertFalse(stale['builderEligible'])
        self.assertEqual(stale['observedAt'], row['observedAt'])

    def test_article_and_comparison_feeds_never_become_direct(self):
        for changes in ({'quoteType': 'article reference'}, {'quoteType': 'comparison feed'},
                        {'source': 'https://dknetwork.draftkings.com/article'},
                        {'book': 'BetMGM', 'source': 'https://sports.betmgm.com/en/blog/nfl/article'}):
            row = catalog([quote(**changes)])['lines'][0]
            self.assertEqual(row['status'], 'reference')
            self.assertFalse(row['builderEligible'])

    def test_missing_price_and_future_or_started_quotes_are_not_current(self):
        self.assertEqual(catalog([quote(odds=None)])['lines'][0]['status'], 'missing-price')
        self.assertEqual(catalog([quote(odds=0)])['lines'][0]['status'], 'missing-price')
        self.assertEqual(catalog([quote(observedAt='2026-09-17T21:00:00Z')])['lines'][0]['status'], 'reference')
        self.assertEqual(catalog([quote()], game={**GAME, 'state': 'in'})['lines'][0]['status'], 'closed')
        self.assertEqual(catalog([quote()], now='2026-09-18T00:15:00Z')['lines'][0]['status'], 'closed')

    def test_different_books_sides_and_windows_do_not_collapse(self):
        data = catalog([quote(), quote(book='FanDuel'), quote(direction='UNDER'), quote(marketWindow='1H')])
        self.assertEqual(len(data['lines']), 4)
        self.assertEqual(len({r['id'] for r in data['lines']}), 4)

    def test_latest_same_market_keeps_observations_and_original_immutable(self):
        item = {'id': 'pick-1', 'athleteId': '123', 'title': 'Player Name OVER 4.5 receptions',
                'gameIds': ['NFL-1'], 'book': 'DraftKings', 'odds': 110,
                'quotedAt': '2026-09-17T19:00:00Z', 'sources': [quote()['source']],
                'marketSnapshots': [quote(observedAt='2026-09-17T19:00:00Z'), quote(line=5.5, odds=120)]}
        reports = [{'league': 'NFL', 'publishedAt': '2026-09-17T19:01:00Z', 'props': [item]}]
        before = copy.deepcopy(reports)
        row = build(reports + reports, {}, {'games': [GAME]}, [], NOW)['lines'][0]
        self.assertEqual(row['line'], 5.5)
        self.assertEqual(row['odds'], 120)
        self.assertEqual(row['observationCount'], 2)
        self.assertEqual(row['originalRecommendations'][0]['line'], 4.5)
        self.assertEqual(row['originalRecommendations'][0]['odds'], 110)
        self.assertEqual(reports, before)

    def test_structured_two_way_price_needs_matching_snapshot(self):
        watch = {'id': 'watch', 'player': 'Player Name', 'gameId': 'NFL-1',
                 'lineLabel': '4.5 receptions · OVER +110 / UNDER -130',
                 'marketSnapshots': [quote()]}
        reports = [{'league': 'NFL', 'gameWatch': [watch]}]
        data = build(reports, {}, {'games': [GAME]}, [], NOW)
        self.assertEqual({r['direction']: r['odds'] for r in data['lines']}, {'OVER': 110, 'UNDER': -130})
        watch['lineLabel'] = 'DraftKings: 4.5 receptions · OVER +110 / UNDER -130'
        self.assertEqual(len(build(reports, {}, {'games': [GAME]}, [], NOW)['lines']), 2)
        watch['lineLabel'] = '4.5 receptions · OVER +120 / UNDER -140'
        self.assertEqual(len(build(reports, {}, {'games': [GAME]}, [], NOW)['lines']), 1)

    def test_touchdown_quotes_do_not_invent_threshold(self):
        row = catalog([quote(market='anytime touchdown', line=None, direction='YES')])['lines'][0]
        self.assertIsNone(row['line'])
        self.assertEqual(row['title'], 'Player Name anytime touchdown')

    def test_missing_historical_quote_time_is_not_publication_time(self):
        reports = [{'league': 'NFL', 'publishedAt': NOW, 'historicalImport': True,
                    'props': [{'id': 'old', 'gameIds': ['NFL-1'], 'title': 'Player Name UNDER 4.5 receptions',
                               'sources': ['https://www.espn.com/nfl/game/_/gameId/1']}]}]
        row = build(reports, {}, {'games': [GAME]}, [], NOW)['lines'][0]
        self.assertIsNone(row['observedAt'])
        self.assertIsNone(row['odds'])
        self.assertEqual(row['quoteType'], 'historical import')

    def test_exact_identity_sources_and_title_parsing(self):
        item = {'sources': ['https://www.espn.com/nfl/player/gamelog/_/id/123']}
        self.assertEqual(exact_identity(item, {}), '123')
        item['sources'].append('https://www.espn.com/nfl/player/gamelog/_/id/124')
        self.assertIsNone(exact_identity(item, {}))
        self.assertEqual(parse_title('Player Name OVER 6.5 carries')['market'], 'rushing attempts')
        self.assertIsNone(parse_title('Player looked great last week and should see more touches'))


if __name__ == '__main__':
    unittest.main()
