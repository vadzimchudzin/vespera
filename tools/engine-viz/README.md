# Engine Live: all of Polymarket in real time, crypto Up/Down engine

A live screen of every open Polymarket event, around the M7 "Engine" of
`docs/V2MONEY_PLAN.md` for the crypto Up/Down 5m and 15m markets (BTC, ETH,
SOL, XRP, DOGE, HYPE, BNB). The ring holds all open events (about 21k in the
Gamma catalog, about 17k slots), grouped by sector, and spins like a wheel
under the mouse. Every fill of every market is drawn as it happens. Every pixel
comes from live public Polymarket feeds: there is no simulation, demo signal,
proxy price, or estimated start price. The page never places orders. Its paper
test only reads the real book.

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
| `?nocache` | live, without the catalog cached in the browser |

`window.__vizDraw(t)` draws the frame at time `t`, which is how videos are
captured frame by frame.

Record from Node 22+ (built-in `WebSocket` and `fetch`, no npm packages):

```bash
node tools/engine-viz/live/record.mjs 660 rec.js 240        # 11 min; books kept for the last 240 s
node tools/engine-viz/live/record.mjs --cut rec.js.raw.jsonl rec.js 240   # cut the raw file again
```

The recorder writes every event with its arrival time to `<out>.raw.jsonl`
(books make that about 0.6 MB/s), asking for what the page would ask for over
a session: the details of the 1000 busiest events and of every event that
trades, the events of token-only fills, and the books of the leading market of
the 40 busiest events outside crypto Up/Down. The cut keeps everything but
books from the start, so the first replay frame already carries minutes of
trace. Books are kept only for the last part, starting from their real state
at the cut (rebuilt by the engine). Level changes are merged per token in
100 ms, and token and condition ids are shortened: 11 minutes give a 36 MB
file. Replay feeds the events through the same engine on the same 250 ms
clock, so a replay is the live run, frame for frame. A replay shows a book
only for the markets it recorded.

## Ring controls

| Input | Effect |
|---|---|
| drag (left button) | spin the ring; let go with speed and it spins on, slows down and settles on the event at the focus line |
| wheel | scroll events: a notch moves the ring in 0.12 s, and it settles on an event 0.13 s after the last one |
| Ctrl/⌘ + wheel, pinch, `+` `−` `0` | zoom out to 0.35× (about 180 slots in view) or in to 1.8× |
| click an event | bring it to the focus line |
| click a sector in the list (top right) | jump to the sector's first event (0.2–1 s, by distance) |
| click the minimap | jump to that place of the ring |
| `↑` `↓`, `PgUp` `PgDn` | previous or next event, 12 at a time |
| `Home` | back to BTC 15m |

The ring's clock is the frame time, so a replay captured frame by frame spins
the same way every time.

## Sources

| Feed | What | Used for |
|---|---|---|
| RTDS `wss://ws-live-data.polymarket.com`, `activity/trades` | every fill: wallet, outcome, side, price, size, fee | threads, wallets, fee check |
| RTDS `crypto_prices_chainlink` (unfiltered) | Chainlink spot, 1/s, all assets | S, volatility |
| RTDS `crypto_prices_twap_sixty` (unfiltered) | Chainlink 60 s TWAP, 1/s | K at the start second, X, result |
| RTDS filtered subscribe, once per asset | about 1 min of history | K after a reload |
| CLOB `wss://ws-subscriptions-clob.polymarket.com/ws/market` | `book`, `price_change`, `last_trade_price`, `tick_size_change`, `market_resolved`, both tokens | book, executable price, official result |
| Gamma `/events?slug=` | tokens, fee schedule, tick, minimum size, `priceToBeat`, `finalPrice` | market config, K and result cross-checks |
| Gamma `/events/keyset?closed=false&order=volume24hr` | the catalog: every open event, 100 a page, busiest first (about 210 pages) | ring slots, sectors, order |
| Gamma `/events?id=…&market_projection=card` | markets, outcomes, prices, tokens of the events in view, near the focus, where the ring is going, that trade, and the 1000 busiest; 30 a request, 2 in flight | focus rows, card, fill prices |
| Gamma `/markets?clob_token_ids=` | the event of a fill that came with its token only | token-only fills |
| CLOB market channel, the leading markets of the event in focus, its two neighbours either side and the last 8 in focus | `book`, `price_change` | focus book rays |
| CLOB REST `POST /books` | the books of newly watched tokens, at once | the book before the socket's snapshot |

Sockets reconnect with backoff. A socket that stays open but goes silent (RTDS
15 s, CLOB 30 s) is replaced, and after an RTDS gap the snapshot is fetched
again. Gamma is polled every 15 s, at most 4 requests at a time.

## Loading

The page asks for what the screen shows, nearest first:

- **Catalog.** The last full catalog is kept in the browser (IndexedDB, up to
  48 h old), so after a reload the ring is full in about 1 s while a fresh
  crawl runs (15–45 s). When the crawl ends, cached events it did not see are
  dropped if they have ended and did not trade.
- **Details** (markets, prices, tokens). The events in view, also while the
  ring turns at a readable speed, the newest request first; at rest 40 events
  either side of the focus; in the background the 1000 busiest events, the
  oldest request first. Where the ring is going (a jump's target, the wheel's,
  where a fling will stop) its event and 25 either side are asked for when the
  move starts. An ask that brought nothing is repeated after 8 s. Gamma returns
  20 results unless told otherwise, so every request sends `limit`.
- **Books.** The leading markets of the event in focus, of its two neighbours
  either side and of the last 8 events in focus stay subscribed, and the
  target of a move is subscribed on the way, so stepping, turning back or
  landing shows a live book at once. A new subscription gets its book over
  REST (about 0.1 s) until the socket's snapshot comes, which can take seconds.
  A book no longer watched is cleared, so it never shows stale levels.

Measured live in headless Chromium: the ring was full in 8–30 s from a cold
start (it depends on the network) and in about 1 s after a reload; 0.3 s after
a drag or wheel scroll all events in view had details and the focus had its
book; after a sector jump (1 s) both were there by 0.7–1.5 s.

## Screen

1. **Threads.** One thread is one real fill, of any market. It runs from the
   wallet's node on the left, bends at (time to the event's end, YES/UP price)
   and ends at its event on the ring. The time axis is logarithmic from years
   to an hour; its last part is the 15 minutes of the crypto windows. Teal = exposure to UP (buy UP or sell DOWN), orange = to DOWN.
   Threads are hairlines, and brightness = dollar size. A new fill flies to its
   market as a small spark (about 1300 px/s) and its thread grows behind it. On
   arrival a ripple marks the market's edge and the slot's tick flares. The
   thread then cools over about 12 s into the trace: the last 16 minutes, at
   most 14,000 fills (about 5 minutes with all markets). Some RTDS fills
   carry only the token: the page looks up its event (Gamma), and the fill
   joins its event when the details arrive, usually within 1–2 s. RTDS delivers
   fills in batches, so sparks often leave in waves. White and yellow lines are
   the BTC book mid and the model in the 5m and 15m windows. Their heads ripple
   when the mid moves a tick or the model moves 1% or more. Dashed lines mark
   "now".
2. **Ring.** Every open event, in sectors: КРИПТО, ПОЛИТИКА, ГЕОПОЛИТИКА,
   ФИНАНСЫ, ТЕХ · AI, КУЛЬТУРА, ПОГОДА, КИБЕРСПОРТ, СПОРТ, ПРОЧЕЕ. The sector
   comes from the Gamma tags; the first match wins, in the order crypto,
   esports, sports, politics, geopolitics, finance, tech, culture, weather.
   Up/Down windows of one asset and timeframe (1h, 4h, daily…) share one slot.
   Inside a sector the engine's slots come first, then series, then events by
   24 h volume plus this session's fills, as the site sorts them. The order is
   redone only when the ring changes, and a quiet event that trades is promoted
   at most every 5 s, so the ring does not twitch with every fill. Events with
   fills or at least $100 of 24 h volume get a full slot; events with no volume
   get 0.15 of one, and runs of them are drawn as faint dashes with a count.
   Near the focus line the slots grow (a fisheye); the slot at the line is
   open: its markets with prices, its latest fills, and a card with sector,
   end, volume and markets. The engine slots keep their full rows: seven assets
   × 5m and 15m, plus BTC previous and next windows, with τ, book, model, edge
   both ways, σ60, K, S − K, flow, the paper position, and the reason when it
   stays out; ended windows show the result by rule and the official one.
   Fills of events out of view go to the edge marks above and below, with their
   count. The minimap (top right) shows the whole ring with every sector, the
   part in view and the live fills.
3. **Rays.** For the market in focus: its book level by level, as soon as the
   ring stops on it (BTC 15m and 5m always: the UP book, with yellow marks for
   what 5 shares would take). A level flashes when it changes. Other
   slots show their latest fills.
4. **Tiles:** feeds (events/s, delivery delay), Chainlink BTC with the TWAP and
   K lines, the model graph (what moved P(UP) in the last 250 ms step), the
   book, top wallets, and the paper test.

## Drawing cost

The page draws at most 60 frames per second, whatever the display refresh
rate, and caps the pixel ratio at 2. Each layer is redrawn only as often as its
content changes:

| Layer | Redrawn |
|---|---|
| Background, grid, trace | wallet → bend halves of the cooled threads every 30 s; bend → ring halves when the ring comes to rest, in a back buffer at 600 a frame; while the ring moves, only the ring halves of the 700 newest cooled threads |
| Motion layers | while the ring moves, what stays put is drawn over 6 frames into a back buffer and swapped in whole: the wallet → bend halves of the landed hot threads, and the ring halves of threads that land deep in a portal (where a slot moves under half a pixel); a layer is dropped when the order or zoom changes, when the ring turned further than it allows, or after 1 s |
| Ring | the band and its rolled-up ends: one cached bitmap per canvas size, so the band needs no clip; slots and text 4 times per second at rest, every frame while the ring moves |
| Panels | 8 times per second |
| Hot threads in flight, sparks, book rays, BTC lines, "now" box, minimap | every frame |

All thread strokes are at most 1 device pixel wide and use normal alpha
blending, so Skia draws them on its fast hairline path. Colour strings are
cached per alpha step, so strokes do not allocate. With all markets there are
about 45 fills a second, so about 500 hot threads. Merging them into a few
dozen paths was slower in Skia's software raster (22 ms against 17 ms), so
each keeps its own stroke.

Measured in headless Chromium with software raster at 1920×1080, pixel ratio
1, on the all-markets recording 60 s in (6,453 fills, 17k slots; 150 frames a
state, JavaScript + raster, median and 95th percentile):

| State | Before motion layers | Now |
|---|---|---|
| at rest | 9.9 ms (p95 14.6) | 6.9 ms (p95 11.2) |
| zoomed out, about 180 slots in view | 12.3 (17.6) | 7.7 (16.0) |
| dragging | 18.3 (21.7) | 10.7 (17.9) |
| wheel scrolling | 19.3 (23.0) | 12.0 (16.5) |
| fling | 21.3 (25.0) | 12.7 (19.2) |
| zoomed out, wheel scrolling | 21.5 (33.2) | 14.2 (19.9) |

The frames are the same as before (PSNR about 58 dB; 2–5 pixels differ). A
GPU canvas is much faster.

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

## Checked on the all-markets recording (4 Nov 2026)

- 11 minutes, 08:07–08:18 UTC: 29,892 fills (about 45 a second) on the ring,
  20,937 events in the catalog, 17,192 slots.
- Token-only fills: 182 tokens in 11 minutes; their events were found through
  Gamma and the fills joined them.
- Inactive placeholder markets ("Person A", "Other") are hidden, as on the
  site: 3,215 of them in the 1,282 events with details.
- Book snapshots at the cut: 75 (35 engine tokens, 40 others). Several
  election markets had one-sided books (for example the House 2026 YES at
  0.999 with no asks), and the CLOB REST `/book` showed the same.

## Limits

- K is exact only for windows the page saw start (or within the ~1 min
  snapshot after a reload, or saved earlier).
- σ60 warms up for 5 minutes after the page opens.
- Polymarket is moving the RTDS price topics to PolyBolt, which needs
  credentials. A server version should read prices from PolyBolt.
- Paper is taker only and fills against the visible book at the decision
  moment: no latency, no queue position, no partial fills.
- The CLOB feed carries about 1000–1600 events/s.
- A book is drawn only for the market in focus (and the engine's markets);
  about a dozen are kept live around it. Books of all 17k events would be a
  far bigger stream than the page needs.
- Idle events (no 24 h volume) get thin slots; scroll or zoom to read them.
- The catalog (about 210 pages) loads in 15–45 s, busiest events first; until
  then the ring shows the cached one (up to 48 h old).

## Files

| File | Role |
|---|---|
| `index.html` | page: live, replay and still modes |
| `live/core.js` | engine: event clock, books, K and results, model, paper |
| `live/universe.js` | all events: catalog, sectors, ring order, details, token-only fills, focus books |
| `live/feeds.js` | RTDS, CLOB and Gamma connections (browser and Node) |
| `live/render.js` | canvas renderer: frame, input and ring motion, threads and their layers |
| `live/ring.js` | renderer: ring band, engine rows, focus book and card, minimap, sector list |
| `live/tiles.js` | renderer: panels under the ring |
| `live/record.mjs` | recorder for replay and video |
