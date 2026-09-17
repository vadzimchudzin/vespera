# Vespera (VSP)

Glass desktop terminal for BTC 15m Polymarket Up/Down.

**v0.8.6 is Paper.** SMA200/20 on a **closed** candle `S`, bet on **S+1**. Arrow sits on the entry candle. No live money. Auto pings the Polymarket CLOB; orders wait for an L1/L2 signer.

Repo: private [`VadimChudin/vespera`](https://github.com/VadimChudin/vespera)

## What it does

- SMA 200 (trend) + SMA 20 (trigger) on **closed** Binance candles. Default `BTCUSDT` 15m; pick any listed pair / timeframe.
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
| Auto | Auto / Авто | Pings `clob.polymarket.com`. Resolves the current BTC/ETH Up/Down round via Gamma. Orders blocked until an L1/L2 signer exists. Balance pulses `$0.00` until then. |

**OK** in the API panel pings the Polymarket CLOB. It does not place trades. Live `marketBuy` stays `auto_not_wired` until a signer is plugged into `src/main/brokers`.

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
