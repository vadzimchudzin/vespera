# Vespera 0.25.1 — security and release verification

Based on the 0.25.0 source branch, not the older main branch. This release updates ethers within v5, overrides the providers WebSocket dependency, updates Electron to 44.7 and electron-builder to 26.15.3, and requires Node 22+. No trading strategy changes or real-money orders were made during acceptance.

## Verified locally (isolated Linux, Node 22)

- Full `npm test` including all 39 test scripts and posttest.
- Real server process startup, minimal health endpoint, unauthorized API refusal, authenticated API, clean stop and restart.
- Five deterministic 5,000-candle synthetic backtests with identical results and restored reports, plus Binance historical replay.
- Actual Electron under the headless Ozone platform: settings tabs, saved setup creation, and a 500-candle Binance backtest rendered in Research without page exceptions.
- Desktop/server Paper handoff, Paper Start, desktop closure without stopping server execution, desktop reopen retaining server route, Stop and safe release back to local execution.
- Automated Telegram authorization, confirmation, transport retry and local/server integration tests; these do not prove live Telegram delivery.

The release workflow separately gates publication on Node 22 tests on Linux, Windows and macOS and successful Windows NSIS x64 / macOS universal DMG builds. macOS is ad-hoc signed, not Developer ID notarized. Both artifacts and SHA256SUMS must be present before publication.

## Security audit limitations

The updated dependency tree has no npm audit high/critical findings. Remaining findings include low-severity production ethers/elliptic cryptography-chain advisories and moderate build-only sprintf-js denial-of-service advisory. They are not claimed fixed; forced major ethers migration or ad-hoc upstream cryptography modifications were avoided. Do not process untrusted build metadata. Audit counts can change as advisory data evolves.

## Not verified / operator acceptance still required

- Customer Windows/macOS installation and OS-specific GUI acceptance.
- Customer production host, HTTPS/DNS/systemd and direct permitted venue access.
- Real Telegram bot pairing and actual delivery.
- Real-money order execution, final settlement and account balance reconciliation.
- 48–72-hour continuous Paper/dry-run soak on the deployment host.

Research assumes Binance candles and binary entry price 0.50, not historical Polymarket order books. Synthetic fixture win rates are testing artifacts, not profitability evidence. This release is not a certification for unattended real-money trading. Safely stop execution and back up both sides before upgrades; never reset ownership state to bypass unresolved transfers or orders.
