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
python -m unittest discover -s tests
node --check site/app.js
node --test tests/*.test.js
```

`site/` is the deployable directory. GitHub Actions refreshes schedules/results throughout the day plus Eastern postgame windows, including weekday college games. Actions can run late; the page displays source timestamps. Turn off the workflow in GitHub Actions to stop it. No local background process is required.

## Two different kinds of forecasts

**Baseline score forecast:** automatic, opponent-adjusted Elo margin and smoothed team game totals from ESPN completed games. A transparent starting point, not a researched betting edge. Prior-season ratings regress 35% toward average. Newly observed teams start at league average. No roster, injuries, transfers, weather, or market inputs. Sparse-history games are flagged. Scores are rounded estimates, not exact-score bets. Model v1 is uncalibrated and has not demonstrated profitability.

**Analyst card:** source-backed score revisions, player props, and parlays published by the research task. The automatic schedule collector does not perform that research or invent recommendations. No card is shown as actionable after kickoff or when its quote expires. College prop jurisdiction availability must be verified before publication as actionable.

ESPN's public scoreboard feed is an unofficial integration without a service guarantee. Failure preserves the last good file and fails the workflow; timestamps identify stale data. Completed scores are provider-reported, not represented as independently verified official statistics.

## Box-score store

`data/boxscores/<league>-<season>.jsonl` holds one line per completed NFL and FBS game: team stats, every player with an offensive or kicking line, play-derived red-zone work and success rates, points by quarter, and the provider's open and close spread, total and moneyline. Each line names its ESPN event ID, the three source URLs and its retrieval time. Coverage starts with the 2024 season. It is not deployed; the site will read small derived files instead.

- **Append-only.** A line is never edited. A later read with different content, such as an official stat correction four days after the game, appends a revision; the last line for an event is current. `data/boxscores/ledger.json` hashes the lines each file holds and `tests/test_boxscores.py` fails if one changes. Never regenerate the ledger to make that test pass.
- **Sources.** Box score from the ESPN `summary` endpoint; play-by-play participants and closing lines from ESPN's core API. Closing lines are DraftKings for 2026 and ESPN BET for 2024 and 2025. In-game odds are never used. A game with no pregame provider has no line, not an estimate.
- **Limits.** ESPN publishes no snap counts, so none are recorded. College box scores list no targets and no sacks per quarterback; both come from play-by-play. NCAA scoring counts sacks as quarterback rushes, so official college rushing lines include them. Intercepted passes carry no receiver tag, so play-derived targets run slightly under official NFL targets; the official number is used wherever it exists. A player with no recorded stat in a game has no line for it.

```
python scripts/boxscores.py                    new finals in site/data/slate.json (the hosted workflow runs this)
python scripts/boxscores.py --backfill NFL 2025
python scripts/features.py                     coverage and agreement with official box scores
```

`scripts/features.py` derives player logs, team logs, defense-versus-position logs, last 5/10/20 and home/away/opponent splits from the store without network access. Every function that feeds a forecast takes a cutoff and uses only earlier games.

## Publishing research

Read `RESEARCH.md`. Add a dated JSON report to `research/`, run validation and refresh, commit and push. GitHub history preserves changes; original score forecasts live in `site/data/forecasts.json`. Do not edit past predictions or outcomes to improve results. A correction must be a separate timestamped revision.

The Codex research automation is separate from GitHub's data/deployment workflow and depends on its host being available. No hosted LLM research or paid odds API is configured.
