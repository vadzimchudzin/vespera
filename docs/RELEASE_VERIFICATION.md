# Vespera 0.28.1 — the agents through the app's proxy

0.28.0 with one fix: the agents desk, its V2 lanes and the ring now reach Polymarket through the proxy from the API panel. The SMA/EMA strategy, the engine and the Polymarket broker code are unchanged. Paper only: no agent can place a real order.

## What's fixed

- **Agents, V2 and the ring behind a proxy.** Where Polymarket is blocked (Belarus among other places) the app's trading already went through the API panel's proxy, but the desk, a9, a10 and the ring went direct and failed: `agents_source_unavailable` on every Gamma source, a9 with Binance but no CLOB and no windows, a10 down, an empty ring. Now Gamma, the CLOB and both WebSockets go through that proxy over the same SOCKS routes as orders; Binance, Coinbase, Deribit, the weather and the news stay direct. A proxy that is set but unusable is never bypassed: requests fail with a reason and the lanes wait for it.
- **The ring** gets its own browser session with the same proxy and the app answers an HTTP(S) proxy's login. Chromium cannot log in to a SOCKS proxy, so with a SOCKS proxy that has a login and password the ring does not open and says why; the agents work with either.
- **a10** reads 13 pages of reward markets instead of 40 (the same markets) and asks a failed page again before giving up.
- **Reasons, not codes,** for network and proxy failures in the Agents panel and the Telegram alerts.

Full list: [CHANGELOG](https://github.com/vadzimchudzin/vespera/blob/v0.28.1/CHANGELOG.md).

## Traffic through the proxy

Measured through a local proxy over six minutes: 30–75 MB a minute, about 2–4.5 GB an hour. Almost all of it is a9's CLOB market channel: its 8 BTC/ETH Up/Down windows send 900–2000 messages a second and the server offers no compression. a10's book polls and RTDS take about 0.6 MB a minute each, the catalog about 6 MB every 30 minutes, and opening the ring loads tens of megabytes. Check the proxy's traffic limit before leaving the V2 test running.

## Known issue: 4h rounds

US daylight time ended on 1 November, and Polymarket now starts its 4h Up/Down windows on New York time (00:00, 04:00, … ET, which is 05:00, 09:00, … UTC). Vespera still floors 4h windows to UTC, so it does not find the 4h round (`market_not_found`) and does not trade 4h. 0.26.0 and 0.27.0 have the same problem. 5m, 15m and 1h are not affected.

## Verified

- The full `npm test` (51 test files) on Linux with Node 24, including the new `proxy.test.js` on loopback: a CONNECT proxy with and without a login, a SOCKS5 relay that refuses host names (the IPv4 route is taken and kept), WebSockets through both, a dead and a broken proxy with no direct request or socket, the size cap on unpacked bytes, timeouts, the lanes on fake sockets and a10's paging and retries.
- The app started headless (Electron 44.7 from an earlier install; the installers carry 44.10.1) with an empty profile and an HTTP proxy with a login on loopback: Agents → Start ran the desk and both lanes through it (757 events, a9 with Binance direct and the CLOB through the proxy on 8–10 windows, a10 with 300 markets and RTDS), seven tunnels in all, none to Binance; the ring opened through the same proxy after its login and drew the live catalog.
- A live check of the reward markets: 40 pages of 500, 5848 at $5/day or more, all within the first 13 pages.

The release workflow publishes only after the Node 22 tests pass on Linux, Windows and macOS and both the Windows NSIS x64 and the macOS universal DMG builds succeed. Both installers and SHA256SUMS must be present before publication. macOS is ad-hoc signed, not Developer ID notarized.

## Security audit limitations

Remaining findings: 14 low in production (the ethers v5 / elliptic cryptography chain), 1 moderate in production (`ip-address` under the SOCKS proxy support, GHSA-rxp7-6hxx-x8q5) and 7 moderate in build tooling only (`minimatch` under electron-builder, `fast-uri`). They are not claimed fixed. Audit counts can change as advisory data evolves.

## Not verified / operator acceptance still required

- A real SOCKS proxy and a real HTTP proxy abroad: the routes were tested on loopback stand-ins.
- A multi-day V2 run: no certificate has been reached yet, and paper results are not evidence of profitability.
- Installation on customer Windows/macOS machines and OS-specific GUI acceptance.
- Real Telegram delivery of the V2 reports and alerts.
- Real-money order execution, final settlement and balance reconciliation.

## Upgrading

Install over 0.28.0; the agents' books, the V2 accounts and their certificates are kept. Keep the proxy in the API panel and execution on this computer. In Zero Mode the agents desk runs on the server, which this release does not update and which needs no proxy. Stop execution safely and back up both sides before upgrading; never reset ownership state to bypass unresolved transfers or orders. This release is not a certification for unattended real-money trading.
