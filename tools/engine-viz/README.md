# Engine Live: real-time screen for Polymarket crypto Up/Down

A live screen for the Polymarket crypto Up/Down 5m and 15m markets (BTC, ETH,
SOL, XRP, DOGE, HYPE, BNB). It is the M7 "Engine" screen of
`docs/V2MONEY_PLAN.md`. Every pixel comes from live public Polymarket feeds:
there is no simulation, demo signal, proxy price, or estimated start price.
The page never places orders. Its paper test only reads the real book.

## Run

Open `tools/engine-viz/index.html` in a browser (`file://` works). It needs
internet access to Polymarket and no keys.

| Parameter | Meaning |
|---|---|
| none | live mode |
| `?replay=rec.js&from=s` | play a recording, starting `s` seconds in |
| `?still&t=s` | draw one frame at time `t` (s after `from`) |
| `w`, `h`, `dpr` | fixed canvas size |
| `?record` | live, plus `window.__vizDump()` returns a recording |

`window.__vizDraw(t)` draws the frame at time `t`, which is how videos are
captured frame by frame.

Record from Node 22+ (built-in `WebSocket` and `fetch`, no npm packages):

```bash
node tools/engine-viz/live/record.mjs 840 rec.js 300   # 14 min; books kept for the last 300 s
```

The recorder stores every event with its arrival time. Replay feeds them
through the same engine on the same 250 ms clock, so a replay is the live run,
frame for frame.

## Sources

| Feed | What | Used for |
|---|---|---|
| RTDS `wss://ws-live-data.polymarket.com`, `activity/trades` | every fill: wallet, outcome, side, price, size, fee | threads, wallets, fee check |
| RTDS `crypto_prices_chainlink` (unfiltered) | Chainlink spot, 1/s, all assets | S, volatility |
| RTDS `crypto_prices_twap_sixty` (unfiltered) | Chainlink 60 s TWAP, 1/s | K at the start second, X, result |
| RTDS filtered subscribe, once per asset | about 1 min of history | K after a reload |
| CLOB `wss://ws-subscriptions-clob.polymarket.com/ws/market` | `book`, `price_change`, `last_trade_price`, `tick_size_change`, `market_resolved`, both tokens | book, executable price, official result |
| Gamma `/events?slug=` | tokens, fee schedule, tick, minimum size, `priceToBeat`, `finalPrice` | market config, K and result cross-checks |

Sockets reconnect with backoff. A socket that stays open but goes silent (RTDS
15 s, CLOB 30 s) is replaced, and after an RTDS gap the snapshot is fetched
again. Gamma is polled every 15 s, at most 4 requests at a time.

## Screen

1. **Threads.** One thread is one real fill. It runs from the wallet's node on
   the left, bends at (moment in its window, UP price) and ends at its market
   on the ring. Teal = exposure to UP (buy UP or sell DOWN), orange = to DOWN.
   Width = dollar size. A fill burns for about 5 s with a white pulse, then
   cools into the 16-minute trace. White and yellow lines are the BTC book mid
   and the model in the 5m and 15m windows. Dashed lines mark "now".
2. **Ring.** Seven assets × 5m and 15m, plus BTC previous and next windows.
   Each slot shows τ, book, model, edge both ways, σ60, K, S − K, flow, the
   paper position, and the reason when it stays out. Ended windows show the
   result by rule and the official one.
3. **Rays.** For BTC 15m and 5m: the UP book level by level. A level flashes
   when it changes; yellow marks show what 5 shares would take. Other slots
   show their latest fills.
4. **Tiles:** feeds (events/s, delivery delay), Chainlink BTC with the TWAP and
   K lines, the model graph (what moved P(UP) in the last 250 ms step), the
   book, top wallets, and the paper test.

## Model

- **K** = the TWAP-60 stream value at the window's start second. It is saved in
  `localStorage`, so a reload keeps it. If the page did not see the start (and
  the RTDS snapshot no longer covers it), K stays unknown and the model stays
  off until Gamma publishes `priceToBeat`.
- **Result** = TWAP-60 at the end second ≥ K → Up. The official result comes
  from the CLOB `market_resolved` message or from Gamma.
- **Fair value** P(UP) for TWAP(end) ≥ K, with S = Chainlink spot and X = the
  current TWAP:
  - τ > 60 s: mean S, sd S·σ·√(τ − 40).
  - τ ≤ 60 s: mean X + (τ/60)(S − aOld), sd S·σ·√(τ³/10800), where aOld is
    the price leaving the average.
- **σ60** = σ per √s from overlapping 60 s Chainlink log returns over up to one
  hour. It needs 5 minutes of data. The BTC ring slots and the model tile also
  show σ1, the variance ratio and the σ implied by the book mid.
- **Executable price** = 5 shares (the market minimum) taken from the live
  book: UP from the UP asks, DOWN from the UP bids flipped (1 − bid). The fee
  is added per share.
- **Paper:** one entry per window when edge ≥ 3% after the fee, at least 10% of
  the window has passed, τ ≥ 30 s, and the spread ≤ 5¢. The tile shows the
  30 s markout, the open positions at what the bids would pay now, and the
  result when the window settles. Entries are kept in `localStorage`.

## Checked on live data (3 Nov 2026)

- K: 30 of 30 windows (7 assets, 5m and 15m) equal Gamma `priceToBeat`
  exactly. Gamma fills `priceToBeat` only around the end of a window, and
  `finalPrice` later still.
- Result: 34 of 34 windows match the official outcome (27 by the TWAP stream,
  7 by Gamma `finalPrice`).
- Fee: `shares × 0.07 × p × (1 − p)` USDC. On real fills the median ratio of
  the charged fee to this formula is 1.000. About a third of fills carry a fee
  (the takers).
- Book: UP bids = 1 − DOWN asks with the same sizes. Some changes arrive only on
  the DOWN token, so the UP book is built from both. In 18 of 18 REST `/book`
  probes the engine book matched level for level, about 0.1 s after the REST
  timestamp.
- Volatility: Chainlink 1 s returns are autocorrelated. The 60 s / 1 s
  variance ratio was 3.4 on a 16-minute sample and 1.5 on the 14-minute
  recording, so σ from 1 s returns understates 60 s risk by 1.2–1.8×.
- Paper on the recording 22:20:40–22:34:40 UTC: 14 entries, all settled by the
  official result. 5 won; the total was −$13.50 on $38.50; the mean 30 s
  markout was −6.5%. A model that sees only Chainlink lost to the book here:
  the book reflects information that leads Chainlink. It is one short and
  highly correlated sample, so it shows no edge rather than proving there is
  none.

## Limits

- K is exact only for windows the page saw start (or within the ~1 min
  snapshot after a reload, or saved earlier).
- σ60 warms up for 5 minutes after the page opens.
- Polymarket is moving the RTDS price topics to PolyBolt, which needs
  credentials. A server version should read prices from PolyBolt.
- Paper is taker only and fills against the visible book at the decision
  moment: no latency, no queue position, no partial fills.
- The CLOB feed carries about 1000–1600 events/s. Frames take about 5–25 ms to
  draw in Chromium.

## Files

| File | Role |
|---|---|
| `index.html` | page: live, replay and still modes |
| `live/core.js` | engine: event clock, books, K and results, model, paper |
| `live/feeds.js` | RTDS, CLOB and Gamma connections (browser and Node) |
| `live/render.js` | canvas renderer |
| `live/record.mjs` | recorder for replay and video |
