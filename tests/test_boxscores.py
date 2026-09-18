import copy
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import boxscores as bx

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'espn'
NFL, CFB = 'nfl-401872656.json', 'cfb-401858213.json'
NOW = datetime(2026, 9, 18, 21, 0, tzinfo=timezone.utc)


def bundle(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


def record(name=NFL, data=None, retrieved='2026-09-18T21:00:00Z'):
    data = data or bundle(name)
    league, event = name.split('.')[0].split('-')
    return bx.build_record(league.upper(), event, data['summary'], data['plays'], data['odds'], retrieved)


def player(rec, name):
    return next(p for p in rec['players'] if p.get('name') == name)


def play(kind, team='1', to_go=50, roles=(), down=1, distance=10, gained=0, scoring=False, text='', snap_team=None):
    return {'type': {'text': kind}, 'text': text, 'team': {'$ref': f'/teams/{team}'},
            'start': {'down': down, 'distance': distance, 'yardsToEndzone': to_go,
                      'team': {'$ref': f'/teams/{snap_team or team}'}},
            'drive': {'$ref': '/drives/9'}, 'statYardage': gained, 'scoringPlay': scoring,
            'participants': [{'type': role, 'athlete': {'$ref': f'/athletes/{athlete}'}} for role, athlete in roles]}


class RealGameTests(unittest.TestCase):
    """Two real ESPN games, trimmed. The official box score is the answer key."""

    def test_nfl_play_counts_match_the_official_box_score(self):
        rec = record()
        check = rec['quality']['check']
        self.assertEqual(check['carries'], {'box': 53, 'pbp': 53, 'players': 7, 'exact': 7})
        self.assertEqual(check['receptions'], {'box': 40, 'pbp': 40, 'players': 15, 'exact': 15})
        # The feed tags no receiver on Maye's three interceptions.
        self.assertEqual((check['targets']['box'], check['targets']['pbp']), (55, 52))
        for team, (plays, dropbacks, rushes, trips, scores) in {'17': (67, 36, 31, 2, 1), '26': (48, 26, 22, 2, 0)}.items():
            box, pbp = rec['teams'][team], rec['teams'][team]['pbp']
            self.assertEqual((pbp['plays'], pbp['dropbacks'], pbp['rushes']), (plays, dropbacks, rushes))
            self.assertEqual(pbp['plays'], box['plays'])
            self.assertEqual(pbp['dropbacks'], box['att'] + box['sacked'])
            self.assertEqual((pbp['rzDrives'], pbp['rzDriveTDs']), (box['rzTrips'], box['rzTD']))
            self.assertEqual((pbp['rzDrives'], pbp['rzDriveTDs']), (trips, scores))

    def test_red_zone_work_is_recorded_per_player(self):
        rec = record()
        jsn = player(rec, 'Jaxon Smith-Njigba')
        self.assertEqual((jsn['tgt'], jsn['rzTgt'], jsn['i10Tgt']), (11, 3, 2))
        self.assertEqual(player(rec, 'George Holani')['rzCar'], 2)
        maye = player(rec, 'Drake Maye')
        self.assertEqual((maye['att'], maye['pbpAtt'], maye['rzAtt'], maye['scrambles']), (33, 33, 2, 6))

    def test_kicking_quarters_venue_and_split_success_rates(self):
        rec = record()
        self.assertEqual({k: player(rec, 'Jason Myers')[k] for k in ('fgm', 'fga', 'fgLong', 'xpm', 'xpa', 'kPts', 'pos')},
                         {'fgm': 2, 'fga': 2, 'fgLong': 30, 'xpm': 1, 'xpa': 1, 'kPts': 7, 'pos': 'PK'})
        self.assertEqual((rec['home']['periods'], rec['away']['periods']), ([0, 0, 3, 10], [0, 7, 3, 0]))
        self.assertEqual(rec['venue'], {'id': '3673', 'name': 'Lumen Field', 'grass': False})
        for team in rec['teams'].values():
            pbp = team['pbp']
            self.assertEqual(pbp['dbSuccesses'] + pbp['rushSuccesses'], pbp['successes'])
            self.assertEqual(pbp['dbSuccessPlays'] + pbp['rushSuccessPlays'], pbp['successPlays'])

    def test_every_player_carries_the_provider_position_for_that_game(self):
        rec = record()
        self.assertTrue(all(p.get('pos') for p in rec['players']))
        self.assertEqual([player(rec, n)['pos'] for n in ('Drake Maye', 'Jaxon Smith-Njigba', 'Rhamondre Stevenson')],
                         ['QB', 'WR', 'RB'])

    def test_market_keeps_open_and_close_from_the_pregame_provider(self):
        market = record()['market']
        self.assertEqual((market['provider'], market['providerId']), ('DraftKings', '100'))
        self.assertEqual(market['open'], {'spread': -3.5, 'spreadHomeOdds': -110, 'spreadAwayOdds': -110, 'total': 44.5,
                                          'overOdds': -110, 'underOdds': -110, 'homeML': -192, 'awayML': 160})
        self.assertEqual(market['close'], {'spread': -3.0, 'spreadHomeOdds': -120, 'spreadAwayOdds': 100, 'total': 44.5,
                                           'overOdds': -108, 'underOdds': -112, 'homeML': -170, 'awayML': 142})

    def test_college_targets_come_only_from_play_by_play(self):
        rec = record(CFB)
        self.assertFalse(any('tgt' in p for p in rec['players']), 'college box scores have no targets')
        self.assertNotIn('targets', rec['quality']['check'])
        gillespie = player(rec, 'Chase Gillespie')
        self.assertEqual((gillespie['pbpTgt'], gillespie['rec']), (4, 3))
        # NCAA scoring counts sacks as quarterback rushes. The college box score
        # lists no sacks, so play-by-play supplies them and the check adds them back.
        famu = rec['teams']['50']
        self.assertEqual(famu['pbp']['dropbacks'], famu['att'] + 2)
        fletcher = player(rec, 'Dustin Fletcher')
        self.assertEqual((fletcher['car'], fletcher['pbpCar'], fletcher['pbpSacked'], fletcher['pbpSackYds']), (8, 6, 2, 11))
        carries = rec['quality']['check']['carries']
        self.assertEqual(carries['box'], carries['pbp'])
        self.assertEqual(carries['exact'], carries['players'])

    def test_nfl_play_by_play_sacks_match_the_box_score(self):
        rec = record()
        for name in ('Drake Maye', 'Sam Darnold', 'Drew Lock'):
            qb = player(rec, name)
            self.assertEqual((qb.get('pbpSacked', 0), qb.get('pbpSackYds', 0)), (qb['sacked'], qb['sackYds']), name)

    def test_record_names_its_sources_and_retrieval_time(self):
        rec = record()
        self.assertEqual((rec['eventId'], rec['season'], rec['week'], rec['seasonType']), ('401872656', 2026, 1, 2))
        self.assertTrue(all('401872656' in url for url in rec['sources'].values()))
        self.assertEqual(rec['retrievedAt'], '2026-09-18T21:00:00Z')
        self.assertEqual(rec['hash'], record(retrieved='2026-09-20T00:00:00Z')['hash'], 'retrieval time is not content')
        corrected = bundle(NFL)
        rushing = next(c for side in corrected['summary']['boxscore']['players'] for c in side['statistics']
                       if c['name'] == 'rushing' and any(a['athlete']['displayName'] == 'Rhamondre Stevenson' for a in c['athletes']))
        row = next(a for a in rushing['athletes'] if a['athlete']['displayName'] == 'Rhamondre Stevenson')
        row['stats'][1] = '53'
        self.assertNotEqual(rec['hash'], record(data=corrected)['hash'])


class BoxScoreTests(unittest.TestCase):
    def test_fumble_recoveries_alone_do_not_create_a_player_line(self):
        summary = {'boxscore': {'players': [{'team': {'id': '1'}, 'statistics': [
            {'name': 'fumbles', 'keys': ['fumbles', 'fumblesLost', 'fumblesRecovered'], 'athletes': [
                {'athlete': {'id': '7', 'displayName': 'Recovering Linebacker'}, 'stats': ['0', '0', '1']},
                {'athlete': {'id': '8', 'displayName': 'Fumbling Back'}, 'stats': ['1', '1', '0']}]},
            {'name': 'kicking', 'keys': ['fieldGoalsMade/fieldGoalAttempts', 'longFieldGoalMade',
                                         'extraPointsMade/extraPointAttempts', 'totalKickingPoints'], 'athletes': [
                {'athlete': {'id': '9', 'displayName': 'Kicker'}, 'stats': ['0/1', '0', '3/3', '3']}]}]}]}}
        players = bx.box_players(summary)
        self.assertEqual(sorted(players), ['8', '9'])
        self.assertEqual((players['8']['fum'], players['8']['fumLost']), (1, 1))
        self.assertEqual({k: players['9'][k] for k in ('fgm', 'fga', 'xpm', 'kPts')}, {'fgm': 0, 'fga': 1, 'xpm': 3, 'kPts': 3})
        self.assertNotIn('fgLong', players['9'])


class PlayFeatureTests(unittest.TestCase):
    def features(self, *plays):
        counts, tags, teams, offense, unknown = bx.play_features({'items': list(plays)}, {'1', '2'})
        return counts, offense

    def test_a_receiver_tagged_twice_is_one_target(self):
        counts, _ = self.features(play('Pass Incompletion', roles=[('passer', 10), ('receiver', 20), ('receiver', 20)]))
        self.assertEqual(counts['20'], {'pbpTgt': 1})

    def test_nullified_special_teams_and_two_point_plays_are_excluded(self):
        counts, offense = self.features(
            play('Penalty', roles=[('passer', 10), ('receiver', 20)]),
            play('Rush', roles=[('rusher', 30)], text='PENALTY on X, False Start - No Play.'),
            play('Kickoff', roles=[('rusher', 30)]),
            play('Two-point Pass', roles=[('passer', 10), ('receiver', 20)]),
            play('Rush', roles=[('rusher', 30)], text='TWO-POINT CONVERSION ATTEMPT. X rushes. ATTEMPT SUCCEEDS.'))
        self.assertEqual(counts, {})
        self.assertEqual(offense['1'].get('plays', 0), 0)

    def test_turnover_plays_belong_to_the_offense_at_the_snap(self):
        counts, offense = self.features(
            play('Pass Interception Return', team='2', snap_team='1', roles=[('passer', 10), ('returner', 99)]))
        self.assertEqual(offense['1']['dropbacks'], 1)
        self.assertNotIn('dropbacks', offense['2'])
        self.assertEqual(counts['10'], {'pbpAtt': 1})

    def test_defensive_scores_are_not_offensive_touchdowns(self):
        _, offense = self.features(
            play('Rush', to_go=15, roles=[('rusher', 30)], gained=2),
            play('Fumble Return Touchdown', team='2', snap_team='1', to_go=12, roles=[('rusher', 30)], scoring=True))
        self.assertEqual((offense['1']['rzDrives'], offense['1']['rzDriveTDs']), (1, 0))

    def test_red_zone_windows_and_success_thresholds(self):
        counts, offense = self.features(
            play('Rush', to_go=20, roles=[('rusher', 30)], gained=4),
            play('Rush', to_go=10, roles=[('rusher', 30)], gained=3, down=2, distance=6),
            play('Rush', to_go=5, roles=[('rusher', 30)], gained=1, down=3, distance=2),
            play('Rushing Touchdown', to_go=4, roles=[('rusher', 30)], gained=4, down=3, distance=4, scoring=True),
            play('Rush', to_go=21, roles=[('rusher', 30)], gained=25, down=1, distance=10))
        self.assertEqual(counts['30'], {'pbpCar': 5, 'rzCar': 4, 'i10Car': 3, 'i5Car': 2})
        # 4 of 10, 3 of 6 (needs 3.6), 1 of 2, a touchdown, 25 of 10.
        self.assertEqual((offense['1']['successes'], offense['1']['successPlays']), (3, 5))
        self.assertEqual(offense['1']['explosive'], 1)
        self.assertEqual((offense['1']['rzDrives'], offense['1']['rzDriveTDs']), (1, 1))


class MarketTests(unittest.TestCase):
    def item(self, provider_id, name, spread='-3', priority=1):
        return {'provider': {'id': provider_id, 'name': name, 'priority': priority},
                'homeTeamOdds': {'close': {'pointSpread': {'american': spread}, 'spread': {'american': '-110'}}},
                'awayTeamOdds': {'close': {'pointSpread': {'american': spread.replace('-', '+')}}},
                'close': {'total': {'american': '44.5'}}}

    def test_the_live_feed_is_never_used_and_draftkings_is_preferred(self):
        payload = {'items': [self.item('59', 'ESPN Bet - Live Odds', '-17', 0), self.item('58', 'ESPN BET', '-2.5', 0),
                             self.item('100', 'DraftKings', '-3')]}
        self.assertEqual(bx.market(payload)['close']['spread'], -3.0)
        payload['items'].pop()
        self.assertEqual(bx.market(payload)['provider'], 'ESPN BET')
        self.assertIsNone(bx.market({'items': [self.item('59', 'ESPN Bet - Live Odds', '-17', None)]}))

    def test_provider_number_formats(self):
        self.assertEqual([bx.line(x) for x in ('PK', 'o44.5', 'u44.5', '+3', '-9.5', None)], [0.0, 44.5, 44.5, 3.0, -9.5, None])
        self.assertEqual([bx.american(x) for x in ('EVEN', '-110', '+142', {'american': '+100'}, '5', None)],
                         [100, -110, 142, 100, None, None])

    def test_disagreeing_home_and_away_spreads_are_flagged_not_fixed(self):
        payload = {'items': [self.item('100', 'DraftKings')]}
        payload['items'][0]['awayTeamOdds']['close']['pointSpread'] = {'american': '+4'}
        result = bx.market(payload)
        self.assertEqual(result['close']['spread'], -3.0)
        self.assertEqual(result['warnings'], ['close home/away spreads disagree'])


class ValidationTests(unittest.TestCase):
    def test_only_this_final_game_is_accepted(self):
        for change, message in ((lambda d: d['summary']['header'].update(id='1'), 'identity'),
                                (lambda d: d['summary']['header']['competitions'][0]['status']['type'].update(completed=False), 'not final'),
                                (lambda d: d['summary']['boxscore'].update(players=[]), 'no player'),
                                (lambda d: d['summary']['boxscore']['players'][0]['team'].update(id='999'), 'team identity')):
            data = bundle(NFL)
            change(data)
            with self.assertRaisesRegex(ValueError, message):
                record(data=data)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.path = self.root / 'nfl-2026.jsonl'

    def tearDown(self):
        self.dir.cleanup()

    def freeze(self):
        (self.root / 'ledger.json').write_text(json.dumps(bx.ledger(self.root)), encoding='utf-8')

    def test_appending_is_allowed_and_rewriting_is_caught(self):
        bx.append(self.path, [{'eventId': '1', 'n': 1}, {'eventId': '2', 'n': 2}])
        self.freeze()
        bx.append(self.path, [{'eventId': '3', 'n': 3}])
        self.assertEqual(bx.verify(self.root), [])
        lines = self.path.read_text(encoding='utf-8').splitlines()
        self.path.write_text('\n'.join([lines[0].replace('"n":1', '"n":9')] + lines[1:]) + '\n', encoding='utf-8')
        self.assertEqual(bx.verify(self.root), ['nfl-2026.jsonl: a recorded line was changed'])
        self.path.write_text(lines[0] + '\n', encoding='utf-8')
        self.assertEqual(bx.verify(self.root), ['nfl-2026.jsonl: 1 recorded lines disappeared'])

    def test_windows_line_endings_do_not_change_the_hash(self):
        bx.append(self.path, [{'eventId': '1'}, {'eventId': '2'}])
        self.freeze()
        self.path.write_bytes(self.path.read_bytes().replace(b'\n', b'\r\n'))
        self.assertEqual(bx.verify(self.root), [])

    def test_a_partial_last_line_blocks_further_appends(self):
        self.path.write_text('{"eventId": "1"}\n{"eventId": "2"', encoding='utf-8')
        with self.assertRaises(ValueError):
            bx.append(self.path, [{'eventId': '3'}])

    def test_the_committed_store_is_append_only_and_well_formed(self):
        self.assertEqual(bx.verify(), [], 'A box-score line was rewritten. Restore it and append a revision instead.')
        for path in sorted(bx.STORE.glob('*.jsonl')):
            league, season = path.stem.split('-')
            for text in bx.read_lines(path):
                row = json.loads(text)
                self.assertEqual((row['league'].lower(), str(row['season'])), (league, season), path.name)
                self.assertTrue(row['eventId'] and row['retrievedAt'] and row['sources']['summary'], path.name)
                self.assertEqual(row['hash'], bx.content_hash(row), f'{path.name} {row["eventId"]}')


class FakeFeed:
    """Serves the fixture game for any URL; counts reads; can fail or correct."""

    def __init__(self, name=NFL):
        self.data, self.calls, self.errors = bundle(name), [], {}

    def __call__(self, url):
        self.calls.append(url)
        for key, error in self.errors.items():
            if f'/{key}' in url or f'{key}?' in url:
                raise error
        if 'summary' in url:
            return copy.deepcopy(self.data['summary'])
        return copy.deepcopy(self.data['plays' if 'plays' in url else 'odds'])


class RunTests(unittest.TestCase):
    GAME = [('NFL', '401872656', '2026-09-10T00:20Z', 2026)]

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def error(self, code):
        error = HTTPError('https://example.invalid', code, 'test', None, io.BytesIO())
        self.addCleanup(error.close)
        return error

    def go(self, feed, status, now, clock=None):
        return bx.run(self.GAME, status, now, fetch=feed, workers=1, log=lambda *_: None, root=self.root,
                      clock=clock or (lambda: now))

    def lines(self):
        return bx.read_store(self.root / 'nfl-2026.jsonl')

    def test_a_new_final_is_read_once(self):
        feed, status = FakeFeed(), {}
        self.assertEqual(self.go(feed, status, NOW), ({'nfl-2026.jsonl': 1}, 1))
        self.assertEqual(len(feed.calls), 3)
        self.assertEqual(self.go(feed, status, NOW + timedelta(hours=3)), ({}, 0))
        self.assertEqual(len(feed.calls), 3, 'a stored final is not re-read')

    FIRST_READ = datetime(2026, 9, 10, 4, 0, tzinfo=timezone.utc)

    def test_an_unchanged_recheck_appends_nothing(self):
        feed, status = FakeFeed(), {}
        self.go(feed, status, self.FIRST_READ)
        self.assertEqual(self.go(feed, status, self.FIRST_READ + timedelta(days=2)), ({}, 0), 'no recheck before four days')
        self.assertEqual(self.go(feed, status, self.FIRST_READ + timedelta(days=5)), ({}, 1))
        self.assertIn('401872656', status['rechecked'])
        self.assertEqual(len(self.lines()), 1)
        self.assertEqual(self.go(feed, status, self.FIRST_READ + timedelta(days=6)), ({}, 0), 'one recheck only')

    def test_a_stat_correction_appends_a_revision_and_keeps_the_original_line(self):
        feed, status = FakeFeed(), {}
        self.go(feed, status, self.FIRST_READ)
        for side in feed.data['summary']['boxscore']['players']:
            for category in side['statistics']:
                for row in category['athletes']:
                    if row['athlete']['displayName'] == 'Rhamondre Stevenson' and category['name'] == 'rushing':
                        row['stats'][1] = '53'
        self.go(feed, status, self.FIRST_READ + timedelta(days=5))
        original, revision = self.lines()
        self.assertEqual(revision['revision'], 2)
        self.assertEqual(player(original, 'Rhamondre Stevenson')['rushYds'], 51, 'the first line is untouched')
        self.assertEqual(player(bx.latest(self.lines())['401872656'], 'Rhamondre Stevenson')['rushYds'], 53)

    def test_failed_reads_back_off_and_are_retried(self):
        feed, status = FakeFeed(), {}
        feed.errors['summary'] = self.error(503)
        for hour in range(3):
            self.go(feed, status, NOW + timedelta(hours=hour))
        self.assertEqual(status['failures']['401872656']['attempts'], 3)
        self.assertEqual(self.go(feed, status, NOW + timedelta(hours=4)), ({}, 0), 'backing off')
        feed.errors.clear()
        self.assertEqual(self.go(feed, status, NOW + timedelta(hours=27)), ({'nfl-2026.jsonl': 1}, 1))
        self.assertNotIn('401872656', status['failures'])

    def test_odds_the_provider_does_not_have_are_empty_and_not_retried(self):
        feed, status = FakeFeed(), {}
        feed.errors['odds'] = self.error(404)
        self.go(feed, status, NOW)
        self.assertEqual(self.lines()[0]['quality']['odds'], 'empty')
        self.assertIsNone(self.lines()[0]['market'])
        self.assertEqual(self.go(feed, status, NOW + timedelta(hours=1)), ({}, 0))

    def test_a_failed_odds_read_is_retried_a_bounded_number_of_times(self):
        feed, status = FakeFeed(), {}
        feed.errors['odds'] = self.error(500)
        self.go(feed, status, NOW)
        self.assertEqual(self.lines()[0]['quality']['odds'], 'error: HTTP 500')
        for hour in range(1, 6):
            self.go(feed, status, NOW + timedelta(hours=hour))
        self.assertEqual(status['retries']['401872656'], bx.MAX_FETCH_ATTEMPTS)
        self.assertEqual(len(self.lines()), 1, 'an identical failed retry appends nothing')
        status['retries'].clear()
        feed.errors.clear()
        self.go(feed, status, NOW + timedelta(hours=7))
        self.assertEqual(self.lines()[-1]['quality']['odds'], 'ok')
        self.assertEqual(self.lines()[-1]['market']['close']['spread'], -3.0)


class ListingTests(unittest.TestCase):
    def test_backfill_lists_completed_team_games_and_unions_college_conferences(self):
        def event(eid, abbreviations=('BUF', 'MIA'), completed=True):
            return {'id': eid, 'date': f'2025-09-0{eid[-1]}T17:00Z', 'season': {'year': 2025},
                    'competitions': [{'status': {'type': {'completed': completed}},
                                      'competitors': [{'team': {'abbreviation': a}} for a in abbreviations]}]}
        seen = []

        def fetch(url):
            seen.append(url)
            if 'week=1&' in url or url.endswith('week=1'):
                return {'events': [event('11'), event('12', ('AFC', 'NFC')), event('13', completed=False)]}
            return {'events': [event('11')]}

        self.assertEqual(bx.season_games('NFL', 2025, fetch), [('NFL', '11', '2025-09-01T17:00Z', 2025)])
        seen.clear()
        bx.season_games('CFB', 2025, fetch)
        self.assertTrue(all('groups=' in url for url in seen))
        self.assertEqual({url.split('groups=')[1] for url in seen}, {str(g) for g in bx.FBS_CONFERENCES})
        self.assertNotIn('groups=80', ' '.join(seen), 'the FBS group truncates at 25 games')


if __name__ == '__main__':
    unittest.main()
