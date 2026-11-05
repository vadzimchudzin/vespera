# Vespera 0.28.0 — the V2 paper test in the agents desk

0.27.0 plus the `V2money` work on the agents desk: two fast lanes, a9 latency arbitrage and a10 LP with rewards, run the frozen V2 plans forward on live feeds with their own paper account and certificates. The SMA/EMA strategy, the engine and the Polymarket broker code are unchanged. Paper only: no signing and no real-money orders.

## What's new

- **Agents → V2.** a9 (`latarb_v2`: a BTC jump on Binance buys the jump's side of the BTC 5m Up/Down window at the ask and sells at the bid 10 s later, with both taker fees) and a10 (`lp_v1` with the news shield: two-sided quotes on up to 300 reward markets, re-quoted every 10 s) trade on paper in a separate V2 account at the plans' scale, $1000 and $20 000. Their results stay out of the desk's equity and halts, and there are no day stops inside the test. See [AGENTS](https://github.com/vadzimchudzin/vespera/blob/v0.28.0/docs/AGENTS.md).
- **Certificates.** a9 needs 2000 BTC trades, an exit at the bid above zero with p < 0.01, a positive edge at the official result and at least 3 full UTC days with 20 h of live feeds; the verdict is taken once, and a kill switch pauses a9 if the exit is not above zero after 500 BTC 5m trades. a10 needs two phases of 24 h, each with a net above zero and no market above 25% of it; its news shield is tested against a shadow without it. Shadows (BTC 15m, and ETH as the control) count for the certificate only.
- **The V2 tab** fills both certificates in as the data come, shows the watchdog's problems, opens the V2 data folder and can start V2 afresh without touching the desk. Telegram gets a V2 block, a V2 section in the daily report and alerts for the kill switch, the verdict, a10's phases and the watchdog.
- **Research.** `research/v2money` holds the paper bots, the pre-registrations with their desk addenda, the results and the hypothesis registry. It is not part of the installers.

Full list: [CHANGELOG](https://github.com/vadzimchudzin/vespera/blob/v0.28.0/CHANGELOG.md).

## Running the V2 test

Agents → Start, then the V2 tab. The test runs where execution runs: in Zero Mode the desk is on the server, which this release does not update, and the V2 tab says so; keep execution on this computer to test V2 here. a10 takes about a minute and a half to build its markets. The a9 certificate needs at least 3 full UTC days with 20 h of live feeds, so the computer has to stay on and online; restarts continue the test from the saved state.

## Known issue: 4h rounds

US daylight time ended on 1 November, and Polymarket now starts its 4h Up/Down windows on New York time (00:00, 04:00, … ET, which is 05:00, 09:00, … UTC). Vespera still floors 4h windows to UTC, so it does not find the 4h round (`market_not_found`) and does not trade 4h. 0.26.0 and 0.27.0 have the same problem. 5m, 15m and 1h are not affected.

## Verified

- The full `npm test` (50 test files) on Linux with Node 24, including the lanes, both certificates, the V2 Telegram texts and the reset scopes through the host.
- `npm audit`: no high or critical findings; the dependencies are those of 0.27.0.
- The desk ran 200 seconds on live feeds in a throwaway data folder: a9 had Binance and the CLOB, tracked 8 windows and made 20 BTC 5m trades while its shadows traded; a10 built 300 markets in about 80 s and quoted about 270 with RTDS live and its shadow following; the watchdog's start-up problems cleared once the feeds were up.
- The app started headless (Electron 44.7 from an earlier install; the installers carry 44.10.1) with an empty profile: Agents → Start ran both lanes on live feeds and the V2 tab showed them without page errors.

The release workflow publishes only after the Node 22 tests pass on Linux, Windows and macOS and both the Windows NSIS x64 and the macOS universal DMG builds succeed. Both installers and SHA256SUMS must be present before publication. macOS is ad-hoc signed, not Developer ID notarized.

## Security audit limitations

Remaining findings: 14 low in production (the ethers v5 / elliptic cryptography chain), 1 moderate in production (`ip-address` under the SOCKS proxy support, GHSA-rxp7-6hxx-x8q5) and 7 moderate in build tooling only (`minimatch` under electron-builder, `fast-uri`). They are not claimed fixed. Audit counts can change as advisory data evolves.

## Not verified / operator acceptance still required

- A multi-day V2 run: no certificate has been reached yet, and paper results are not evidence of profitability.
- Installation on customer Windows/macOS machines and OS-specific GUI acceptance.
- Real Telegram delivery of the V2 reports and alerts.
- Real-money order execution, final settlement and balance reconciliation.

## Upgrading

In Zero Mode the agents desk runs on the server, so the V2 lanes need the server updated too; until then, test V2 with execution on this computer. Stop execution safely and back up both sides before upgrading; never reset ownership state to bypass unresolved transfers or orders. Research still assumes Binance candles and a binary entry price of 0.50, not historical Polymarket order books. This release is not a certification for unattended real-money trading.
