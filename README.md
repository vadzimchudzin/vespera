# Vespera (VSP)

Glass desktop terminal for BTC 15m Polymarket Up/Down.

**v0.10.0.** SMA/EMA 200/20 on a **closed** candle `S`, bet on **S+1**. Arrow sits on the entry candle. Auto prices the live Polymarket round and can send signed CLOB orders once an L2 key pair and a signing key are in Settings.

**Payout is not ×2.** Polymarket pays $1 per winning share, so the multiple is `1 / price`. At an ask of 0.72 a $1 stake returns $1.39 while a loss still costs the full $1 — Paper now books results on that same number. A flat ×2 martingale does **not** recover a loss at those odds; size the series accordingly.

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
| Auto | Auto / Авто | Prices the live round on `clob.polymarket.com`, signs EIP-712 orders and posts them. Needs apiKey, secret, passphrase, wallet **and** private key. Polymarket lists only **5m and 15m** Up/Down rounds; other timeframes report `timeframe_unsupported`. Minimum order is 5 shares. |

**OK** in the API panel pings the Polymarket CLOB. It does not place trades. Live `marketBuy` stays `auto_not_wired` until a signer is plugged into `src/main/brokers`.

## Keys

1. Polymarket → **Account → Private key → Start export**. That key only signs; it is stored encrypted on this machine and never leaves it.
2. Copy your Polymarket wallet address from the profile menu.
3. In Vespera → **API**, paste both and press **Get API keys from the private key**. The CLOB L2 credentials (`apiKey`, `secret`, `passphrase`) are derived from an `ClobAuth` signature — there is no page on polymarket.com that shows them. "Relayer API keys" in Settings is a different thing and is not used here.
4. Press **OK** to ping. The panel shows the live UP/DOWN price, the payout multiple and the minimum order size.

## Run from source

```bash
npm install
npm test
npm start
```

## Cut a version (Win + Mac)

Bump `version` in `package.json`, add a `CHANGELOG` line, tag:

```bash
git tag v0.3.0
git push origin v0.3.0
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
