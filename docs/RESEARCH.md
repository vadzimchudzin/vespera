# Research lab — backtest and parallel Paper

The lab pins an immutable saved setup version and runs only virtual books.
It never receives the live broker, account credentials or signing key.
Starting a research run does not start the trading terminal and cannot place
a Polymarket order, even if the terminal is in Auto real-money mode.

## Historical simulation

Select one saved version, a starting virtual balance and run a backtest.
The runner uses the same strategy evaluator and Paper/risk utilities as forward
experiments. It evaluates only closed candles up to signal S, opens on S+1,
and settles against that entry round. Data gaps block signals rather than
inventing candles. Dataset fingerprints, pinned parameters and stored input
candles identify the replay; repeating the same data/configuration yields the
same economic results.

Current simulations assume outcome price **0.50** and the configured crypto
fee schedule, with Binance determining Up/Down. They are explicitly approximate:
historical Polymarket asks, liquidity, slippage and final venue outcomes are not
reconstructed. Never describe these results as historical real-money returns.
Unsettled last-round positions remain open, not counted as wins/losses.

## Forward Paper experiments

Select up to ten exact setup versions. Each book has its own virtual balance,
position, series, risk limits and results; changing or stopping one run cannot
change the other books or the live trading series. Market subscriptions are
shared by symbol/timeframe, not created per setup. The experiments belong to
the selected executor: a server-owned lab continues without an open desktop,
and an inactive local executor does not automatically take over remote runs.

Restart restores persisted books and positions. Ownership handoff must not
discard an active experiment or allow duplicate market runners. Stop prevents
new entries but must retain and finish an already-open virtual round.

Restored sessions remain stopped; selecting the executor resumes settlement
checks for an existing position, not automatic new entries. Research history
is executor-specific and is not cloned with the trading-book handoff. Stop
experiments and finish their open virtual rounds before changing executor.
The persisted lab holds at most 30 runs, 5,000 input candles per run and 20,000
settled trades per book; a trade-history ceiling prevents new entries rather
than silently dropping earlier losses. The current Binance loader normally
provides up to 2,000 candles even when a larger sample limit is selected.
Periodic reports are available on demand by day/week/month; scheduled delivery
is not included in this release.

## Reports

Compare net P&L, fees, drawdown, win rate, series depth and sample size for the
pinned versions. Day/week/month views are comparison windows, not evidence
of statistical significance. CSV exports are virtual research reports, separate
from account trades. Do not select a winner based solely on highest P&L;
consider risk and sample size. No profitability guarantee is implied.

## Verification boundaries

Tests exercise repeatability, no-lookahead, gaps, isolated balances/series,
bounded persistence, restart, shared feed counts and absence of live broker
calls. Screenshots use an isolated profile. Production network continuity,
historical real venue prices and a long-running multi-book soak require separate
evidence; short tests do not establish unattended 24/7 reliability.
