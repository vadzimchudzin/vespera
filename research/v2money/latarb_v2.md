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
