# Vespera (VSP)

Glass desktop terminal for BTC 15m Preddy / Polymarket-style up-down.

**v0.1.0 is Paper.** Same strategy as the spec, no live money.

Repo: private [`VadimChudin/vespera`](https://github.com/VadimChudin/vespera)

## What it does

- SMA 200 (trend) + SMA 20 (trigger) on **closed** Binance `BTCUSDT` 15m candles.
- Above 200 → only UP. Below 200 → only DOWN.
- Entry: candle crosses MA20 and closes with the trend.
- Bet is on **the next** candle.
- Paper martingale ×2, max 6. Win resets to base. Six losses → halt until **Start** and **confirm lot**.
- TradingView widget is display only (~70% of the window). Signals do not read the widget.

## Modes

| Mode | Name in UI | Orders |
|---|---|---|
| Paper | Paper / Пейпер | Virtual Preddy fills |
| Auto | Auto / Авто | Blocked until a live signer exists |

Preddy ([preddy.trade](https://preddy.trade)) has no public API key. **OK** pings that the site is reachable. It does not place trades.

## Run from source

```bash
npm install
npm test
npm start
```

## Cut a version (Win + Mac)

Bump `version` in `package.json`, add a `CHANGELOG` line, tag:

```bash
git tag v0.1.0
git push origin v0.1.0
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
src/main/        engine, strategy, paper broker, journal
src/renderer/    glass UI, i18n EN/RU, TradingView host
build/           app icon (.png / .ico)
```

`Strategy` does not know Preddy. `Broker` does not know MAs.

## Spec

See `docs/TZ_Predic_MA200_MA20.md`.
