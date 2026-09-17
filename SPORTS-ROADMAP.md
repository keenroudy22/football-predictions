# KeenRoudy Sports: league coverage and rollout

Updated September 17, 2026. The intended researched coverage is NFL, FBS college football, NBA and MLB under the KeenRoudy Sports name. Prioritize FanDuel and DraftKings with Indiana as the market-availability verification jurisdiction. Confirm current rules and each exact offered market; naming a jurisdiction alone does not verify availability.

## First implemented expansion

- NFL and FBS college football retain their existing research, game pages, picks and season records. Their original event IDs and football week rules remain intact.
- `scripts/sports_refresh.py` writes a separate `site/data/sports.json` snapshot for NBA and MLB schedules and scores. It makes at most six public ESPN requests per run for today and the next two dates in America/Indianapolis. It does not create a new background process or scheduler.
- The initial September 17 snapshot successfully returned 39 MLB games across September 17–19 and no NBA games in that three-day window. This is an observed date-window result, not a claim that an entire season has no games.
- Each game carries a league-qualified provider event ID, ET calendar date, season, teams, supplied game link, provider status and observed scores. MLB doubleheaders keep distinct event IDs. Scheduled games display no placeholder 0–0 result.
- Each league has its own last successful check, last attempt, source and coverage flags. A failed date refresh preserves the entire last good league snapshot and its original timestamp; an empty verified response differs from unavailable data.
- NBA/MLB odds, props, forecasts, official picks and betting results are **not enabled** in this phase. The score feed does not imply researched betting coverage. The next stage requires sport-specific data and settlement checks below.
- Refresh hook for the existing hosted workflow: `python scripts/sports_refresh.py`, before committing `site/data`. No extra scheduled run is needed. The hosted source check remains periodic rather than a continuous live score feed.

Validation: `python -m unittest discover -s tests -p test_sports_refresh.py` covers final and upcoming games, interrupted responses, stale-data preservation, unavailable versus empty slates, ET dates, doubleheaders, deduplication and mismatched provider identities. Deployment and mobile presentation are separate release checks.

## Shared foundation

Player research now has a searchable directory at #players and separate #player/<league>/<athleteId> pages. It indexes only verified identities already present in gathered research, preserving separate market thresholds, game windows and source dates. Sourced identity snapshots add team names and colors without implying health or starter status. Picks remain short and link to those pages for graphs, logs, workload and line-history detail. NBA/MLB player research remains unavailable until its independent activation gates pass.

- Use sport, league, season and provider event IDs on games, players, markets, quotes, predictions and results. Preserve all existing football IDs and links.
- Reuse favorites, broad watch boards, original-price ledgers, one-unit tracking, parlay tiers, calculators, research notes and pregame quote history.
- Separate market definition, period, direction, threshold, price, book, source, observation time and settlement rules. Do not assume every market is a full-game football stat.
- Keep original predictions, picks, prices and favorite designations immutable. Revisions append history rather than replacing it.
- Keep league-specific records and model evaluations. Offer combined betting returns only with explicit missing-price coverage; never combine unlike score-accuracy measures.
- Separate data-provider adapters and sport-specific research/settlement logic from presentation. Preserve last good data with visible freshness and source failures.

## Sport-specific requirements

| Area | NBA | MLB |
| --- | --- | --- |
| Calendar | Date, slate and season; no football week assumptions | Date, season and doubleheader game number; postponements and rescheduled games |
| Role research | Minutes, starts, usage, rotation, injuries, rest and back-to-backs | Confirmed batting order, starting pitcher, handedness, bullpen availability and lineup changes |
| Matchup | Pace, possessions, opponent personnel and coverage | Pitch mix, platoon context, park, weather, roof status and opposing lineup |
| Markets | Points, rebounds, assists, combinations, threes, quarters and halves | Strikeouts, outs recorded, hits, total bases, runs/RBI, first five innings and full game |
| Settlement | Participation and book rules for injuries, overtime and partial periods | Listed-pitcher/action rules, scratches, shortened/suspended games and innings requirements |

Recent-form charts must use the exact market and window. Show sample size and role changes. Football models, confidence scales and hit rates must not be treated as validated NBA or MLB methods.

## Navigation and rollout

1. Keep the current football board and season history intact while introducing league navigation and NBA/MLB calendar slates. Test phone layouts and old links.
2. Audit additional free-source coverage, permissions, update cadence and exact FanDuel/DraftKings market prices independently for NBA and MLB. No assumed comprehensive API coverage or paid subscriptions.
3. Expand researched coverage to all four leagues; NBA and MLB are both in scope and do not require another choice between them. Activate each league independently when source coverage, sport-specific methods and settlement checks are ready. Preserve truthful schedules/scores-only labels until then.
4. Validate sport-specific settlement and original-price preservation before publishing official picks or parlays. Keep cross-sport tickets disabled until rules and genuine combined book prices are supported.
5. Retain NFL/CFB week filters, including Monday games and college Week 0; use dates and season filters for daily sports. Do not reuse football week numbering for NBA/MLB.
6. Design later scheduled research around each sport's start times and lineup-release patterns. Scope runs to upcoming games and meaningful changes to control usage. The initial read-only data refresh uses the existing hosted workflow and adds no schedule.

Acceptance: football records unchanged; stable player/event identities; no doubleheader collisions; injury/scratch and postponement rules tested; duplicate revisions cannot double-count; missing prices never produce invented ROI; original pregame predictions remain auditable.

## Public address
The canonical site is https://keenroudy.com/sports/ in keenroudy22/sports. The original repository was renamed with its history intact. The root portfolio repository hosts the legacy /football-predictions/ redirect and preserves old game/results fragments. Keep this redirect when changing hosting; the local workspace folder retains its old name.
