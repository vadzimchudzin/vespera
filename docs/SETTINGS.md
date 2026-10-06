# Settings and stake limits — 0.19.0

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
