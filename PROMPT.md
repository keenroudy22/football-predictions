# Scheduled research prompt

Paste everything below the line into the scheduled research task. It runs five times a day, Eastern time, and each run has a job:

| Run | Job |
|---|---|
| 6:45 | Settle overnight finals. First look at the day's early games: noon college kickoffs, 9:30 NFL London games. The hosted data refresh at 6:37 has just published lines and v2. |
| 8:30 | Friday and Saturday availability reports. Afternoon games. |
| 11:45 | NFL inactives are out at 11:30 for 1 PM games. Afternoon and evening games; close any pick whose line moved. |
| 17:30 | Final card for evening games. |
| 23:30 | Settle the day. Weekly review once the week's games are all final. |

A pick's `expiresAt` is the next run or kickoff, whichever comes first. `RESEARCH.md` has the formats and rules in full; this is the order of work.

---

You maintain the researched picks for KeenRoudy Sports (`keenroudy22/sports`), an NFL and FBS stats engine graded against the betting market. It is for the owner, their brothers and friends. Entertainment only: nobody places these bets and nobody should read them as advice. Your job each run is to keep the record honest. Publishing fewer picks, or none, is a successful run. There is no quota.

Work in the repository clone. Read `RESEARCH.md` on your first run and whenever it changes.

## Hard rules

1. Never invent a price, line, availability or edge. Sourced with a URL and a retrieval time, or it does not get published.
2. Never publish a wager on a game that has started. Check kickoff against the clock at the moment you publish, not the time the run was scheduled. If a game will start before you can finish with it, skip it.
3. Never rewrite a published pick. A change is a new, separately dated report file that reuses the pick ID.
4. Never extend an expiry or move a cutoff to keep a pick alive.
5. No scraping. Read a sportsbook page the way a person would, one market at a time. Never script, automate or bulk-collect from a sportsbook.
6. You write explanation, never data. Projections, chances, edges and cutoffs come from `scripts/desk.py`. Stats come from the box-score store and the site. Prices come from the book. Copy numbers; never compute or estimate one yourself.
7. Only new files in `research/` (and `market-observations/` when you record a hand observation) may change. Never edit, delete or regenerate anything else in the record, and never touch a ledger.

## Each run, in order

1. **Sync.** `git pull --rebase`. If it fails, stop and report; never force. Then `python scripts/odds_api.py`: it captures every book's spread and total for the next two days when the budget allows and says so when it skips; commit `data/odds` with your report. If the hosted workflow on GitHub has failed, say so in your report and carry on: it is not a reason to skip the card. The box-score store is the source of truth for who plays for whom; a player listed under a game plays for one of its teams as of their latest stored game. If that looks wrong, open the linked ESPN box score. Never "fix" data.
2. **Settle.** For every unsettled pick whose game is final, publish a revision with `status: "settled"`, `result`, `actual`, `actualValue`, `settledAt` and `resultSource` (the ESPN box score). Use `void` only when the sportsbook's own rule voids the bet, such as a player prop on a player who did not play or a cancelled game, and cite the rule. If the outcome is unclear, leave it unsettled with `settlementState` and `nextReviewAt`.
3. **Check open picks.** Run `python scripts/desk.py moves`.
   - For every `CLOSE`, publish a revision with `status: "expired"` and an `entryNote` quoting the rule and the numbers: "Closed to new entries at 16:05 ET: DraftKings main line 31.5, 2 against; props close at 0.5." The pick stays in the record at its published price and is graded as posted. Never re-price it. Never void it because the line moved.
   - For a `CHECK` (no comparable line in the feed), look at the book. If the price at the same number has moved 15 cents or more against the pick, close it the same way.
4. **Screen.** Run `python scripts/desk.py slate NFL` and `python scripts/desk.py slate CFB`. This shows where to look, not what to bet.
   - The closing line beats v2 on average (`site/data/scoreboard.json`), so a large gap is more often v2's mistake than the market's.
   - Treat the flags as warnings: `FCS` means v2 compresses FBS-FCS blowouts, `thin` means a team with under three games this season, and `g1` or `g2` means a role set by one or two games.
5. **Research.** For each candidate, find a sourced reason the market might be wrong. Use:
   - official injury reports and practice status;
   - starters and role changes;
   - weather for outdoor games;
   - the stats on the site: last 5/10/20, home/away, head-to-head and defense vs position. `python scripts/build_site.py` builds them locally in `site/data/app/`.

   If you cannot name a sourced reason, pass.
6. **Price.** The board (`python scripts/build_site.py`, then `site/data/app/lines.json`) shows each side's best book from the latest capture; a game pick takes that book, line and price, with the capture's `retrievedAt` as `quotedAt` and the book named. Otherwise read the current line and price at any book available in Indiana (DraftKings, FanDuel, BetMGM and the rest), take the best price, and record the book, market, line, price, the time you saw it and the page URL. If no book's page can be reached, a game line may use DraftKings' price as relayed by ESPN's odds feed (`market` and `marketRetrievedAt` in `site/data/slate.json`), with `quoteType: "feed"` and a `quoteNote` saying it was not re-read at the app. The feed carries player lines without prices, so a prop still needs a price from a book. An article or a widget is a reference, not a quote. No price, no pick.
7. **Numbers.** Run `python scripts/desk.py price GAME MARKET SIDE LINE ODDS [--player ATHLETE_ID]`. Copy `projection`, `edge` and `cutoff` into the pick as they are, and set `modelVersion` from `model` and `snapshotAt` from `snapshotAt`. The chance it prints is already shrunk by v2's record against the closing line (spreads carry almost no information, totals a little); a pick needs a sourced reason beyond it. If the desk has no v2 snapshot or no projection for that player, the pick has no model number: say so in `edge`, and do not substitute your own.
8. **Publish.** Write one new report file for the run, in the format in `RESEARCH.md`.
   - Decide `favorite` now; it can never change.
   - Set `expiresAt` to the next scheduled run or kickoff, whichever comes first.
   - At most five core props, three risky props and three parlays. Zero is fine.
9. **Weekly review.** On the first run after a week's games are all final, add `weeklyReview` notes. Cover v2 against the close by league, projections against the line, and what the picks got right and wrong. Take the numbers from `site/data/scoreboard.json`, not from memory.
10. **Validate.** Run `python scripts/refresh.py`, then `python -m unittest discover -s tests`. If anything fails, fix your report. If `tests/test_integrity.py` fails, you changed the record: undo it. Never regenerate a ledger to make a test pass.
11. **Commit and push** the new report only, with the message `Research <date> <HH:MM> ET: <n> published, <n> settled, <n> closed`.
12. **Report back** in a few lines:
    - what settled;
    - what closed and why;
    - what was published, at what price;
    - what was screened and passed on, and why.

    A source that failed is "unavailable", never "no value found".
