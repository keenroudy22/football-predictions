import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from refresh import Model, validate_report, retained_source, fetch_by_week
from urllib.error import HTTPError
from unittest.mock import patch
from io import BytesIO
import json

class PipelineTests(unittest.TestCase):
    def test_priced_game_pick_does_not_require_parlay_legs(self):
        g = self.game()
        p = dict(id='spread-1', title='Home -3.5', why='Independent price review', risk='Uncertain game',
                 sources=['https://example.com'], status='active', book='Book', odds=-110,
                 quotedAt='2026-09-17T15:00:00Z', expiresAt='2026-09-17T17:00:00Z',
                 gameIds=[g['id']], cutoff='-3.5 at -110', confidence=6, edge='Judgment',
                 marketType='spread', line=-3.5, direction='home')
        r = dict(league='NFL', publishedAt='2026-09-17T16:00:00Z', gamePicks=[p])
        self.assertIs(validate_report(r, {g['id']: g}), r)
        p['direction'] = 'over'
        with self.assertRaises(AssertionError):
            validate_report(r, {g['id']: g})

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

    def test_historical_score_unknown_confidence_allowed(self):
        g=self.game()
        r=dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',historicalImport=True,scores=[dict(gameId=g['id'],home=20,away=10,why='Screenshot import',sources=['https://example.com'])])
        self.assertIs(validate_report(r,{g['id']:g}),r)

    def test_historical_import_cannot_publish_active_pick(self):
        g=self.game()
        p=dict(id='x',title='test',why='test',risk='test',sources=['https://example.com'],status='active',book='Book',odds=-110,quotedAt='2026-09-14T11:00:00Z',expiresAt='2099-09-14T20:00:00Z',gameIds=[g['id']],cutoff='-120',confidence=5,edge='test',projection=10)
        r=dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',historicalImport=True,props=[p])
        with self.assertRaisesRegex(AssertionError,'Historical import'):
            validate_report(r,{g['id']:g})

    def test_risky_props_and_verified_recent_form_are_allowed(self):
        g=self.game()
        p=dict(id='risky',title='test',why='test',risk='Higher variance',sources=['https://example.com'],status='active',book='Book',odds=125,quotedAt='2026-09-14T11:00:00Z',expiresAt='2099-09-14T20:00:00Z',gameIds=[g['id']],cutoff='+110',confidence=4,edge='test',projection=10,position='WR',recentForm=dict(stat='Over 10 yards',source='https://example.com/log',last5=dict(hits=3,sample=5),last10=dict(hits=6,sample=10)))
        r=dict(league='NFL',publishedAt='2026-09-14T12:00:00Z',riskyProps=[p])
        self.assertIs(validate_report(r,{g['id']:g}),r)

    def test_source_failure_preserves_last_success_and_marks_attempt(self):
        at=datetime(2026,9,16,0,30,tzinfo=timezone.utc)
        source={'league':'NFL','retrievedAt':'2026-09-15T19:20:00Z','url':'https://example.com','fetchStatus':'ok'}
        error=HTTPError(source['url'],400,'Bad Request',{},None)
        self.addCleanup(error.close)
        retained=retained_source('NFL',error,{'NFL':source},{'NFL-1':self.game()},at)
        self.assertEqual(retained['retrievedAt'],source['retrievedAt'])
        self.assertEqual(retained['lastAttemptAt'],'2026-09-16T00:30:00Z')
        self.assertEqual(retained['fetchStatus'],'failed')
        self.assertEqual(source['fetchStatus'],'ok')
        with self.assertRaises(HTTPError): retained_source('CFB',error,{}, {},at)

    def test_week_feed_requires_every_saved_game(self):
        at=datetime(2026,9,16,0,30,tzinfo=timezone.utc)
        g=self.game();g.update(kickoff='2026-09-17T20:00:00Z',week=2)
        def response(url, timeout=45):
            return BytesIO(json.dumps({'events':[{'id':'1'}]}).encode())
        with patch('refresh.urlopen',side_effect=response):
            events, urls=fetch_by_week('NFL',2026,{g['id']:g},at,at.replace(day=30))
            self.assertEqual([e['id'] for e in events],['1'])
            self.assertEqual(len(urls),1)
            other=dict(g,id='NFL-2')
            with self.assertRaisesRegex(ValueError,'missing 1 saved games'):
                fetch_by_week('NFL',2026,{g['id']:g,other['id']:other},at,at.replace(day=30))

if __name__ == '__main__': unittest.main()
