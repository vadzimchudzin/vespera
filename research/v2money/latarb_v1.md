# Pre-registered: crypto latency-arb taker (paper), frozen 2026-11-05 01:20 UTC
Chosen on collector hour 2026-11-05 00 UTC only. Evaluate unchanged on hours 01 UTC and later.
- Signal: Binance spot 1s log-return of last trade vs price 1s earlier > J = 2.0 bps (abs), 3 s cooldown per asset.
- Markets: btc 5m and btc 15m Up/Down (primary); eth 5m/15m (control, expected ~0).
- Window: event at least 5 s after window start and 5 s before end.
- Action: buy the side in the jump direction (Up on up-jump, Down on down-jump) at the CLOB best ask
  as it stood at Binance exchange time + L, L = 150 ms (realistic: ~80 ms Binance receive + order transit),
  size = min(best ask size, 100 shares). Taker fee 0.07*p*(1-p) per share.
- Report: per-share edge after fee valued at mid +10 s, mid +60 s, and at resolution; $/event; t-stats by hour.
- Pass criterion (for moving to a live paper bot on a 24/7 host): over >= 6 OOS hours, BTC edge@10s > +3c/share
  with t > 3, and edge@resolution > 0.
