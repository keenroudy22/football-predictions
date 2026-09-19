# Research standards

The rules for published picks and the record. `PROMPT.md` is the scheduled run that follows them, in order. `scripts/refresh.py` enforces the format on every run and `tests/test_integrity.py` freezes what has been published; when this file and the validator disagree, the validator wins and this file is wrong.

KeenRoudy Sports is entertainment for the owner, their brothers and friends. A pick is an opinion tracked at one unit so the record means something, not advice and not a wager anyone placed.

## The record

- **Immutable:** `research/*.json` (every published pick and settlement), `site/data/forecasts.json` (v1 baselines), `market-observations/*.json` (hand-recorded prices), `data/forecasts/` (v2 snapshots), every `ledger.json` and `tests/integrity-ledger.json`. Append new files; never edit, delete or regenerate one.
- **Revisions** are new report files that reuse the pick ID. The validator rejects a revision that changes a pick's league, kind, `title`, `gameIds`, `line`, `direction`, `marketType`, `legs` or `favorite`. A different number is a different pick with a new ID; withdraw the old one explicitly if it is replaced.
- **One unit.** Every pick risks one unit at its first published price. Units and ROI count recorded prices only; a pick without one stays in the win-loss record and out of returns. Never assume -110. ROI is shown once ten priced picks have settled.
- **Settlement:** `result` (`win`, `loss`, `push`, `void`), `actual` (what happened, in words), `actualValue` (the number, when the market has one), `settledAt` and `resultSource` (the ESPN box score). `void` only when the sportsbook's own rule voids the bet (a prop on a player who did not play, a cancelled game), with the rule cited. A player missing from a box score is not automatically a loss or a void: check participation and the book's rule. Unclear stays unsettled, with `settlementState` and `nextReviewAt`.
- **Favorites** are marked `favorite: true` when first published and can never change.

## Line moves

A published number is only available until the market leaves it. A pick closes to new entries when, at the book it was published at:

| Market | Closes when the number moves against the pick by |
|---|---|
| Player prop | 0.5 or more |
| Total | 1.5 or more |
| Spread | onto or across 3 or 7 |
| Price, same number | 15 cents or more (-110 to -125; +105 to -110) |

Moves toward the pick keep it open. `python scripts/desk.py moves` checks every open pick against the latest captured line.

When a pick closes, publish a revision with `status: "expired"` and an `entryNote` quoting the rule and the numbers. The original stays in the record at its published price and is graded as posted; the move is also its closing-line value. It is never re-priced, and never voided because the line moved. Voiding moved picks would remove exactly the picks the market disagreed with, which are the ones most likely to lose, and the record would flatter itself.

## Numbers come from code or a source

- **Model numbers:** `python scripts/desk.py price GAME MARKET SIDE LINE ODDS [--player ATHLETE_ID]` returns the v2 `projection` and 80% range, the chance at the line, the break-even of the price, the `edge` text and the `cutoff`. Copy them into the pick. Set `modelVersion` and `snapshotAt` from the output.
- **Stats:** last 5/10/20, splits, head-to-head, defense vs position and snap counts are on the site and in `site/data/app/` after `python scripts/build_site.py`. Cite them; do not recount by hand.
- **Prices:** the book's own page, read directly, with the URL and the time seen. ESPN's feed carries DraftKings' main prop lines without prices; that is a line, not a quote. Articles, widgets and screenshots are references. No price, no pick.
- **Where v2 is weak:** the closing line beats it on average (2025: NFL margin miss 9.71 against 10.21, FBS 11.91 against 12.48). It compresses FBS-FCS blowouts, early-season college ratings are thin, a player new to a team has a role set by one or two games, and college quarterback projections trail a plain last-5 average. `desk.py slate` flags these. A gap there is a question for research, not an edge.

## Timing

- Runs are at 8:30, 11:30, 17:30 and 23:30 Eastern. GitHub's hosted refresh runs late, so v2 snapshots and prop captures are whatever the last hosted run published; pull before working.
- Publish only before kickoff, checked against the clock when you publish. A game that will start before you finish is skipped.
- `quotedAt` is when you saw the price; it must not be after `publishedAt`. `expiresAt` is the next scheduled run or kickoff, whichever comes first, and it is never extended.
- A source that failed is reported as unavailable, never as "no value found".

## Report format

One file per run: `research/YYYY-MM-DD-<LEAGUE>-<HHMM>-<slug>.json`, dated and timed in Eastern. Files are public: no personal details, credentials or wager information.

| Field | |
|---|---|
| `league` | `NFL` or `CFB` |
| `publishedAt` | actual publication time, ISO UTC, never backdated |
| `summary` | a few sentences on the run |
| `props` | up to five core player props |
| `riskyProps` | up to three higher-variance props, tracked separately |
| `gamePicks` | spread and total picks |
| `parlays` | up to three, each at the book's actual combined price |
| `takeaways`, `weeklyReview` | optional short, sourced notes |
| `gameWatch` | optional candidates still being researched, each with `id`, `gameId`, `title`, `why`, `needs` and HTTPS `sources` |

Every pick has `id`, `title`, `why`, `risk`, HTTPS `sources` and `status` (`active`, `withdrawn`, `watch`, `expired`, `settled`). An active pick also has:

- `book`, American `odds`, `quotedAt`, `expiresAt`;
- `gameIds` from `site/data/slate.json`;
- `cutoff`;
- `confidence` 1 to 10 (research confidence, not a probability);
- `edge`.

Some kinds need more:

- **Props:** `projection`, `position`, `athleteId`, `market` (`recYds`, `rec`, `rushYds`, `car`, `passYds`, `cmp`, `att`), `line` and `direction` (`over` or `under`).
- **Game picks:** `marketType` (`spread` or `total`), `line` (the number for the side picked, so an away +3.5 pick has line 3.5) and `direction` (`home`, `away`, `over` or `under`). Exactly one game.
- **Parlays:** `legs` (two or more, each with its own market window) and `correlation`, explaining how the legs depend on each other.
- **College:** `jurisdictionVerified: true`, only after checking that the market is offered in Indiana.

```json
{
  "id": "NFL-2026-W2-gibbs-over-29-5-recyd-dk",
  "title": "Jahmyr Gibbs OVER 29.5 receiving yards",
  "status": "active",
  "favorite": true,
  "position": "RB",
  "athleteId": "4429795",
  "market": "recYds",
  "line": 29.5,
  "direction": "over",
  "gameIds": ["NFL-401872932"],
  "book": "DraftKings",
  "odds": -115,
  "quotedAt": "2026-09-17T15:33:05Z",
  "expiresAt": "2026-09-17T21:30:00Z",
  "projection": 33.0,
  "modelVersion": "v2.0",
  "snapshotAt": "2026-09-17T15:07:12Z",
  "edge": "(copied from desk.py price)",
  "cutoff": "(copied from desk.py price)",
  "confidence": 6,
  "why": "Why the market may be wrong, with each claim sourced.",
  "risk": "What would make this lose.",
  "sources": ["https://sportsbook.draftkings.com/...", "https://www.detroitlions.com/..."]
}
```

Older reports also carry `recentForm`, `marketSnapshots`, `books` and `hot`. The validator still accepts them, but new reports do not need them: the site computes form from the box-score store, and the book observation is `book`, `odds`, `quotedAt` and the source URL.

## Parlays

`legs` and the book's actual combined price, never multiplied single prices; `correlation` explains the joint assumption. Same-game legs need the book's own same-game price. Longshots are marked `parlayType: "longshot"` and are never a favorite by default. Pass if no combined price exists.

## Analyst score calls

Optional `scores` entries (`gameId`, whole-number `home` and `away`, `why`, `confidence`, `sources`) published before kickoff. They sit beside v1 and v2 on the scoreboard as "analyst" and never replace either.

## Operations

`python scripts/refresh.py` validates every report against the slate; `python -m unittest discover -s tests` must pass, including `tests/test_integrity.py`. If the integrity test fails, the record was changed: undo the change, never regenerate a ledger. Commit only the new report (and any new `market-observations/` file), then push. NBA and MLB are schedules and scores only until their own research and settlement rules exist; see `SPORTS-ROADMAP.md`.
