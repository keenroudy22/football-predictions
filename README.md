# Football Forecast

NFL and FBS football forecasts, researched player props, and a public record of what was actually published before kickoff.

Static website hosted on GitHub Pages. No paid API, account signup, tracking scripts, or betting transactions.

## Run

Python 3.11+ and Node 20+; no package install required.

```
python scripts/refresh.py
python -m unittest discover -s tests
node --check site/app.js
```

`site/` is the deployable directory. GitHub Actions refreshes schedules/results throughout the day plus Eastern postgame windows, including weekday college games. Actions can run late; the page displays source timestamps. Turn off the workflow in GitHub Actions to stop it. No local background process is required.

## Two different kinds of forecasts

**Baseline score forecast:** automatic, opponent-adjusted Elo margin and smoothed team game totals from ESPN completed games. A transparent starting point, not a researched betting edge. Prior-season ratings regress 35% toward average. Newly observed teams start at league average. No roster, injuries, transfers, weather, or market inputs. Sparse-history games are flagged. Scores are rounded estimates, not exact-score bets. Model v1 is uncalibrated and has not demonstrated profitability.

**Analyst card:** source-backed score revisions, player props, and parlays published by the research task. The automatic schedule collector does not perform that research or invent recommendations. No card is shown as actionable after kickoff or when its quote expires. College prop jurisdiction availability must be verified before publication as actionable.

ESPN's public scoreboard feed is an unofficial integration without a service guarantee. Failure preserves the last good file and fails the workflow; timestamps identify stale data. Completed scores are provider-reported, not represented as independently verified official statistics.

## Publishing research

Read `RESEARCH.md`. Add a dated JSON report to `research/`, run validation and refresh, commit and push. GitHub history preserves changes; original score forecasts live in `site/data/forecasts.json`. Do not edit past predictions or outcomes to improve results. A correction must be a separate timestamped revision.

The Codex research automation is separate from GitHub's data/deployment workflow and depends on its host being available. No hosted LLM research or paid odds API is configured.
