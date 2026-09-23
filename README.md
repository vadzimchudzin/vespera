# Vespera (VSP)

Glass desktop terminal for BTC 15m Polymarket Up/Down.

**v0.12.1.** SMA/EMA 200/20 on a **closed** candle `S`, bet on **S+1**. Arrow sits on the entry candle. Auto prices the live Polymarket round and sends **CLOB V2** signed orders once the wallet, a signing key and the derived CLOB keys are in the API panel.

**Payout is not ×2.** Polymarket pays $1 per winning share, so the multiple is `1 / price`. At an ask of 0.72 a $1 stake returns $1.39 while a loss still costs the full $1 — Paper books results on that same number. Crypto rounds also charge a taker fee of `0.07 × p × (1 − p)` per share (≈3.5% of the stake at 0.50), paid in USDC on top of the stake and lost on either outcome. Paper and live P&L both deduct it; Paper without a live quote assumes a price of 0.50. A flat ×2 martingale does **not** recover a loss at those odds; size the series accordingly.

**Resolution.** A round resolves **Up** when the Chainlink BTC/USD TWAP at the end is **greater than or equal to** the start. Vespera books the result on the Binance close so the series can continue immediately, then checks Polymarket's actual resolution and raises a `settle_mismatch` alert if the two disagree.

Repo: private [`VadimChudin/vespera`](https://github.com/VadimChudin/vespera)

## What it does

- Slow MA (trend) + fast MA (trigger) on **closed** Binance candles, **SMA or EMA** (Settings → Average). Default `BTCUSDT` 15m; pick any listed pair / timeframe.
- Above 200 → only UP. Below 200 → only DOWN.
- Entry: prior bar’s **body** fully beyond the fast SMA (default 20, wicks ignored). Then `confirmCount + 1` consecutive full-body candles of the needed color beyond that line. `0` = first poke. Periods of both SMAs are in Settings.
- Bet is on **the next** candle (`S+1`). Forming candle never signals.
- Paper martingale ×2, max 6. Win resets to base. Six losses → halt until **Start** and **confirm lot**.
- Chart is always live (Binance WebSocket + REST fallback). SMA lines use **closed** candles only.
- Trade arrows appear only while Paper/Auto is **started**. Idle = clean chart.
- Settings **Chart refresh**: 1–1000 ms, applied live. **Min opening**: skip when SMA20 and SMA200 are stuck together. **Min cross**: close must be X **exchange ticks** beyond SMA20 (`0` = any cross).
- Header: instrument + timeframe as iOS pills. Status lamp instead of “Waiting for signal”. Blue **Last candle** stays on the chart.

## Modes

| Mode | Name in UI | Orders |
|---|---|---|
| Paper | Paper / Пейпер | Virtual Up/Down fills |
| Auto | Auto / Авто | Prices the live round on `clob.polymarket.com`, signs CLOB V2 EIP-712 orders and posts them as FOK. Needs wallet, private key and the derived CLOB keys. Polymarket lists Up/Down rounds only for **BTC, ETH, SOL, XRP, DOGE, BNB, HYPE** on **5m and 15m**; Auto shows only those, Paper shows every pair and marks these with **P**. Minimum order is 5 shares; the wallet must hold stake + taker fee. |

**OK** in the API panel pings the Polymarket CLOB and checks the pUSD balance. It does not place trades.

**Wallet type.** Auto-detect compares the wallet with the signing key: same address → EOA, the key's legacy proxy → Proxy, its legacy Safe → Safe, anything else → **Deposit Wallet** (every account created since May 2026). Override it in the API panel if detection is wrong. Collateral is **pUSD**; polymarket.com wraps USDC into it automatically.

## Keys

1. Polymarket → **Account → Private key → Start export**. That key only signs; it is stored encrypted on this machine and never leaves it.
2. Copy your Polymarket wallet address from the profile menu.
3. In Vespera → **API**, paste both and press **Get API keys from the private key**. The CLOB L2 credentials (`apiKey`, `secret`, `passphrase`) are derived from an `ClobAuth` signature — there is no page on polymarket.com that shows them. "Relayer API keys" in Settings is a different thing and is not used here.
4. Press **OK** to ping. The panel shows the live UP/DOWN price, the payout multiple and the minimum order size.

## Blocked regions

Polymarket geoblocks a list of jurisdictions (Belarus among them) and refuses both the site and the API from those IPs. **OK** reports `Polymarket blocks this region` with the detected country when that is the cause, rather than a generic unreachable. A proxy URL in the API panel routes every CLOB and Gamma call through an allowed jurisdiction. If the proxy cannot be used, calls fail with `proxy_unavailable` instead of silently going direct.

## Run from source

```bash
npm install
npm test
npm start
```

## Cut a version (Win + Mac)

Bump `version` in `package.json`, add a `CHANGELOG` line, tag:

```bash
git tag v0.12.1
git push origin v0.12.1
```

GitHub Actions builds:

- Windows: `Vespera-<ver>-win-x64.exe` (NSIS, desktop + Start Menu shortcuts)
- macOS: `Vespera-<ver>-mac.dmg`

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
