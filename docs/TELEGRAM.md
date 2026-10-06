# Telegram control panel

Telegram controls the existing execution engine; it is not a second trading bot.
The desktop remains the place to configure credentials and pair the first administrator.

## Connect

1. Create a bot with Telegram's **@BotFather** and obtain its token.
2. Open **Settings → Telegram** on the intended executor. In Zero Mode these
   settings belong to the connected server.
3. Enter the token in the password field and enable the integration. The app
   checks the bot identity before saving the token; it never returns the saved token.
4. Generate a one-time administrator code and send `/pair CODE` in a private
   conversation with the bot. The code expires after ten minutes and is single-use.
5. Send a test message from Settings. Do not put tokens or pairing codes in Git,
   public chat, screenshots or logs.

The token and access state are stored separately from trading settings, encrypted
with a random local master key. Back up the private Telegram directory together
with its master key. Encryption does not protect against someone who can read
both files or control the host. Storage failures do not fall back to plaintext.

## Access

An unapproved user sees only the access-request flow, never trading data.
The paired root administrator approves or denies requests and can revoke users.
Approved users control the same trading book, not separate accounts. Granting
access therefore grants trading authority. Group conversations are not supported.

Do not assume that an unadvertised bot is private: authentication uses numerical
Telegram identities, not usernames or possession of the bot link.

## Trading

Status, balance, strategy, mode, Start, Stop, New series and a restricted set of
settings use the same execution and risk checks as the desktop. Start enables
automatic strategy execution; individual strategy bets need no approval.
Real-money Start and New series require a short-lived, single-use confirmation.
Stop is immediate. An unknown order or risk halt cannot be cleared through Telegram.

The server remains the executor in Zero Mode when the desktop is closed.
Disconnection never authorizes local takeover. Telegram cannot activate an absent
desktop or create another engine. Switching execution remains a desktop operation.

## Delivery and limits

Updates are durably marked before handling commands. Replayed updates never
blindly retry a monetary action; after a crash an uncertain action must be checked
against the authoritative state. Notifications use a persistent outbox and retry
with backoff, including Telegram's `retry_after` response for rate limits.

Telegram failures must not stop the trading engine. A lost send response can
produce a duplicate notification: Telegram does not provide an idempotency key
for `sendMessage`. Delivery is not an exactly-once guarantee.

Trade results currently retain the provisional Binance settlement behavior
documented in [STABILITY](STABILITY.md); Telegram does not implement final
Polymarket/Chainlink reconciliation. Never interpret a notification as evidence
that this remaining financial-safety milestone has been completed.

Protocol reference: [Telegram Bot API](https://core.telegram.org/bots/api).
Production onboarding with a real bot and real-money tests require separate
credentials/authorization; isolated transport tests do not prove live Telegram delivery.
