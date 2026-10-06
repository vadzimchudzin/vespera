# Server operations readiness (stage 5)

This repository contains templates and offline tooling, not a provisioned
production host. Do not use it to claim HTTPS/DNS, venue reachability, external
alerts, a successful recovery drill, or a production soak before those are
actually run by the operator. The server remains loopback-only by default.

## Preflight

On the intended host, install Node.js 22+ and production dependencies from the
matching release. Use a dedicated unprivileged `vespera` account, a persistent
data directory with mode `0700`, and a token file outside it with mode `0600`.
Never pass or print token contents. For an already-running local service, run:

```sh
node scripts/operations-preflight.js \
  --data-dir /var/lib/vespera \
  --token-file /etc/vespera/server.token \
  --health-url http://127.0.0.1:8787/healthz
```

The check requires Node 22+, a writable private data directory, at least 1 GiB
free disk (change in code only after setting an operator-approved threshold),
a private token file of plausible minimum length, Linux `timedatectl` reporting
NTP synchronization, and an HTTP 200 `/healthz` response with protocol 1. It
prints metadata only. `healthz` proves process-level health, not venue
connectivity, order safety, ownership readiness or public reachability.

The main service unit is [`vespera.service`](../deploy/vespera.service). For
HTTPS termination see the explicitly illustrative
[`nginx-https.example.conf`](../deploy/nginx-https.example.conf): configure a
real DNS name/certificate and ingress firewall/allowlist; keep Node bound to
loopback. The example is not a certificate or firewall provisioner. Confirm
direct Binance/Polymarket connectivity and account/region permissions from the
actual host without routing around venue restrictions.

## Stopped-service backup and isolated restore

Stop the service and confirm it exited before taking a copy. The tool includes
the complete data tree (including ownership, journals, request tombstones,
Telegram/handoff master keys and all encrypted state) plus the separate API
token. It copies directories and regular files only, preserves file modes,
creates a SHA-256 manifest, rejects symlinks and refuses any `.service.lock`
including stale/unverifiable lock directories. No archive extraction or path
traversal is involved. Treat the result as a credential-bearing secret; store
it encrypted and access-controlled, outside the live data directory.

```sh
systemctl stop vespera.service
if systemctl is-active --quiet vespera.service; then
  echo "Vespera is still active; refusing backup" >&2
  exit 1
fi
node scripts/operations-backup.js \
  --data-dir /var/lib/vespera \
  --token-file /etc/vespera/server.token \
  --destination /secure/offline/vespera-2026-10-06
```

Restore is deliberately **not** an in-place rollback. Use fresh, empty,
isolated validation paths and both safety flags; it verifies every listed file
before copying and never launches a service or executor:

```sh
node scripts/operations-restore.js \
  --backup /secure/offline/vespera-2026-10-06 \
  --data-dir /var/tmp/vespera-restore-validation/data \
  --token-file /var/tmp/vespera-restore-validation/server.token \
  --isolated-validation --executor-start=false
```

Do not point validation at production directories, reuse another active book,
or start an executor against restored data. Verify ownership, request-ledger
tombstones, journal/checkpoint files and key-file presence while stopped;
maintain the restore copy as isolated evidence. This tooling does not prove
decryption, venue reconciliation, a live restart, or a safe rollback. Before
real rollback, follow [Zero Mode handoff rules](ZERO_MODE.md) and verify no
unknown order or active position. Never delete tombstones or reset ownership.

## Health and resource monitoring

Enable the local timer only after installing the matching source at
`/opt/vespera` and verifying its unit paths:

```sh
install -m 0644 deploy/vespera-monitor.service /etc/systemd/system/
install -m 0644 deploy/vespera-monitor.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vespera-monitor.timer
systemctl list-timers vespera-monitor.timer
journalctl -u vespera-monitor.service
```

The timer polls unauthenticated `/healthz`, records disk-free bytes, free
memory, load averages and threshold alerts, and exits nonzero on health/resource
failure. It only reports; **it does not restart, take ownership, switch to the
desktop, or start a second executor**. The service's own `Restart=on-failure`
handles process restart, not executor takeover. Tune thresholds to the host's
measured baseline before relying on alerts.

Because a monitor on the same host cannot detect host/network/power failure,
configure an independent external uptime monitor to check HTTPS `/healthz`
from outside the host. Add external disk, memory, CPU/load, certificate-expiry,
NTP/clock-offset, backup-age, restart-count and venue-connectivity alerts using
the operator's chosen monitoring system. Restrict alert payloads: never include
tokens, request bodies, settings, wallet material, or private health data.
Test notification delivery and host-down detection explicitly. The local timer
and checklist do not provision or verify an external monitor.

## Paper soak and acceptance evidence

Run an isolated Paper/dry-run soak for an initial 24–72 hours before any live
consideration; longer operation is a separate goal. Record start/end time,
build and Node versions, configuration (redacted), ownership mode, Paper-only
assertion, uptime/restarts, health failures, CPU/memory/load/disk samples,
clock synchronization, network/venue status, and alert receipt/delay. Exercise
planned service restart, network loss/return, low-disk alert in a disposable
test environment, and backup/isolated restore. Confirm no second executor
starts and tombstones/owner/checkpoints survive. Investigate every unknown order,
state mismatch or gap; a short soak cannot establish long-term reliability.

Before any separate live-money test, require explicit user approval, independent
financial/order reconciliation and key-storage review. This task did not access
a production server, credentials, accounts, or network venue and did not run a
soak or provision TLS/firewall/monitoring.
