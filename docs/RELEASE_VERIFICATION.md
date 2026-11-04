# Vespera 0.27.0 — paper agents desk and Electron security update

0.26.0 plus the Zero Mode auto-resume fix (#28) and the `V2money` work: a paper-only agents desk and a data collector for the coming backtester. Electron moves to 44.10.1 for GHSA-jr5w-w6x2-84p9 (compromised eMudhra intermediate certificates). The SMA/EMA strategy, the engine and the Polymarket broker code are unchanged. No real-money orders were placed during acceptance.

## What's new

- **Paper agents desk.** The new Agents panel runs eight agents on paper: arbitrage, crypto levels, daily weather, favourites, near-resolution and forecast checks, and a shadow maker. Sizes are quarter-Kelly under per-trade, market, event, sector, total and agent limits, and the desk halts at a 5% daily loss or a 15% drawdown. Live modes are refused: no signing, no real money. See [AGENTS](https://github.com/vadzimchudzin/vespera/blob/v0.27.0/docs/AGENTS.md).
- **Where the desk runs.** On the server in Zero Mode, otherwise on this computer. Telegram gets `/agents`, `/agents_report`, `/agents_stop` and `/agents_start`. Agents → Open the ring shows the desk's positions in Engine Live.
- **Fixes from the first paper day.** Weather is blended with the market's price, a single buy needs a sound order book, and one game counts as one event, with at most 3 of its markets per agent.
- **Zero Mode auto-resume survives repeated server restarts (#28).**
- **Data collector (V2 M0).** `npm run collect` records the Polymarket, Chainlink and Binance feeds for the backtester. It runs from source and is not part of the installers. See [COLLECTOR](https://github.com/vadzimchudzin/vespera/blob/v0.27.0/docs/COLLECTOR.md).
- **Security.** Electron 44.10.1, undici 7.30.1 / 6.29.1.

Full list: [CHANGELOG](https://github.com/vadzimchudzin/vespera/blob/v0.27.0/CHANGELOG.md).

## Known issue: 4h rounds

US daylight time ended on 1 November, and Polymarket now starts its 4h Up/Down windows on New York time (00:00, 04:00, … ET, which is 05:00, 09:00, … UTC). Vespera still floors 4h windows to UTC, so it does not find the 4h round (`market_not_found`) and does not trade 4h. 0.26.0 has the same problem. 5m, 15m and 1h are not affected.

## Verified

- `npm ci` from the lockfile and the full `npm test` (47 test files) on Linux with Node 24.
- `npm audit`: no high or critical findings.
- A Linux unpacked build with Electron 44.10.1 holds version 0.27.0, the agents desk and the ring, and no collector. It started under the headless Ozone platform with an empty profile and ran without exceptions.
- The agents desk ran a paper day on live Polymarket books; the fixes above came from it.
- The collector ran 7 minutes on the live feeds. For every window that ended, the start and end prices rebuilt from the recorded Chainlink TWAP matched Polymarket's price to beat and final price.

The release workflow publishes only after the Node 22 tests pass on Linux, Windows and macOS and both the Windows NSIS x64 and the macOS universal DMG builds succeed. Both installers and SHA256SUMS must be present before publication. macOS is ad-hoc signed, not Developer ID notarized.

## Security audit limitations

Remaining findings: 14 low in production (the ethers v5 / elliptic cryptography chain), 1 moderate in production (`ip-address` under the SOCKS proxy support, GHSA-rxp7-6hxx-x8q5) and 7 moderate in build tooling only (`minimatch` under electron-builder, `fast-uri`). They are not claimed fixed. Audit counts can change as advisory data evolves.

## Not verified / operator acceptance still required

- Installation on customer Windows/macOS machines and OS-specific GUI acceptance.
- Real Telegram delivery of the agent commands and reports.
- Real-money order execution, final settlement and balance reconciliation.
- A 48–72-hour continuous paper soak of the agents desk. Its paper results are not evidence of profitability.

## Upgrading

In Zero Mode the agents desk runs on the server, so update the server too. Stop execution safely and back up both sides before upgrading; never reset ownership state to bypass unresolved transfers or orders. Research still assumes Binance candles and a binary entry price of 0.50, not historical Polymarket order books. This release is not a certification for unattended real-money trading.
