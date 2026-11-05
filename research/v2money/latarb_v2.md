# Pre-registered v2: BTC latency-arb, 24/7 paper phase, frozen 2026-11-05 07:10 UTC
Basis: v1 PASS on OOS hours 01-06 UTC (BTC edge@10s +4.30c, t_win 4.97; @res +7.54c) and live paper bot 04:19-06:58 UTC
(BTC 5m exit@10s +3.3c, BTC 15m -1.8c, ETH negative). Evaluate unchanged on data from 2026-11-05 08:00 UTC onward only.
- Signal, window filter, entry (best ask at Binance time + 150 ms, size <= 100 shares, fee 0.07*p*(1-p)): unchanged from v1.
- Primary: BTC 5m. Secondary: BTC 15m (report; trade it live only if its own exit@10s > 0 at certification).
  Control: ETH 5m/15m (expected <= 0; a strongly positive control => suspect simulator, stop and audit).
- Primary metric: realizable exit@10s = sell at best bid at +10 s, both taker fees, per share and in $; t clustered by window.
- Also report: mid edge @10s/@60s/@resolution, live-latency entry edge, P&L by hour and by day, ask survival at +300/+500 ms.
- Certificate (gate to a small real-money pilot): >= 2000 BTC trades with BTC 5m >= 1000 of them; primary exit@10s > 0 with
  one-sided p < 0.01; edge@resolution > 0; no single day > 50% of total P&L; >= 70% of full days positive.
- Kill switch: after >= 500 BTC 5m trades, exit@10s <= 0 => stop and re-examine; no parameter changes inside the test.

## Addendum A (frozen 2026-11-05 16:13 UTC, at the start of the run, before any SOL/XRP data was looked at)
- The v1 rule is applied unchanged (J 2.0 bps, cooldown 3 s, L 150 ms, size <= 100, fee 0.07*p*(1-p)) to SOL and XRP
  Up/Down 5m and 15m (Binance SOLUSDT, XRPUSDT). These are new assets: an out-of-sample test of the rule itself.
- Pass per asset (pooled 5m+15m), over >= 6 hours: exit@10s > 0 with window-clustered t > 2.5, and edge@resolution > 0.
  Report 5m and 15m separately; BTC/ETH continue as in v2.

## Addendum B (frozen 2026-11-05 16:59 UTC): the quiet-market filter
- Observation that motivates it (not a test): from 16:13 to 16:50 UTC the rule fired ~590 times an hour on BTC (median
  jump 2.06 bps) and BTC 5m was flat (exit@10s -1.15c, n 237); ETH/SOL/XRP were negative. The v1 OOS hours (01-06 UTC)
  had ~15 BTC 5m trades an hour and +5.6c. A 2 bps jump may carry information only when jumps are rare.
- Filter: trade a jump only if the same asset had <= 5 jumps (rule events after the cooldown) in the preceding 300 s.
  Computed from the bot's events log; no other change to the rule. The desk lane carries it as `maxJumps5m` (off).
- Test on data after the freeze, per asset, 5m and 15m separately: filtered exit@10s > 0 with window-clustered t > 2.5
  over >= 300 filtered trades, and filtered edge@resolution > 0. Also report the unfiltered rule and the trades the
  filter removes (expected <= 0). The v2 primary and its certificate are unchanged.
