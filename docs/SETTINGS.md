# Settings and stake limits — 0.21.0

## Navigation

The form has six task-oriented sections: Strategy, Stakes & risk, Execution,
Polymarket, Telegram and Interface. Navigation preserves the mounted inputs;
hidden sections do not discard drafts. Credentials and service actions have
their own controls, separate from trading settings. The risk plan belongs
next to sizing and limits, not server credentials or visual preferences.

See [Telegram](TELEGRAM.md) for access requests and administrator onboarding.

## Sizing modes

| Mode | Next stake | Limitations |
| --- | --- | --- |
| ×2 | Base × 2^(step − 1) | Outcome prices and fees mean a winning step may not recover the series. |
| Fixed | The dollar amount at the current ladder step | Entry price never increases that amount. A stake cap may lower it. No guaranteed recovery. |
| Recover | Base + prior losses / net winning profit per dollar | Uses the current quote and fees. Expensive outcomes can cause very large stakes; use limits. |

Enter Fixed amounts with decimal points, separated by commas, semicolons or
new lines, for example `5, 10, 20, 40`. There must be 1–20 positive amounts,
each with at most two decimal places. Base becomes the first amount and
maximum steps becomes the ladder length. A win resets to step 1.

The first upgrade keeps the existing sizing mode; it does not automatically
switch a live account to Fixed. Existing valid settings are retained. Legacy
out-of-range numerical values are clamped on load; new invalid saves are rejected.

## Limits and preview

- **Max stake:** caps the stake, excluding fees. A cap may prevent recovery.
- **Max series loss:** accumulated series loss plus the prospective stake and
  fee must fit. Zero disables this limit. A refusal pauses before entry and
  does not advance the series or reduce the stake to fit.
- **Daily loss limit:** applies to net realised P&L, separately by Paper,
  dry run and live book. The prospective stake and fee must fit the remaining
  headroom. Starting a new series does not clear this total.
- **Max entry price:** a limit between 0.05 and 1.00; 1.00 disables it. Lower
  values skip expensive outcomes. This does not change Fixed stake amounts.

## The venue minimum lot

Polymarket refuses an order below its minimum lot (`min_order_size`, 5 shares for
the crypto Up/Down rounds). At an ask of 0.70 that lot costs $3.50, so a $1 stake
cannot be placed there at all — and the old build answered that with
`below_min_size` and paused the whole session, so a small lot silently stopped
trading until someone pressed Start.

Now the entry is priced and sized before it is signed:

- **Raise to the lot.** A stake under `minOrderSize × ask` is raised to the lot
  when the max-stake cap and the remaining series/daily budget allow it. The
  journal records `stake_raised_to_lot` and the log says what it did.
- **Skip, do not stop.** When the cap or the budget forbids the lot, the round is
  skipped (`skip reason: below_min_stake`) with the exact minimum in the journal;
  the series does not advance and trading continues on the next signal.
- **Wait for the round's own book.** A quote with no asks at the round open is not
  the new round's price. The entry re-reads the book up to three times, 700 ms
  apart, instead of sizing and pricing the bet from the previous round.
- **Spend the wallet, never overdraw it.** When the wallet cannot cover the planned
  stake and fee but can cover the lot, the order goes out at the stake the balance
  supports (`order_sized_to_balance`). Below the lot there is no valid order at any
  size, and `insufficient_balance` skips that round.
- **Bounded patience.** One or two funding skips do not stop Auto; three in a row
  pause it with the venue's own message, so an empty wallet still surfaces instead
  of quietly skipping every round.

## Entry order: marketable or resting limit

Settings → Execution → **Entry order** picks how a signal reaches the book.

- **Marketable** (default) signs a FAK limit at the ask plus slippage, capped by
  max entry price and the tick. It pays what the book asks, takes whatever depth
  is there in one go, and kills the rest. This is what the app has always done.
- **Resting limit** signs a GTC order at the same limit price and leaves it on
  the book for **Hold window** seconds (5–600, default 45), never past the round's
  close minus ten seconds. If it has not filled by then it is withdrawn with
  `DELETE /order`, and the round is skipped. A fill that arrives before the
  deadline is booked from the venue's confirmed trades, so a partial fill is the
  part that actually happened.

Resting entries trade differently on purpose: they never pay more than the limit,
and they can miss a move that runs away without them. They also hold the session
in `order_live` while they wait — Stop cancels within one poll (2 s), and a cancel
that fails pauses the session instead of trading on with an order nobody tracks.

Because a resting order can outlive the process, its hash is written to the
journal before the wait begins. On the next start the engine reads the last
`order_live` without an `order_closed` and settles it first: nothing new is opened
until that order is withdrawn. If it filled while the app was down, the engine
stops with `resting_order_recovered` and asks for reconciliation rather than
guessing what the position is.

The plan shows a fresh series at the last available quote, or an explicit
0.50 estimate when no quote is available. It includes fees and stops at the
series budget. Actual future prices, fees and partial fills can differ. It is
not a guaranteed maximum loss or a profit forecast. Live execution rechecks
the refreshed order cost before submitting; external fees/account activity
must still be monitored on the venue.

## Indicator settings

- Fast average: 2–200 bars. Slow average: 5–500 bars and always above the fast
  period; adjusting conflicting periods raises the slow period automatically.
- SMA/EMA selects both indicator lines and signal calculations.
- Minimum opening: `abs(fast − slow) / ATR(14)`, 0–2 in steps of 0.05.
- Minimum cross: `abs(close − fast) / exchange tick size`, 0–2000 ticks.
- Confirmations: 0–10 additional qualifying consecutive candles; the sequence
  length is value + 1. Qualification follows the Full body switch.
- Chart refresh: 1–2000 ms. This throttles drawing, not strategy evaluation;
  signals still use closed candles.

## Editing and starting a new series

Trading settings cannot change during an open position, test-bet round or
order preparation/pending execution. Sizing settings cannot change after a
loss until the series ends or is explicitly abandoned. Cosmetic settings,
notifications and chart refresh remain adjustable.

Save validates and persists; it never confirms or resets a series. To abandon
a losing series, Stop first, wait for any position to finish, and use New
series with confirmation. It does not recover money or erase daily losses.
An unknown live-order outcome cannot be cleared by this action; see
[STABILITY.md](STABILITY.md). Automatic exchange reconciliation and a guided
unknown-order repair screen remain future work.

## Upgrade and verification

Stop the application and back up its user-data folder before upgrading. No
new API key, server or database migration is required. Restore the matching
user-data backup with the old application if rolling back; old builds do not
understand Fixed mode or series budgets.

`npm test` includes all prior checks plus `settings.test.js` and
`settingsEngine.test.js`. UI verification uses the actual Electron renderer
with a disposable Paper profile, not production credentials. The managed
HTTP preview is a launcher status page, not a web version of the trading app.

## Verification

`src/main/settingsAudit.test.js` checks every setting end to end: the shared limits (edges accepted, outside and off-step values refused), the engine, a restart through the real host and settings store, the effect of each strategy setting on the signals of the same candles, and the binding of each window control to the shared limits. A new setting must be added to that test.
