# Engine Vision: concept screen for Vespera V2

A data-art screen for the BTC Up/Down 15m markets on Polymarket. It is a concept
for stage M7 of `docs/V2MONEY_PLAN.md`. It reads public data only and never
places orders.

## Run

```bash
python3 tools/engine-viz/build_data.py   # writes tools/engine-viz/data.js (about 75 KB)
open tools/engine-viz/index.html          # or any browser, file:// works
```

The builder uses the Python standard library only. Options are set with
environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `VIZ_WINDOWS` | `96` | Number of 15-minute windows (96 = 24 h) |
| `VIZ_BINANCE` | `https://data-api.binance.vision/api/v3/klines` | Klines endpoint; the public mirror also works where `api.binance.com` is blocked |
| `VIZ_V1_ROUNDS` | unset | Path to a V1 rounds JSON for the V1 check tile |

Page parameters: `?still&t=2&w=1920&h=1080&dpr=1` draws one fixed frame;
without `still` the page animates. `window.__vizDraw(t)` draws the frame for
time `t` (seconds), which is handy for recording video.

## Zones

1. **Probability web.** Grey threads are the real UP-price paths of the past
   windows. Each ends at its result (1 or 0). The yellow line is the model
   P(UP) for the live window. The white line with nodes is the market price,
   ending at the live book mid. The coloured fan shows 420 simulated futures
   from now to the close. Teal ends UP, orange ends DOWN.
2. **Ring.** The last 21 windows, the live one, and the next two. Each has a
   short log: open, result, model against market at minute 5, demo candidate,
   and the Chainlink start price with the Binance basis. The slot id `wNN` is
   the 15-minute slot of the local day (`w00` = 00:00).
3. **Flow.** Minute-by-minute UP-price changes per window. The first bar is
   volume. Yellow bars mark demo candidates.
4. **Terminal tiles:**
   - feeds and latency, with BTC 1 s over 15 minutes and the averaging minute
     that sets K
   - divergence per hour
   - 24 h clock of UP share by slot (90 days, with the noise level)
   - live order book
   - other open markets
   - the V1 result against real Polymarket prices

## Model and data

- The market resolves on the Chainlink BTC/USD TWAP over 60 s. Gamma
  publishes the start price as `eventMetadata.priceToBeat`, but only after the
  window ends.
- `priceToBeat` matches the mean of the Binance 1 s closes in the minute
  before the start, minus a basis. The spread was $1 over 14 windows; other
  offsets fit worse. The builder therefore works in Binance BTCUSDT units with
  that K, and the basis cancels out.
- The basis drifts during the day (for example +$83 to +$141 in 24 h) but is
  stable within an hour.
- Fair value is a digital option on the final 60 s average: effective variance
  `τ − 40 s` while more than 60 s remain. Volatility is the realised 1 m
  volatility over the last hour.
- The live market price comes from the CLOB book (`/book`, `/midpoint`).
  Gamma `outcomePrices` and `bestBid`/`bestAsk` lag for open markets.
  `prices-history` lags too, so it is used for history only.
- The taker fee is `0.07 × p × (1 − p)` per share. Taker edge in the NOW box =
  model − ask − fee for the better side.

## Limits

- **Demo candidates are not a backtest.** The rule (edge > fee + 3%) compares
  the model with `prices-history` points, not with an executable book. Those
  points can lag, so the rule fires in almost every window. Their hit rate is
  an artefact.
- Proof of edge needs stored order books (M0), a fill simulator (M1), and the
  edge certificate (M6). The V1 tile shows a real result: SMA signals priced at
  real window-open prices lose money.
