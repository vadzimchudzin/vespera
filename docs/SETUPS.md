# Saved setup versions — 0.23.0 source

Settings → Strategy contains the setup library. Save the accepted trading
configuration under a name, add a new immutable version, copy a selected
version, apply it while stopped, or import/export its JSON definition.

A setup contains strategy, symbol, signal timeframe, market timeframe,
indicator/entry parameters and sizing/risk limits. It never contains wallet
addresses, signing/API keys, bot/server tokens, proxy URLs, balances, positions,
journals, execution ownership, theme, language, Paper/Auto mode or dry-run state.
Import rejects unknown fields rather than treating a settings/profile file as
a setup. Importing and copying creates a new setup identity; it does not modify
an existing history or automatically apply/start it.

Saving captures accepted settings and selects that saved version without
changing the trading configuration. Applying a different version uses a durable
`setup-activation.json` intent: startup finishes an interrupted activation before
creating the Engine. If rollback cannot persist, commands and handoff remain
blocked until recovery. A well-formed imported symbol must also be listed for
the current executor before it can be applied.

## Applying and recording

Applying a version requires a stopped executor without an open position,
preparing/unknown order, active test round, pending final settlement or losing
series. It does not reset a series, erase daily losses, change execution owner,
switch Paper/Auto or disable dry run. Use the explicit existing New series flow
when appropriate, not setup activation as a way around a lock.

Saved versions are append-only. Editing the live settings does not rewrite the
saved version. A modified setup has a new configuration fingerprint; each new
trade captures the actual allowed configuration and its named-version identity
at preparation, so changing the selected setup never relabels an existing bet.
CSV carries setup identity/version/fingerprint, and old untagged trades remain
unattributed rather than guessed.

## Timeframes and live markets

Signal timeframe and market expiration are separate fields in the definition.
The current execution policy requires them to be equal: closed signal candle S
enters the corresponding next round S+1. Mixed signal/expiration strategies are
not implemented; imports cannot quietly change that rule.

Paper retains all supported Binance chart intervals, including 1h and 4h.
Auto uses verified 5m/15m mappings and additionally 1h/4h for BTC, ETH, SOL and
XRP. DOGE, BNB and HYPE remain limited to the existing 5m/15m mappings. Listing
a chart interval is not evidence of a tradable round; a missing/closed round
never falls back to another timeframe.

Public Gamma checks on 2026-10-07 established:
- `btc-updown-4h-1791331200` (also ETH/SOL/XRP): UTC 00:00–04:00, Up/Down,
  accepting orders, Chainlink asset/USD TWAP-60s stream rules.
- `bitcoin-up-or-down-october-7-2026-12am-et` (also Ethereum/Solana/XRP):
  UTC 04:00–05:00, Up/Down, accepting orders, Binance 1h open/close rules.

Four-hour slugs use a UTC-floored Unix start. Hourly slugs use the named date/hour
in `America/New_York`, including DST. The returned market must match the exact
slug, UTC start/end, distinct Up/Down token IDs, resolution source and comparison
rule. An ambiguous repeated ET hour is rejected if Gamma returns the wrong UTC
round. These are public read-only checks, not proof of live fills or availability
for every future round.

Reference: [Gamma market discovery](https://docs.polymarket.com/market-data/discover-markets).
Real-money results still follow the final venue checks described in
[RECONCILIATION](RECONCILIATION.md), not a Binance-only settlement assumption.

## Persistence and handoff

The setup library travels with the trading book in a confirmed Zero Mode
handoff, and is included in full-data backups. Setup JSON export transfers one
definition only, never account credentials or ownership. Preserve the complete
data directory during upgrades; do not hand-edit IDs, fingerprints or version
history. Older binaries do not understand this metadata or the expanded live
timeframe mapping. Follow [OPERATIONS](OPERATIONS.md) for stopped backups and
compatible rollback.
