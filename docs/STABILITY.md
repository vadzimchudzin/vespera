# Stability and recovery — updated for 0.22.0 source

The original reliability stage was 0.18.10. Server execution, Zero Mode,
Telegram and fixed stake ladders have since been added; backtests and AI remain
future work. Final venue settlement is described in [RECONCILIATION](RECONCILIATION.md).

## Connection behaviour

- Binance connects through WebSocket with a 15-second handshake timeout and
  REST reconciliation every 15 seconds. Reconnect events are logged as
  `data_health`; REST failures appear as `data_error`.
- Trade ticks update the forming candle, but do not declare it closed.
- Candle history comes from Binance.com (`api.binance.com`, then the official mirror `data-api.binance.vision`). If both are unreachable the app falls back to Binance.US, a different exchange with different candles. The status exposes `feed.degraded`, the journal records `feed_fallback_binance_us`, real-money Start is refused and a real-money order is never placed on such candles. Paper and dry run continue with a warning.
- Missing historical candles block entries until the required indicator window
  is continuous. Expired recovered signals are not traded retrospectively.
- A confirmed live test bet locks further test/strategy entries until its round
  expires, including across restarts; it remains excluded from strategy results.
- A temporary venue-down pause keeps health checks running once a minute.
  A previously started session resumes after a successful check and, for live
  money, a fresh allowed-region check. It does not resume after a manual Stop,
  a stake/risk halt, a daily loss limit or an unknown order outcome.
- These mechanisms improve recovery; they do not guarantee uninterrupted
  operation or profitability. This release has deterministic fault tests, not
  a year-long production soak test.

## Durable state

Files live next to `settings.json` in Electron's application user-data directory:

- `journal.jsonl` and numbered rotations: diagnostics and trade history.
- `journal.jsonl.state.json`: atomic replay checkpoint for risk, balances and
  open positions, retained independently of rotating diagnostics.
- `journal.jsonl.pending.json`: intent for a live order whose outcome has not
  yet been durably recorded.

Do not delete these files to reset a running bot. Back them up together while
the application is stopped. A malformed checkpoint or pending marker fails
closed rather than silently discarding a possible position.

## Unknown execution outcome

A timeout, aborted response or server error after POST does not prove that an
order failed. The bot preserves its intent, pauses and refuses both Start and
test orders across restarts. Health recovery cannot clear this protection.

Stop the application and check the Polymarket account's orders and fills for
the intent's side, amount and round. Preserve the logs and checkpoint. Any
accepted position must be reconciled with local position/series state before
trading is allowed again. Do not repeatedly press Start or remove the pending
marker simply because the network works again.

The API panel now inspects exact order hashes and confirmed fills and can
restore verified execution after a second fresh check. It never resends the
order or clears a lock on a 404. Old markers without sufficient identity remain
blocked and require reviewed recovery. See [RECONCILIATION](RECONCILIATION.md).
The marker contains local order context, not API/private keys. Do not share
settings or unredacted logs.

## Verification

`npm test` runs the existing strategy, engine, broker, persistence, pricing,
risk, safeguard, connection, export, bridge and proxy checks plus:

- `marketData.test.js`: reconnect/handshake lifecycle, stale REST responses,
  candle authority, history limits and recovery signals.
- `journalState.test.js`: state beyond log rotation and diagnostic memory
  limits, pending intents, private file permissions and corrupted state.
- `reliability.test.js`: entry serialization, cancellation, unknown outcomes
  across restart, durable intent after recording failure, original-round
  settlement and temporary venue recovery.
