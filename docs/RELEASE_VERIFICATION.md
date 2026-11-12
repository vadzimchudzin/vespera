# Vespera 0.26.2 — real wallet balance and steadier Zero Mode

## What's new

- **The balance in Auto is the Polymarket wallet's, never the demo book.** After a server restart (an update, a crash, the handoff to the server) the window and Telegram could show the virtual Paper balance as the account balance, and the wallet was read only after a Connect or the first settled trade. An Auto session now says *checking* until the wallet has been read, reads it by itself as soon as its state is looked at (the server does it while it warms up after a start), keeps the last real figure — marked stale — when Polymarket does not answer, and the window and Telegram say what the figure is: the wallet, the virtual Paper book, or, during a dry run, the wallet plus the virtual dry-run account on a line of its own.
- **The desktop no longer looks disconnected during a long command.** The server answers the desktop heartbeat while a slow Start or another long command is running.
- **Auto goes on trading after the final settlement of a real-money trade.** The session starts again by itself through the ordinary Start with all of its checks; it does not after an explicit Stop, a series halt, another pause or a failed settlement.
- **Telegram speaks Russian when the interface does** and says when trading goes on again; the notification about a closed desktop states that the server keeps working.

See the full [changelog](https://github.com/vadzimchudzin/vespera/blob/v0.26.2/CHANGELOG.md). The notes of 0.26.1 (Zero Mode device reset) still apply.

## Verified locally

- Complete test suite (52 test files) on Linux, and again on the Node version and production dependencies of a Zero Mode server. The new tests fail on the previous code with the reported symptom — a server restarted in Auto after Paper trades reported the restored Paper book as its wallet — and cover the HTTP service, the execution host, the router and the Telegram bot in English and Russian.
- The window footer exercised in headless Chromium against real engine snapshots: wallet, dry run, stale, unavailable, the reply of a server from before this fix and Zero Mode before the server's first answer.
- A Zero Mode server running this code resumed its Auto session after a restart and read its wallet balance on its own, without a Connect.
- No order was placed in any test.

## Limitations and operator acceptance

- No real-money order was placed in testing. The wallet reading uses the existing authenticated balance request; it was verified against mocked venue answers and by one restart of a deployed server, not by an extended run.
- The wallet is read when the server starts and whenever the state is asked for — by the window or by a Telegram command — at most every 30 seconds. With nobody looking nothing reads it, so a deposit or withdrawal shows at the next look after that interval.
- Update the server first: it carries the balance fix for both the window and Telegram. A window from an earlier version shows the correct figure from an updated server but may flash a red "$0.00" for a few seconds after the server restarts; updating the window removes that and stops it from drawing its own virtual book before the server has answered.
- Customer Windows/macOS GUI, real venue execution, Telegram delivery and extended unattended soak have not been verified locally. Release CI separately runs platform tests and builds.

## Security audit limitations

Passing tests does not constitute an independent security audit or prove all venue or failure modes. Keep private keys, recovery codes, token files and data backups access-controlled. An exchange outage, pending trade, unavailable proof or storage failure must not be bypassed by manually changing ownership.
