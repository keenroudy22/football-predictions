# KeenRoudy Sports

Public site: https://keenroudy.com/sports/ · Source repository: `keenroudy22/sports`.

NFL and FBS football forecasts, researched player props, and a public record of what was actually published before kickoff.

NBA and MLB currently provide separate schedules and score snapshots, with Eastern date filters and source freshness. Their betting research and forecasts are not enabled. The old `/football-predictions/` address redirects to `/sports/`, preserving game/results fragments and query strings. Its redirect lives in the root portfolio repository, with a source copy in `deployment/legacy-redirect/`. Game IDs, football weeks and season records are preserved. See `SPORTS-ROADMAP.md` for the next coverage gates.

Static website hosted on GitHub Pages. No paid API, account signup, tracking scripts, or betting transactions.

## Run

Python 3.11+ and Node 20+; no package install required.

```
python scripts/refresh.py
python scripts/sports_refresh.py
python scripts/build_site.py
python -m unittest discover -s tests
node --check site/core.js
node --check site/app.js
node --test tests/*.test.js
python -m http.server 8000 --directory site
```

`site/` is the deployable directory. GitHub Actions refreshes schedules/results throughout the day plus Eastern postgame windows, including weekday college games. Actions can run late; the page displays source timestamps. Turn off the workflow in GitHub Actions to stop it. No local background process is required.

## The site

One page, hash-routed, no framework: `site/index.html`, `site/app.css`, `site/core.js` (formatting, stat windows, defense ranks, ticket and record rules; unit-tested in Node) and `site/app.js` (views).

- **Today:** the slate, where v2 and the market disagree most, live picks, the record, how the model is doing, and how fresh each source is.
- **Games:** every NFL and FBS game in the window with the market spread and total, v1 and v2. A game page adds the v2 forecast with its inputs and range, player projections next to the DraftKings line, both teams' last five, defense-vs-position ranks, injuries, line movement, published picks, and after the final, leaders and grades against the close.
- **Stats:** every player with a line in the last two seasons, with last 5/10/20, season, home/away/neutral, head-to-head and a hit-rate chart against any line; defense vs position (season or last five, sortable); teams.
- **Model:** the scoreboard. **Record:** every published pick at one unit, with closing-line value. **More:** the line board, the illustrative ticket builder, the research desk, and NBA/MLB scores.
- **The board** grades every open, priced line with the research desk's arithmetic (`scripts/pricing.py`): v2's chance of winning it against what the price needs. *Model likes it* is 5+ points clear; *Slight lean* is 2 to 5, or any edge while a team or player has under three games this season; *No edge* is below that. FBS-FCS games get no grade, because v2 compresses those blowouts. Best lines sort first. Picks say where they stand in words: Open, In play, Closed (line moved or price expired), Won, Lost.

`scripts/build_site.py` writes the page payloads to `site/data/app/` (today, lines, one file per game, player logs sharded by athlete ID, teams, research). They are derived from committed data, so they are not committed; the hosted workflow rebuilds them before every deploy. Old links (`#record`, `#scores`, `#props`, `#parlays`, `#players`, `#game/<id>`, `#player/<league>/<id>`, `#sport/<league>`) land on the matching new page.

## Three kinds of forecasts

**Baseline score forecast:** automatic, opponent-adjusted Elo margin and smoothed team game totals from ESPN completed games. A transparent starting point, not a researched betting edge. Prior-season ratings regress 35% toward average. Newly observed teams start at league average. No roster, injuries, transfers, weather, or market inputs. Sparse-history games are flagged. Scores are rounded estimates, not exact-score bets. Model v1 is uncalibrated and has not demonstrated profitability.

**Model v2 (`scripts/model_v2.py`, `scripts/projections.py`):** team scores and player volume from the box-score store, refit on every run and published by `scripts/forecast.py` as append-only snapshots in `data/forecasts/` with their inputs, version and an 80% range. Margin and total ratings are recency-weighted ridge regressions of points on offense, defense and home field; totals blend in efficiency-implied points, NFL margins blend in the v1 Elo, and college FCS opponents share a group rating. Player targets, carries and pass attempts come from the player's recent share of the team's projected volume; NFL snap counts mark who played and the ESPN injury report removes ruled-out players. No market, weather or betting input. Tuned on 2024, then scored once on the untouched 2025 season (average miss against the final result, points):

| 2025 walk-forward | Closing line | v1 Elo | v2 |
|---|---|---|---|
| NFL margin / total | 9.71 / 10.49 | 10.22 / 10.88 | 10.21 / 10.60 |
| FBS margin / total | 11.91 / 12.47 | 14.83 / 12.78 | 12.48 / 12.66 |

v2 does not beat the closing line and makes no claim to. Its 80% ranges held 78 to 82% of 2025 results. Early-season college mismatches are compressed toward the middle while teams have few games. A forecast counts from the moment the hosted workflow publishes it; nothing generated elsewhere is backfilled into the store.

**The scoreboard (`scripts/scoreboard.py` -> `site/data/scoreboard.json`)** grades every forecast published before kickoff (v1's original, v2's last snapshot, the analyst's last call) against the provider's closing spread and total and the final score, by league, season, week and model version: record against the close, average miss next to the close's, how often the model was closer, how often the line moved from open toward the model, 80% range coverage and Brier score. Backtests of v2 and the v1 Elo for 2024 and 2025 sit beside the live record, labeled retrospective. v2 player projections are graded against the last DraftKings line captured before kickoff (`scripts/prop_lines.py`, NFL only; the feed has no prices and no college props). Every published pick gets closing-line value: the posted line against the last comparable line before kickoff, from the ESPN close or the latest capture or hand observation, with how long before kickoff it was taken.

**Analyst card:** source-backed score revisions, player props, and parlays published by the research task. The automatic schedule collector does not perform that research or invent recommendations. No card is shown as actionable after kickoff or when its quote expires. College prop jurisdiction availability must be verified before publication as actionable.

ESPN's public scoreboard feed is an unofficial integration without a service guarantee. Failure preserves the last good file and fails the workflow; timestamps identify stale data. Completed scores are provider-reported, not represented as independently verified official statistics.

## Box-score store

`data/boxscores/<league>-<season>.jsonl` holds one line per completed NFL and FBS game: team stats, every player with an offensive or kicking line, play-derived red-zone work and success rates, points by quarter, and the provider's open and close spread, total and moneyline. Each line names its ESPN event ID, the three source URLs and its retrieval time. Coverage starts with the 2023 season. It is not deployed; `scripts/build_site.py` derives the small files the site reads.

- **Append-only.** A line is never edited. A later read with different content, such as an official stat correction four days after the game, appends a revision; the last line for an event is current. `data/boxscores/ledger.json` hashes the lines each file holds and `tests/test_boxscores.py` fails if one changes. Never regenerate the ledger to make that test pass.
- **Sources.** Box score from the ESPN `summary` endpoint; play-by-play participants and closing lines from ESPN's core API. Closing lines are DraftKings for 2026 and ESPN BET for 2024 and 2025. In-game odds are never used. A game with no pregame provider has no line, not an estimate.
- **Limits.** ESPN publishes no snap counts, so none are recorded. College box scores list no targets and no sacks per quarterback; both come from play-by-play. NCAA scoring counts sacks as quarterback rushes, so official college rushing lines include them. Intercepted passes carry no receiver tag, so play-derived targets run slightly under official NFL targets; the official number is used wherever it exists. A player with no recorded stat in a game has no line for it.

```
python scripts/boxscores.py                    new finals in site/data/slate.json (the hosted workflow runs this)
python scripts/boxscores.py --backfill NFL 2025
python scripts/features.py                     coverage and agreement with official box scores
```

`data/nflverse/nfl-<season>.jsonl` adds NFL snap counts (skill players) and game context (roof, surface, temperature, wind, rest, starting quarterbacks) from nflverse's free CSVs, sourced from Pro Football Reference and joined to ESPN IDs; `python scripts/nflverse.py`.

`scripts/features.py` derives player logs, team logs, defense-versus-position logs, last 5/10/20 and home/away/opponent splits from the store without network access. Every function that feeds a forecast takes a cutoff and uses only earlier games.

## Publishing research

`PROMPT.md` is the scheduled research run (8:30, 11:30, 17:30 and 23:30 Eastern) and `RESEARCH.md` holds the rules it follows. A run settles finished picks, closes picks whose line has moved past the entry rules, screens where v2 and the market disagree, researches and prices a few candidates, and publishes a dated JSON report to `research/`. Every number in a pick comes from `scripts/desk.py` or a linked source:

```
python scripts/desk.py slate NFL                                  where v2 and the market differ most
python scripts/desk.py price NFL-401872933 recYds over 45.5 -110 --player 4429795
python scripts/desk.py moves                                      open picks against the latest line
```

GitHub history preserves every change. Do not edit past predictions or outcomes to improve results; a correction is a separate, dated revision.

The Codex research automation is separate from GitHub's data/deployment workflow and depends on its host being available. No hosted LLM research or paid odds API is configured.
