# Vespera (VSP)

Glass desktop terminal for BTC 15m Polymarket Up/Down.

**v0.18.7.** SMA/EMA 200/20 on a **closed** candle `S`, bet on **S+1**. Arrow sits on the entry candle. Auto prices the live Polymarket round and sends **CLOB V2** signed orders once the wallet, a signing key and the derived CLOB keys are in the API panel.

**Payout is not ×2.** Polymarket pays $1 per winning share, so the multiple is `1 / price`. At an ask of 0.72 a $1 stake returns $1.39 while a loss still costs the full $1 — Paper books results on that same number. Crypto rounds also charge a taker fee of `0.07 × p × (1 − p)` per share (≈3.5% of the stake at 0.50), paid in USDC on top of the stake and lost on either outcome. Paper and live P&L both deduct it; Paper without a live quote assumes a price of 0.50. A flat ×2 martingale does **not** recover a loss at those odds; size the series accordingly.

**Resolution.** A round resolves **Up** when the Chainlink BTC/USD TWAP at the end is **greater than or equal to** the start. Vespera books the result on the Binance close so the series can continue immediately, then checks Polymarket's actual resolution and raises a `settle_mismatch` alert if the two disagree.

Repo: private [`VadimChudin/vespera`](https://github.com/VadimChudin/vespera)

## What it does

- Slow MA (trend) + fast MA (trigger) on **closed** Binance candles, **SMA or EMA** (Settings → Average). Default `BTCUSDT` 15m; pick any listed pair / timeframe.
- Above 200 → only UP. Below 200 → only DOWN.
- Entry: prior bar’s **body** fully beyond the fast SMA (default 20, wicks ignored). Then `confirmCount + 1` consecutive full-body candles of the needed color beyond that line. `0` = first poke. Periods of both SMAs are in Settings.
- Bet is on **the next** candle (`S+1`). Forming candle never signals.
- Martingale series, max 6 steps (Settings). **×2** doubles the stake; **Recover** sizes each stake from the live price so a win pays back the series plus the base profit. Optional max stake and max entry price. Win resets to base. Losing every step → halt until **Start** and **confirm lot**.
- **Statistics** shows win rate against the break-even rate at the prices you actually got, fees, drawdown, how deep series went and results by day. **Export trades to CSV** writes every settled bet.
- Chart is always live (Binance WebSocket + REST fallback). SMA lines use **closed** candles only.
- Trade arrows appear only while Paper/Auto is **started**. Idle = clean chart.
- Settings **Chart refresh**: 1–1000 ms, applied live. **Min opening**: skip when SMA20 and SMA200 are stuck together. **Min cross**: close must be X **exchange ticks** beyond SMA20 (`0` = any cross).
- Header: instrument + timeframe as iOS pills. Status lamp instead of “Waiting for signal”. Blue **Last candle** stays on the chart.

## Modes

| Mode | Name in UI | Orders |
|---|---|---|
| Paper | Paper / Пейпер | Virtual Up/Down fills |
| Auto | Auto / Авто | Prices the live round on `clob.polymarket.com`, signs CLOB V2 EIP-712 orders and posts them as FAK (fill-and-kill) with 2 cents of price room. Needs wallet, private key and the derived CLOB keys. Polymarket lists Up/Down rounds only for **BTC, ETH, SOL, XRP, DOGE, BNB, HYPE** on **5m and 15m**; Auto shows only those, Paper shows every pair and marks these with **P**. Minimum order is 5 shares; the wallet must hold stake + taker fee. |

**Connect** in the API panel checks the account; it does not place trades.

**Safeguards.** Auto starts in **dry run**: everything but posting the order (price, stake, fee, balance check, real signature), booked apart from real money. Turning it off makes Start ask for confirmation with the stakes and total at risk. An optional daily loss limit stops trading until midnight. A watchdog pauses Auto when Polymarket is unreachable or an order error would repeat (no balance, lot under the minimum, repeated rejections).

**Wallet type.** Auto-detect compares the wallet with the signing key: same address → EOA, the key's legacy proxy → Proxy, its legacy Safe → Safe, anything else → **Deposit Wallet** (every account created since May 2026). Override it in the API panel if detection is wrong. Collateral is **pUSD**; polymarket.com wraps USDC into it automatically.

## Keys

1. Polymarket → **Account → Private key → Start export**. That key only signs; it is stored encrypted on this machine and never leaves it.
2. Copy your Polymarket wallet address from the profile menu.
3. In Vespera → **API**, paste both and press **Connect**. The CLOB L2 credentials (`apiKey`, `secret`, `passphrase`) are derived from a `ClobAuth` signature — there is no page on polymarket.com that shows them. "Relayer API keys" in Settings is a different thing and is not used here.
4. Connect shows a checklist: reachability / region, key, wallet, wallet type, CLOB keys, current round and price, pUSD balance against the first bet and a full series, and the exchange allowance. Green means ready for live orders.

Manual CLOB keys and the proxy are under **Advanced** in the same panel.

**Test bet.** Under Connect, *Test bet UP / DOWN* places one minimum order (5 shares, about $3) on the current round right away, after a confirmation, so the live path can be checked without waiting for a signal. It does not touch the series or statistics; in dry run it is signed but not sent.

## Funding the wallet

Polymarket trades in **pUSD on Polygon**, but it accepts deposits from other networks through its bridge. Menu → **Deposit**: pick the coin and the network (for example **USDT · Tron**), send it to the address shown, and the bridge credits pUSD to your Polymarket wallet, usually within minutes. Each network has a minimum (about $2–4); send only the selected coin on the selected network. The address is tied to the wallet address in the API panel, so fill that in first.

## Blocked regions

Polymarket geoblocks a list of jurisdictions (Belarus among them) and refuses both the site and the API from those IPs. Prices, balances and key derivation still work from a blocked IP; only orders are refused (`403 Trading restricted in your region`). **Connect** therefore asks Polymarket's geoblock endpoint and shows a red *Trading region* row with the country, and real-money **Start** is refused while the region is blocked. A proxy URL in the API panel (`http://user:pass@host:port`, `socks5://host:port` or plain `host:port`) routes every CLOB, Gamma, bridge and geoblock call through an allowed jurisdiction. If the proxy cannot be used, calls fail with `proxy_unavailable` instead of silently going direct. SOCKS proxies get the host name and resolve it themselves (`socks5://` is treated as `socks5h://`); if the proxy refuses that, Vespera retries once over local IPv4 and remembers the route that works. Connect names the exact proxy fault (login, port, proxy cannot reach Polymarket) and real-money Start is refused while the proxy is broken.

## Run from source

```bash
npm install
npm test
npm start
```

## Cut a version (Win + Mac)

Bump `version` in `package.json`, add a `CHANGELOG` line, tag:

```bash
git tag v0.17.0
git push origin v0.17.0
```

GitHub Actions builds:

- Windows: `Vespera-<ver>-win-x64.exe` (NSIS, desktop + Start Menu shortcuts)
- macOS: `Vespera-<ver>-mac.dmg`

**First launch on a Mac.** The app is ad-hoc signed but not notarized by Apple (that needs a paid Developer ID). Drag Vespera to *Applications*, open it once, press *Done*, then **System Settings → Privacy & Security → “Vespera” was blocked → Open Anyway**. On macOS 15+ right-click → Open no longer offers this. If a copy arrived through a messenger and still refuses, run in Terminal:

```bash
xattr -cr /Applications/Vespera.app
```

Universal build: runs natively on Apple Silicon and Intel Macs.

Local:

```bash
npm run dist:win
npm run dist:mac
```

## Layout

```
src/main/        engine, strategy, paper broker, journal, live market
src/renderer/    glass UI, i18n EN/RU, TradingView host
build/           app icon (.png / .ico)
```

`Strategy` does not know Polymarket. `Broker` does not know MAs. Live venues implement `src/main/brokers/spi.js` (`ping`, `getBalance`, `marketBuy`). Auto uses `PolymarketAdapter` + Gamma slug `btc-updown-15m-{utcStart}`.

## Spec

See `docs/TZ_Predic_MA200_MA20.md`.
