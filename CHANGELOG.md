# Changelog

All notable versions of **Vespera (VSP)**. Tag `vX.Y.Z` to cut a build.

## 0.12.1 — 2026-09-23

- **Auto lists only what Polymarket trades.** Up/Down rounds exist for BTC, ETH, SOL, XRP, DOGE, BNB and HYPE on 5m and 15m only (HYPE appears when Binance lists it). In Auto the pair and timeframe menus show just those; switching to Auto moves an unsupported pick to BTC 15m, and the engine refuses unsupported picks even if asked. Paper keeps the full Binance list, with Polymarket pairs first and marked **P**, the rest dimmed.
- **Market BUY amounts were rejected by the CLOB.** Marketable buys need the USD amount to 2 decimals and shares to 4; 0.12.0 sent USD to 5 decimals (e.g. `9.9958`). The full stake is now sent in cents and shares are truncated to 4 decimals.
- **Fees, checked end to end.**
  - The taker fee `shares × rate × (p(1−p))^e` is read from the market (`/clob-markets` → `fd`), and markets without fee details are treated as fee-free.
  - V2 charges it in USDC on top of the stake, so it is lost on a win and on a loss; live orders now check the wallet holds stake + fee before signing.
  - Live results are booked on what actually filled (`makingAmount` / `takingAmount`), so price improvement is counted: win = shares − stake − fee, loss = −stake − fee.
  - Paper without a live quote used a flat 0.5% fee against a ×2 payout; it now prices the round at 0.50 and charges the same taker fee (3.5% of the stake), never more optimistic than the venue. A `null` fee rate no longer turns into a zero fee.
  - Paper warns (`paper_below_live_min`) when a lot is under Polymarket's 5-share minimum, i.e. would be refused live.
- **Restart mid-round keeps the numbers.** The paper bet is restored with its shares, fee and the balance after the stake (a restart used to settle it at ×2 with no fee and a balance that never paid the stake). An unsettled live bet is restored too, so its result still reaches the series.
- **Settings.** The SMA/EMA switch called a missing function and threw, so it only applied after **Save** and the period labels kept saying SMA. It now applies live. Units are pluralised (1 свеча / 3 свечи / 5 свечей, 1 тик / 22 тика).
- **Chart axis follows the tick size.** Low-priced pairs like PEPE showed every price as `0.00`.

## 0.12.0 — 2026-09-23

- **Orders are signed for CLOB V2.** Polymarket switched production to CLOB V2 on 2026-04-28 and rejects V1-signed orders, so every live order from earlier builds failed. The signer now uses the V2 exchange (`0xE111…996B`, EIP-712 version `"2"`), the new Order struct (`timestamp`, `metadata`, `builder` instead of `nonce`, `feeRateBps`, `taker`), the neg-risk exchange when the book says so, and the V2 wire body.
- **Deposit Wallets are supported.** Every Polymarket account created since May 2026 trades through a Deposit Wallet (signature type 3, ERC-7739 wrapped signature). Auto-detect now tells EOA, legacy Proxy, legacy Safe and Deposit Wallet apart, and the API panel has a wallet-type override. Before, any non-EOA account was signed as a proxy and rejected.
- **L2 auth identifies the signing key.** `POLY_ADDRESS` carries the key's address, the balance check sends `signature_type`, and signed GET paths exclude the query string, as the CLOB expects.
- **A refused order is a refusal.** The CLOB answers some rejections with HTTP 200 and `success: false`; those used to be booked as open bets. The reason (`errorMsg`) is now reported.
- **Order amounts follow the CLOB precision rules.** Price on the market tick (0.001 on BTC 15m), shares to 2 decimals, and the FOK limit sweeps the book far enough to fill the stake instead of dying on a thin best ask.
- **Flat rounds resolve UP**, matching Polymarket's "end ≥ start" rule, in Paper and live. Live results are also checked against Polymarket's actual resolution (Chainlink TWAP); a disagreement is journaled and raised as `settle_mismatch`.
- **Taker fees are counted.** Paper charges `stake × 0.07 × (1 − p)` when a live quote exists (the market's own rate from `/clob-markets`), live P&L deducts the same estimate. The old flat 0.5% applies only without a quote.
- **Secrets no longer reach the window.** `settings:get` returned the decrypted private key and CLOB secrets to the renderer; it now returns only whether they are set.
- **The proxy actually works in the installed app.** `https-proxy-agent` was only present as a build-tool dependency and was not packaged, so the proxy URL was silently ignored and calls went out directly. It is now a runtime dependency, and a proxy that cannot load fails with `proxy_unavailable` instead of leaking a direct call.
- Live balance is always read as 6-decimal pUSD (small balances were shown unscaled). Venue text in the API panel is HTML-escaped. `package-lock.json` is regenerated (it was stuck at 0.9.0 without `ethers`).

## 0.11.1 — 2026-09-23

- **The API panel no longer hangs.** A failed network call rejected instead of returning, so "Signing and asking the CLOB…" stayed on screen forever. Every request now resolves with a readable reason, and the derive button reports it.
- **Geoblock is named as such.** Polymarket blocks a list of jurisdictions outright, so an unreachable CLOB and a blocked region used to look identical ("Unreachable"). The ping now checks `polymarket.com/api/geoblock` and says which one it is, with the detected country.
- **Proxy support.** An optional proxy URL in the API panel routes every CLOB and Gamma call through it, for running from a blocked region.
- Request timeout raised from 8s to 15s.

## 0.11.0 — 2026-09-23

- **API keys are derived in the app.** Polymarket has no screen that hands out `apiKey` / `secret` / `passphrase` — they come from an L1 `ClobAuth` signature. Paste the signing key and press **Get API keys from the private key**; Vespera signs, calls `/auth/derive-api-key` (falling back to `/auth/api-key`) and stores the result encrypted. Only the private key has to be copied by hand, from Polymarket → Account → Private key → Start export.
- **Proxy accounts sign correctly.** Email and Google accounts hold funds in a proxy wallet, so the wallet address is not the signing key's address. Orders now set `maker` to the wallet, `signer` to the key, and `signatureType` to POLY_PROXY. Signing a proxy account as an EOA — which is what the previous build did — gets every order rejected. The type is detected by comparing the two addresses and can be overridden.

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
