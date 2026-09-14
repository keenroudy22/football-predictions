# Publication standards

Coverage: NFL and all FBS games, including FBS versus FCS, on every day of the week. Five props is a maximum, never a quota. Baseline scores are visibly separate from analyst research.

Research current teams, starters, injuries and official inactives, line availability, weather, pace, market spreads/totals, roles, usage and matchup. Check independent projections and provider overlap. Distinguish projected mean gap from probability edge and expected value. Label judgment estimates as uncalibrated. No stale roster assumptions or invented missing college data.

## File format

Create `research/YYYY-MM-DD-NFL.json` or `research/YYYY-MM-DD-CFB.json`. Files are public: no private user details, credentials, or actual wager information. Report fields:

- `league`: NFL or CFB
- `publishedAt`: actual ISO UTC publication time, never backdated
- `summary`: a short league research update
- `props`: zero to five picks
- `parlays`: zero to two cards, labelled Best-supported parlay or Speculative longshot
- `watch`: optional array of text thresholds, explicitly conditional

Each pick: `id`, `title`, `why`, `risk`, `sources` (HTTPS source links), `status` (active/withdrawn/watch/expired/settled). An active pick also requires `book`, American `odds`, `quotedAt`, `expiresAt`, `gameIds` matching slate IDs, `cutoff` (worst line and max juice), `confidence` 1–10 and `edge` (method, uncertainty, probability or EV if defensible). Props also include `projection`. College active picks require `jurisdictionVerified: true` following actual verification. No location guessing.

When a sportsbook, Playbook, GamblyBot, or another authorized provider returns a canonical share/deep link for the exact active market, add it as `bookLink`. The site shows it as “Open verified bet slip.” Do not manufacture a URL, scrape/deep-link a provider that prohibits automated access, or imply that opening the link places a wager. The user reviews and submits any wager in their sportsbook.

Parlays require `legs`, actual sportsbook combined `odds`, and `correlation` explaining the joint assumptions. Do not multiply individual probabilities while ignoring dependence. Pass if actual combined price is unavailable or no defensible value exists. Longshots are speculative, never the best bet by default.

Use short expiration windows for quotes. Expiry isn't a claim of continuous monitoring. Preserve original cards; publish changes in new timestamped report files with the same pick ID so the newest status supersedes the previous card. No silent deletion of losses, withdrawals or old prices.

## Analyst score revisions

Optional `scores` array: `gameId`, `home`, `away`, `why`, `confidence`, `sources`. Publication must precede kickoff. Original automatic forecasts remain untouched. The UI displays the latest published analyst forecast with a link to the original baseline. Results explicitly distinguish model baseline from analyst revisions.

## Results

Only forecasts published before kickoff count. Automatic scoreboard finals are ESPN-reported and not a substitute for official player-stat verification. Prop settlements must include `result` (win/loss/push/void), `settledAt`, `actual`, `resultSource` and original odds. Unknown outcomes stay unsettled. Flat hypothetical one-unit profits: win at positive odds = odds/100; negative = 100/abs(odds); loss = -1; push/void = 0. Do not infer real wagers.

## Operations

Run `python scripts/refresh.py`, `python -m unittest discover -s tests`, and `node --check site/app.js` before pushing. Commit only this repository. GitHub Actions publishes site updates and refreshes schedules/results three times daily. Research runs in the separate Codex task. No paid API services or autonomous hosted LLM research are configured. Missing data means pass/pending, not fabricated recommendations.
