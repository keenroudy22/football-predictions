# Publication standards

Coverage: NFL and all FBS games, including FBS versus FCS, on every day of the week. Five props is a maximum, never a quota. Baseline scores are visibly separate from analyst research.

Research current teams, starters, injuries and official inactives, line availability, weather, pace, market spreads/totals, roles, usage and matchup. Check independent projections and provider overlap. Distinguish projected mean gap from probability edge and expected value. Label judgment estimates as uncalibrated. No stale roster assumptions or invented missing college data.

## File format

Create `research/YYYY-MM-DD-NFL.json` or `research/YYYY-MM-DD-CFB.json`. Files are public: no private user details, credentials, or actual wager information. Report fields:

- `league`: NFL or CFB
- `publishedAt`: actual ISO UTC publication time, never backdated
- `summary`: a short league research update
- `props`: zero to five core picks
- `riskyProps`: optional zero to three higher-variance player props, tracked separately from the core card and never used to fill the five-pick quota
- `parlays`: zero to two cards, labelled Best-supported parlay or Speculative longshot
- `watch`: optional array of text thresholds, explicitly conditional
- `takeaways`: optional short, sourced slate-level observations
- `weeklyReview`: optional array of settled-week lessons about workload, efficiency, matchup and injury assumptions

Each pick: `id`, `title`, `why`, `risk`, `sources` (HTTPS source links), `status` (active/withdrawn/watch/expired/settled). An active pick also requires `book`, American `odds`, `quotedAt`, `expiresAt`, `gameIds` matching slate IDs, `cutoff` (worst line and max juice), `confidence` 1–10 and `edge` (method, uncertainty, probability or EV if defensible). Props also include `projection` and `position` so the site can group QB, RB, WR, TE and other markets. College active picks require `jurisdictionVerified: true` following actual verification. No location guessing.

For a published prop, optionally include a verified `recentForm` object to show its market-specific hit rate: `stat`, an HTTPS `source` linking to the game log, plus `last5` and/or `last10` in the form `{ "hits": 3, "sample": 5 }`. A hit rate must use the same line direction and market as the published prop. Do not use a player’s generic stat average, a different prop threshold, or an unlinked memory-based count. If that verification is unavailable, omit the field and the live card will say that recent-form verification is pending. To render the visual game-by-game chart, include the same-market `line` and up to ten chronological `games`, each `{ "label": "Wk 1", "value": 64, "hit": true }`; `hit` must reflect that prop's actual direction at the stated line.

Use `books` for verified comparison quotes in the form `{ "book": "Book", "odds": -110, "line": 50.5, "quotedAt": "..." }`. Use `movementReason` only when a sourced injury, role, weather or market event plausibly explains a change. After kickoff, `closingLine`, `closingOdds` and `closingValue` may record a comparable pregame closing observation; never use a post-start feed as the close.

When a sportsbook, Playbook, GamblyBot, or another authorized provider returns a canonical share/deep link for the exact active market, add it as `bookLink`. The site shows it as “Open verified bet slip.” Do not manufacture a URL, scrape/deep-link a provider that prohibits automated access, or imply that opening the link places a wager. The user reviews and submits any wager in their sportsbook.

Parlays require `legs`, actual sportsbook combined `odds`, and `correlation` explaining the joint assumptions. Do not multiply individual probabilities while ignoring dependence. Pass if actual combined price is unavailable or no defensible value exists. Longshots are speculative, never the best bet by default. `riskyProps` must state the specific variance driver in `risk`; they are official one-unit tracked selections, but are shown separately and cannot be Daily Favorites unless explicitly marked.

Mark each published daily favorite with `favorite: true` at publication time. Keep its ID in the all-picks ledger too; the UI counts it once. Mark speculative parlays with `parlayType: "longshot"`. Every ticket is a hypothetical 1-unit risk at its first published sportsbook price. Record a fresh line/price snapshot with retrieval and source quote times when available. Never replace the original price during a revision. A score call is not a spread or total pick unless separately published as a priced selection.

Use short expiration windows for quotes. Expiry isn't a claim of continuous monitoring. Preserve original cards; publish changes in new timestamped report files with the same pick ID so the newest status supersedes the previous card. No silent deletion of losses, withdrawals or old prices.

## Analyst score revisions

Optional `scores` array: `gameId`, `home`, `away`, `why`, `confidence`, `sources`. Publication must precede kickoff. Original automatic forecasts remain untouched. The UI displays the latest published analyst forecast with a link to the original baseline. Results explicitly distinguish model baseline from analyst revisions.

## Results

Only forecasts published before kickoff count. Automatic scoreboard finals are ESPN-reported and not a substitute for official player-stat verification. Prop settlements must include `result` (win/loss/push/void), `settledAt`, `actual`, `resultSource` and original odds. Unknown outcomes stay unsettled. Flat hypothetical one-unit profits: win at positive odds = odds/100; negative = 100/abs(odds); loss = -1; push/void = 0. Do not infer real wagers.

At every research check, revisit unsettled results. Give each a specific `settlementState`, `lastCheckedAt`, `nextReviewAt` and reason. After 24 hours, consult an alternate reliable source and flag discrepancies. A player missing from a box score is not automatically a loss or void: check participation, official inactives and the original sportsbook rule. Historical imports with missing odds may show a hit rate but cannot show units or ROI.

After each week, record a short review of projected versus actual workload, target/carry mix, efficiency, positional defense and injury assumptions. Compare opponent strength and personnel before carrying a trend forward. Assign a version to changed score/prop methods and evaluate later games independently before claiming improvement. Keep the original forecast and its assumptions intact.

## Operations

Run `python scripts/refresh.py`, `python -m unittest discover -s tests`, and `node --check site/app.js` before pushing. Commit only this repository. GitHub Actions publishes site updates and refreshes schedules/results three times daily. Research runs in the separate Codex task. No paid API services or autonomous hosted LLM research are configured. Missing data means pass/pending, not fabricated recommendations.

