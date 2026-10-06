# Live-order and final-settlement reconciliation

Real-money Polymarket orders and results are fail-closed. The engine records a
durable intent (including client order ID, side, requested amount, round,
strike, timing, and fee schedule) before POST. The broker may attach a
read-only order hash/token/market identity through
`journal.attachOrderEvidence(clientOrderId, evidence)` immediately before the
POST. The journal allowlists identity and pricing metadata; signatures,
private keys, API credentials, and raw signed payloads are never persisted.

If the POST outcome is unknown, the pending marker survives restart and blocks
entries, mode changes, and handoff. `inspectPendingOrder()` performs a fresh
authoritative read without changing engine state. `resolvePendingOrder({
clientOrderId, orderId, confirm: true })` performs its own fresh inspection;
caller-supplied order details are never trusted. Only a valid `filled` result
with matching order identity and execution evidence is restored as a durable
`order_sent` (or `test_order`) before the pending marker is removed. Partial
fills are restored using actual filled amount, shares, price, and fee. A
not-found response, API outage, mismatch, malformed fill, or missing evidence
leaves the marker blocked. Successful resolution leaves trading stopped and
requires an explicit Start.

Inspection calls authenticated `GET /data/order/{orderID}` and
`GET /data/trades?id=...&maker_address=...`. It checks the wallet, token, order
hash, terminal status, confirmed taker trades and exact matched-size coverage.
Fees are derived per fill using the reported fee rate and the saved exponent;
this is not a separate on-chain fee-receipt verification. Missing fee metadata,
non-final trades or inconsistent amounts remain blocked. No estimate based on
side/time/stake is accepted as order identity.

For real-money strategy positions, the Binance close is only stored in a
durable `settlement_provisional` checkpoint. It does not update P&L, risk,
series progression, reports, or `settled` notifications. The open position
continues to lock new entries and execution handoff. A bounded, unreferenced
poller asks the broker for the authoritative Polymarket outcome; unresolved
results survive restart and polling is independent of Stop. Once resolved, a
single durable `settled` row tagged `settlementStatus: "final"` and
`settlementSource: "polymarket"` applies the actual outcome to P&L and risk.
This deliberately waits rather than replaying later trades after a correction.
Finality requires `closed: true`, `umaResolutionStatus: "resolved"`, exact
binary 0/1 prices and the original held token in the requested round. A closed
market, a proposed result or a quote of 0.99 alone is not proof. The current
implementation stops the trading session when waiting; finalization does not
automatically Start it. Review the result/series and explicitly resume.
After bounded failure the durable provisional position remains blocked; a
later reconciliation attempt or restart can resume checks. Paper and dry-run
settlement retain their immediate Binance behavior.

The Engine exposes `finalPending` in snapshots. Consumers must display it as
unresolved, not as a win/loss. Live statistics and exports exclude explicitly
non-final rows and include authoritative final rows. Historical live rows
already booked by older releases remain included for risk continuity and are
labelled `legacy` / `legacy_binance` in CSV. Paper and dry-run statistics are
unchanged.

Upgrades should be performed while stopped with full backups. Existing live
positions retain their token identity from the journal; older entries without
that identity are not guessed and can remain blocked. Secrets encrypted in the
new format cannot be read by old binaries: rollback means stopping both sides
and restoring a compatible complete backup, not installing the old application
against the new data directory.
