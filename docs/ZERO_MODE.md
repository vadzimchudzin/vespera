# Server execution and Zero Mode — 0.20.0

## Execution model

There is one account/book and one designated executor. `paper/auto` selects the
trading book; `local/server` selects where its engine runs. These are separate
choices. The server starts unassigned and stopped, and registration binds it
to one desktop installation. Do not clone a registered desktop user-data
directory onto another running computer or run a second server against a copy
of the same account's data. Independent installations with the same wallet are
outside this ownership protocol.

The desktop's Server URL must be HTTPS with a valid certificate. HTTP is
accepted only for literal loopback (`127.0.0.1` or `[::1]`), for local tests or
an appropriately secured tunnel. Tokens must be at least 32 non-whitespace
characters. Blank token inputs retain the existing encrypted token. The token
is never part of renderer settings, snapshots or screenshots.

For token rotation the desktop may replace its token for the same HTTPS
endpoint after verifying the registered device owner. Endpoint changes still
require a safe release; replacing a token never transfers or starts execution.

The server is a separate Node process (`npm run server`), not a copy of the
desktop window. It ignores imported/updated trading proxy settings, including
Bridge account operations. Binance and venue requests must be permitted
directly from the host; deployment does not override venue/account/region
restrictions. HTTPS termination for the control API is separate from a trading
proxy. Local execution retains its own optional trading proxy.

## Switching

1. Stop or allow the current position to finish. No open position, active test
   round, in-flight order or unknown execution intent may be transferred.
2. Configure and connect the server under Settings → Execution.
3. Enable Zero Mode and confirm transfer. Settings (including account signing
   credentials), risk checkpoint, balance and up to the latest 5,000 journal
   rows are transferred privately. Historical signed payloads are omitted.
4. The server becomes owner; the local engine remains stopped. Press Start
   explicitly when ready. The server's chart warms independently of trading.
5. To return to the desktop, disable Zero Mode and confirm. The server stops
   new entries and must confirm a position-free release before local state is
   imported. Press Start explicitly to trade locally again.

Transferred keys and retry bundles are encrypted at rest by the existing local
settings store. Data folders remain sensitive; OS ownership, private modes,
backup security and disk encryption are still the operator's responsibility.
Old epoch folders stay on disk as recovery backups and may contain encrypted
keys. Never delete them while a handoff is unresolved.

## Disconnects and restarts

Closing the desktop in Zero Mode sends no server Stop. A restarted desktop
restores its remote route and loads the server's state; it never automatically
starts a local core. Missing heartbeats mark the desktop disconnected after
30 seconds but do not change execution ownership or stop server trading.

When the server cannot be reached, the UI keeps the last chart and marks it
stale. Commands and local fallback are blocked. Its current trading status is
unknown, not assumed stopped. After connectivity returns, authoritative server
snapshots replace the cached display. No market data is fetched by the inactive
desktop engine in Zero Mode.

If a handoff reply is lost, the route remains durably locked. Retry transfer
uses the same request ID and encrypted payload. Do not clear ownership files,
use a different installation or repeatedly submit orders to bypass this lock.

The server may resume a previously explicitly started server-owned session on
service restart after the engine's region, pending-order and halt checks.
Manual Stop, permanent/risk pauses and unknown orders must not auto-resume.
If the desktop is owner, a server restart stays non-trading. Corrupted owner or
critical state files fail closed. Supervisors restart crashes; they do not
make an unavailable venue tradable.

## Deployment and rollback

See [deployment instructions](../deploy/README.md). Production requires a
persistent private data directory, private server token, Node 22+, approved
direct venue access and HTTPS control endpoint. No production server has been
provisioned by this source change; screenshots use an isolated local Paper
service without customer credentials.

Back up both desktop and server data with execution stopped before upgrading.
Do not roll back by merely installing an old desktop: it does not understand
server ownership and could independently trade. First safely release ownership
to the desktop, stop both processes, then restore compatible data backups.
Keep the old server stopped. Never reset owner state to recover an unknown bet.

## Current limits

- One registered desktop installation per server/book, not multi-tenant HA.
- Handoff is position-free and requires connectivity; not offline emergency
  takeover or automatic mid-round migration.
- Recent journal history and series checkpoint transfer; older archives remain
  on their original machine. Payloads above 16 MiB fail closed.
- External uptime monitoring, automatic
  unknown-order reconciliation, hosted deployment and a production soak are
  subsequent work, not claimed here.

Telegram control and trade reports were added in 0.21.0; see
[Telegram onboarding](TELEGRAM.md). Its credentials are executor-specific,
not a portable trading-book credential. Configure the bot on the intended
executor; do not run the same token on two independently configured installations.

`npm test` covers HTTP authentication/ownership,
request replay, real service startup, proxy stripping, encrypted state,
closing/restarting a UI, active-position refusal and lost-response recovery.
