# Changelog

All notable versions of **Vespera (VSP)**. Tag `vX.Y.Z` to cut a build.

## 0.10.0 — 2026-09-22

- **Real Polymarket quotes.** The venue now reads `/price`, `/midpoint` and `/book` for the live round. Entries are priced off the best ask, and the payout multiple is `1 / price` — Polymarket pays $1 per winning share, so an ask of 0.72 returns ×1.39, not ×2.
- **Paper settles on that same payout.** Results now match what the venue would actually pay. A winning $10 bet at 0.72 books +$3.84, a loss books the full −$10. Without a quote the broker falls back to the old flat ×2 so offline runs still work.
- **Live orders actually send.** The engine passed `{side, sizeUsd, round}` while the adapter expected `{tokenId, makerAmount}` — every live order died on `missing_tokenId`. The adapter now resolves the round, prices the book and sizes the order itself, in USDC micro units.
- **Order payload fixed.** The signature goes inside the order object, `side` is sent as `BUY`/`SELL`, `salt` as a number, and `owner` is the API key rather than the wallet address. The CLOB rejected the old shape.
- **Minimum order size is enforced before signing.** Polymarket requires 5 shares; a $1 lot at 0.50 is 2 shares and is now refused with the minimum lot in the message instead of a blind rejection.
- **Private key has a home.** The API panel takes it, `settingsStore` encrypts it with the other secrets, and it survives a restart. Before, nothing persisted it, so Auto always stopped at `auto_blocked: privateKey not set`.
- **Live rounds settle.** An Auto bet is tracked, closed against its round bar, and feeds the series, journal, chart markers and balance refresh. Previously the engine sat in `waiting_settlement` forever and kept firing new signals.
- **EMA.** `Average` in Settings switches both lines and every entry rule between SMA and EMA, seeded the TradingView way. Periods stay editable; chart legend and labels follow the choice.
- **1m no longer bets on the wrong round.** Polymarket only lists 5m and 15m Up/Down markets. Any other timeframe used to fall through to the 15m slug silently; it now reports `timeframe_unsupported`.
- Marker replay caches its moving-average series instead of recomputing per bar.

## 0.8.9 — 2026-09-21

- API panel keeps stored credentials. `apiKey`, `secret` and `passphrase` are never sent back to the window; an empty field means "keep what is saved", so pressing **OK** after a restart no longer wipes the keys.
- Credentials are encrypted at rest (Electron `safeStorage`, machine-bound AES-256-GCM fallback). Old plain configs are read once and re-encrypted. `settings.json` is written with 0600.
- The **OK** lamp only turns green when the L2 credentials are actually accepted. Rejected keys report `l2_failed` instead of a green dot.
- Journal rotates at 10 MB across 5 files and keeps at most 5000 entries in memory, so a long-running install no longer grows a single unbounded log.
- Halt threshold follows the **max steps** setting after a restart. Before, the restore path always assumed 6 losses.
- An arrow is drawn only for an order that actually happened. A rejected order (for example `insufficient_balance`) no longer leaves a phantom marker on the chart.
- Base lot typed in Settings is normalised and applied to the running series.
- **Full body on S** help text corrected: the two modes are different filters, not stricter/looser. Close-through needs the candle to touch the SMA, full body needs it entirely beyond the line — on fast timeframes the toggle can produce more arrows, not fewer.
- New `persistence.test.js` suite covers rotation, halt restore, credential retention, encryption and marker/order consistency.

## 0.8.8 — 2026-09-17

- **Full body on S** toggle in Settings. Off (default) = close through SMA20, more arrows (v0.8.3). On = entire body of the needed color beyond the line (v0.8.4). Pullback on S-1 stays body-only either way.
- Confirms fire only on the **exact** run length, so a 2-bar run does not re-enter when confirms is 0.
- API panel: CLOB `apiKey`, `secret`, `passphrase`, wallet address. OK pings CLOB, resolves the current Up/Down round, and with full L2 checks collateral. Live `marketBuy` still waits for an EIP-712 signer.

## 0.8.7 — 2026-09-17

- Polymarket mark next to the API field is the official round **P** with a light aura.
- Chart no longer wipes arrows on first load or when SMA periods change. Confirm / min-cross / SMA sliders still replay markers live.

## 0.8.6 — 2026-09-17

- Auto venue is **Polymarket CLOB** (`clob.polymarket.com`). **OK** pings `/time`. Gamma resolves the current crypto Up/Down round (`btc-updown-15m-{utcStart}` → Up/Down token IDs). Live `marketBuy` still `auto_not_wired` until an L1/L2 signer exists.
- API panel shows a Polymarket mark next to the key field.

## 0.8.5 — 2026-09-17

- **Confirms** slider: how many extra full same-color candles beyond the fast SMA after the first poke. `0` = first poke (v0.8.4). `1` = wait for one more, then enter.
- **Fast SMA** / **Slow SMA** periods are editable (default 20 / 200). Chart legend follows.

## 0.8.4 — 2026-09-17

- Signal candle `S` must be a **full body** of the needed color beyond SMA20. Open and close both on that side; wicks ignored. A green that straddles SMA20 no longer counts as a long, even if it closes above.

## 0.8.3 — 2026-09-16

- Min-cross on BTC was a no-op at 4 ticks ($0.04). Slider max is now 2000 ticks on BTC ($20). Label shows `$`. Dragging updates arrows only — chart is not reset.

## 0.8.2 — 2026-09-16

- Min-cross slider actually redraws arrows while you drag.
- Label shows ticks **and** dollars (BTC 4 ticks = $0.04). Range 0–500.
- Tick size is applied **before** arrows are replayed after symbol load.

## 0.8.1 — 2026-09-16

- Arrow marks the **entry candle `S+1`**, not the signal candle `S`.
- **Last candle** recenters both time and price so the live bar is on screen.
- Setting **?** tips render in a floating layer — no more clipped text.
- **Save** closes the panel immediately.

## 0.8.0 — 2026-09-16

- Pullback is **body-only**. `S-1` must close entirely beyond SMA20. Wicks do not count (customer case 1 is skipped, case 2 enters).
- Overnight stream: ping/pong, 90s stale reconnect, REST reconcile every 15s so arrows and candles survive a dead socket.

## 0.7.0 — 2026-09-15

- Settings **Save** sits outside the scroll area and always closes the panel.
- Setting hints hide behind a **?** — hover shows the text.
- Chart refresh is applied in the renderer (1 ms vs 1000 ms is visible). **Last candle** / TF / pair **center** the live bar.
- Theme / language no longer wipe entry arrows. Markers stay on the chart while idle.
- Venue SPI (`src/main/brokers`) so a live signer can plug in without touching Engine.

## 0.6.0 — 2026-09-15

- **Min cross** uses the pair’s exchange tick (XRP `0.0001`, not `$1`). 5 ticks = skip 3-tick and 4-tick touches; enter when the **closed** candle is ≥ 5 ticks past SMA20.
- Chart loads **2000** closed candles (was 400). SMA200 is present on the left.
- SMA20/200 on the chart use **closed** candles only — they no longer drift with the live bar, so arrows sit on the signal candle.
- Sliders (refresh, min opening, min cross) apply while you drag. Instrument and timeframe sit in the header as iOS pills. Status is a lamp (red idle / green running). Header arrow removed; blue **Last candle** on the chart stays.

## 0.5.0 — 2026-09-15

- Checklist entry: trend SMA200, pullback through SMA20, confirm on **closed** `S`, bet on **S+1**.
- Settings **Min cross**: skip unless close is at least X ticks beyond SMA20. `0` = any cross.
- Settings close (✕) is no longer clipped by the panel.
- Dead `requirePriorPenetration` flag removed; pullback on `S-1` is part of the rule.

## 0.4.1 — 2026-09-15

- TZ restored: signal only on **closed** candle `S`. Bet is on **S+1**. Forming candle never enters.
- Switching instrument (ETH) no longer crashes on WebSocket close.
- Theme / language are pill switches, not a clipped native dropdown.
- Min-opening hint: closed-candle confirmation, not “don’t enter while MAs overlap”.

## 0.4.0 — 2026-09-15

- Entries fire **as soon as SMA200/20 conditions appear on the live candle**, not after the close.
- SMA20 / SMA200 move with the live candle.
- Paper fill: 0.5% fee, open time, hold time, strike. Balance updates on every fill/settle.
- Notifications toggle (desktop + journal). Paper **Reset** button.
- Max steps (2, 6, …) halt exactly after that many losses.

## 0.3.2 — 2026-09-15

- Live stream host: `data-stream.binance.vision` (Binance `:9443` returns 451 in many regions). Candles move on every trade.

## 0.3.1 — 2026-09-15

- Chart stays pinned to the last candle. Pan left → **Last candle** button (and the header arrow) snaps back.
- Live candle is painted on every animation frame from Binance trades. REST no longer overwrites the forming bar every few seconds.
- Instrument list loads from Binance exchangeInfo (top USDT by volume). Preddy instruments later, same menu.
- SMA200/20 rules unchanged.

## 0.3.0 — 2026-09-15

- Chart is always live. Start/Stop only arms the strategy. Idle = candles, no trade arrows.
- Live candle follows Binance trades over WebSocket. Settings **Chart refresh** 1–1000 ms (default 100).
- Instrument and timeframe are full searchable lists (20 pairs, 1m…1d). Custom menus, not native OS dropdowns.
- Light theme is Apple-like: `#F2F2F7`, system blue `#007AFF`, homogeneous glass. Dark theme unchanged.
- Window buttons are traffic-light dots. Range thumbs are round. Log scrollbar has no up/down arrows.
- Auto immediately pings Preddy. If live balance is missing, the figure shows pulsing red `$0.00`.
- Journal lines are readable: «Setup · UP», «Bet placed», «Win», not raw `mode` / `skip`.
- Feed rail item removed. Chart, Stats, Journal, Settings.

## 0.2.0 — 2026-09-15

- Chart SMA20/SMA200 use **closed candles only**. The live bar still draws; it does not move the averages or create a signal.
- Settings slider **Min opening**: skip when SMA20 and SMA200 are stuck together. `0` = every cross (default). Value is ATR of the 15m bar.
- Paper chart markers stay on the signal candle `S`. The bet is still on `S+1`.
- Windows NSIS installer + macOS DMG via `v0.2.0` tag.

## 0.1.2 — 2026-09-15

- Strategy catalog in the left rail. Active **SMA200/20** lights green.
- New strategies register in `src/main/strategies/catalog.js` and show up in the list.
- Cannot switch strategy while a paper bet is open.

## 0.1.1 — 2026-09-15

- Paper: Stop does not kill an open virtual bet; it settles on the next close.
- Paper: Start does not fire on the already-closed last candle.
- Paper: missed 15m bars are processed in order; poll ticks no longer overlap.
- Paper: 6 losses halt until Confirm lot + Start. Skip does not change the series.
- Paper: restart restores an open paper bet from the journal.

## 0.1.0 — 2026-09-15

- First desktop shell (Windows + macOS).
- Glass UI from the frosted-panel references (~70% TradingView viewport).
- **Paper** mode: MA200 / MA20 rules, martingale ×2 to 6, halt until Start + lot confirm.
- Auto is visible but cannot send live orders (Preddy has no public trading API).
- Settings: API key + OK ping, theme, EN/RU.
- App icon (evening star) and installer shortcuts.
