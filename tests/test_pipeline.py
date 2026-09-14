import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from refresh import Model, validate_report

class PipelineTests(unittest.TestCase):
    def game(self):
        return dict(id='NFL-1', league='NFL', season=2026, kickoff='2099-09-14T20:00:00Z', neutral=False,
                    home={'id':'H','score':30}, away={'id':'A','score':10}, source='https://www.espn.com')

    def test_no_market_or_future_result_in_untrained_prediction(self):
        m = Model('NFL')
        a = m.predict(self.game(), datetime.now(timezone.utc))
        g = self.game(); g['home']['score'] = 100
        b = m.predict(g, datetime.now(timezone.utc))
        self.assertEqual((a['home'],a['away']), (b['home'],b['away']))
        self.assertTrue(a['sparse'])

    def test_ratings_reward_strength_and_regress(self):
        m = Model('NFL'); m.train(self.game())
        self.assertGreater(m.ratings['H'],m.ratings['A'])
        old = m.ratings['H']; m.advance(2027)
        self.assertAlmostEqual(m.ratings['H'], old*.65)

    def test_missing_active_quote_rejected(self):
        r = dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',props=[dict(id='x',title='test',why='test',risk='test',sources=['https://example.com'],status='active')])
        with self.assertRaises(AssertionError): validate_report(r, {})

    def test_overfilled_card_rejected(self):
        with self.assertRaises(AssertionError):
            validate_report(dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',props=[{}]*6), {})

    def test_late_analyst_score_rejected(self):
        g=self.game(); g['kickoff']='2026-09-13T20:00:00Z'
        r=dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',scores=[dict(gameId=g['id'],home=20,away=10,why='test',confidence=3,sources=['https://example.com'])])
        with self.assertRaises(AssertionError): validate_report(r,{g['id']:g})

    def test_unverified_settlement_rejected(self):
        p=dict(id='x',title='test',why='test',risk='test',sources=['https://example.com'],status='settled',result='win')
        with self.assertRaises(AssertionError):
            validate_report(dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',props=[p]),{})

if __name__ == '__main__': unittest.main()
