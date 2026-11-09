# Vespera 0.28.2 — device reset verification

## What's new

The Execution settings provide a recovery-code reset for Zero Mode. A server-owned position is stopped and submitted for a bounded marketable sale; confirmed partial fills are recorded and outstanding positions keep access locked. The server rotates the token and preserves its account for the new device. For a local owner, the updated original desktop must be online and enrolled to stop and transfer its book. See the full [changelog](https://github.com/vadzimchudzin/vespera/blob/v0.28.2/CHANGELOG.md).

## Verified locally

- Complete test suite on Linux, including mocked exchange partial fills, unknown outcomes, restart and retry, ownership transfer, invalid codes, token revocation, stale requests, disk failure and new-device login.
- Settings reset form exercised in headless Chromium with mocked IPC; the entered recovery code is cleared after submission.
- Public Polymarket book and market metadata endpoints checked without placing an order.

## Limitations and operator acceptance

- No real-money sale or live credential was used in testing. Venue liquidity, fill confirmation, minimum-size limits and rounding dust can prevent an immediate close; the reset stays blocked when the result is not proven or a position remains.
- An offline or old unenrolled local desktop cannot be stopped or sold remotely. Update it and reconnect it, or perform the reset on that owning desktop after updating it. Never manually clear ownership to bypass an unknown position.
- The reset code must be provisioned separately as a private file on the server and shared through a secure channel. See [operations](OPERATIONS.md). The new token is shown in the app and must be distributed securely for subsequent login.
- Customer Windows/macOS GUI, real venue execution, Telegram delivery and extended unattended soak have not been verified locally. Release CI separately runs platform tests and builds.

## Security audit limitations

Passing tests does not constitute an independent security audit or prove all venue or failure modes. Keep private keys, recovery codes, token files and data backups access-controlled. An exchange outage, pending trade, unavailable proof or storage failure must not be bypassed by manually changing ownership.
