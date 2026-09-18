"""Synthetic stored games with known team strengths, for model tests."""
from datetime import datetime, timedelta, timezone

START = datetime(2025, 9, 7, 17, 0, tzinfo=timezone.utc)


def stamp(moment):
    return moment.isoformat(timespec='minutes').replace('+00:00', 'Z')


def game(event, kickoff, home, away, home_points, away_points, league='NFL', season=2025, week=1, neutral=False,
         players=(), close=None, season_type=2):
    def side(points):
        plays = 64
        return {'points': points, 'turnovers': 1, 'rushAtt': 26, 'att': 34, 'sacked': 2,
                'pbp': {'plays': plays, 'dropbacks': 36, 'rushes': 28, 'successPlays': plays,
                        'successes': 26 + int(points // 7), 'explosive': 3, 'rzDrives': 2 + int(points // 14)}}
    return {'eventId': str(event), 'league': league, 'season': season, 'seasonType': season_type, 'week': week,
            'kickoff': stamp(kickoff), 'neutral': neutral,
            'home': {'id': home, 'abbreviation': home, 'score': home_points},
            'away': {'id': away, 'abbreviation': away, 'score': away_points},
            'teams': {home: side(home_points), away: side(away_points)},
            'players': list(players), 'quality': {'plays': 'ok'},
            'market': {'close': close} if close else None, 'hash': f'h{event}',
            'sources': {'page': f'https://www.espn.com/nfl/boxscore/_/gameId/{event}'}}


def season(strength, weeks=8, home_field=3, league='NFL', year=2025, start=START, first_event=1):
    """Rotating weekly pairings where points = 20 +/- (strength gap + home field) / 2, exactly."""
    teams = sorted(strength)
    games, event = [], first_event
    for week in range(weeks):
        rotated = teams[week % len(teams):] + teams[:week % len(teams)]
        for i in range(0, len(rotated) - 1, 2):
            home, away = (rotated[i], rotated[i + 1]) if week % 2 == 0 else (rotated[i + 1], rotated[i])
            gap = strength[home] - strength[away] + home_field
            games.append(game(event, start + timedelta(days=7 * week, minutes=i), home, away,
                              20 + gap / 2, 20 - gap / 2, league=league, season=year, week=week + 1))
            event += 1
    return games
