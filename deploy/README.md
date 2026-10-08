# Vespera server service

For stopped-service checksummed backup, isolated restore, preflight and
non-takeover health/resource monitoring procedures, see
[`docs/OPERATIONS.md`](../docs/OPERATIONS.md).

Run the server only on a trusted host with a persistent, private data directory. It binds to loopback by default and requires a bearer token of at least 32 bytes. Enter the matching token once in the desktop password field; never persist or echo it in renderer state, URLs, logs or command lines.

```sh
useradd --system --home-dir /var/lib/vespera --create-home --shell /usr/sbin/nologin vespera
install -o vespera -g vespera -m 700 -d /var/lib/vespera /etc/vespera
sudo -u vespera sh -c 'umask 077; openssl rand -hex 32 > /etc/vespera/server.token'
chmod 600 /etc/vespera/server.token
```

Install Node.js 22+ and the matching release source under `/opt/vespera`. Run `npm ci --omit=dev` there: the server needs production dependencies but not Electron. Give the `vespera` user read access to the source and ownership of its data/token files. Copy `vespera.service` to `/etc/systemd/system/`, then enable it:

```sh
systemctl daemon-reload
systemctl enable --now vespera.service
```

The service reads `VESPERA_DATA_DIR`, `VESPERA_SERVER_TOKEN_FILE`, `VESPERA_HOST`, and `VESPERA_PORT`. Direct launch requires either `VESPERA_SERVER_TOKEN` or a private token file; token values are never printed. Preserve the data directory across restarts: it contains the owner record, deduplication ledger, engine journal, and settings. A corrupt owner record intentionally prevents startup. A server that restarts while desktop ownership is local stays stopped and does not reclaim execution; when server-owned, only a previously explicit running session may be resumed after pending-order and halt checks.

The API uses authenticated `/v1/status`, `/v1/snapshot`, `/v1/events`, `/v1/command`, `/v1/register`, `/v1/activate`, `/v1/release`, and `/v1/heartbeat` routes. Registration binds an unassigned local owner to one desktop without importing or replacing its history; only that device may later activate, command, or release server execution. Unauthenticated `/healthz` exposes only process health and protocol version. `POST` commands are never automatically retried; durable per-request tombstones reject duplicate completed IDs and report pending outcomes as unknown. Release bundles contain portable settings and the latest 5,000 journal rows plus checkpoint; the retry cache is encrypted at rest and remains until a new activation. Transfer bundles include credentials, so use HTTPS whenever the API leaves loopback.

`VESPERA_HOST` defaults to `127.0.0.1`; expose it beyond loopback only behind a trusted network boundary and TLS. The service does not provide browser CORS access.

## Production checklist

- Provision a trusted server and an HTTPS API endpoint with a valid certificate.
  Keep the Node listener on loopback; configure TLS termination separately and
  restrict unauthenticated access. Do not expose Electron's debugging port.
- Verify direct Binance/Polymarket access and the account's permitted trading
  region. No trading proxy is used by this service; no regional restriction is
  bypassed by deployment.
- Preserve `/var/lib/vespera` and the token file across updates. Back up both
  desktop/server data while execution is stopped; protect backups and use disk
  encryption for signing credentials. Existing OS/machine-bound settings
  encryption is not a substitute for protecting the server filesystem.
- Rotate the API token by stopping the service, securely replacing its token
  file and updating the desktop token for the same endpoint. The client checks
  the new token and the existing device owner before saving it; this does not
  transfer execution. Changing the endpoint requires a safe release first.
  Never reset the owner record to bypass a disconnected client.
- Maintain disk space, backups and external uptime alerts. Idempotency
  tombstones are permanent per request and must not be deleted to permit a
  replay. Old transferred book directories are recovery backups, not active
  extra engines.

The desktop token authorizes the account's entire control API; only share it
with the registered client. One installation per server/book is supported.
Do not clone a registered user-data folder or run another independent bot
against the same wallet.

For the user-facing ownership, handoff and rollback rules, see
[`docs/ZERO_MODE.md`](../docs/ZERO_MODE.md). This release supplies the service
and deployment template; it does not provision the user's production server
or claim a year-long production soak. Telegram control is implemented; configure and pair the bot on the intended executor as described in `docs/TELEGRAM.md`. Real bot delivery and production onboarding must be verified separately.
