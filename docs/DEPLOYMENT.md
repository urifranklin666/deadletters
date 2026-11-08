# Production deployment

This document describes a single-host Linux deployment with systemd, a dedicated
service account, and a TLS reverse proxy. The files under `deploy/` are reviewed
starting points, not an installer. Adjust paths, hostnames, and TLS settings to
the target host, then review the result before exposing it to the internet.

Application behavior is unchanged by these examples. Deadletters remains a
single Node.js process with an embedded SQLite database.

## Supported runtime

- Node.js 22 LTS, minimum `22.12.0`, is supported by the package `engines` field.
- Node.js 24 LTS is the CI target and the recommended production runtime.
- `better-sqlite3` is a native dependency. Use a Node release with an available
  prebuilt binary, or install a C/C++ build toolchain and Python before running
  `npm ci --omit=dev`.
- Node.js 26 is not claimed as tested by this repository. Validate a newer
  runtime in staging before changing production.

Do not run multiple Deadletters processes against the same SQLite database or
runtime directories. The application is not a clustered or multi-writer design.

## Layout and accounts

```text
/opt/deadletters/                    read-only engine, root:root, 0755
  bin/deadletters.js
  node_modules/
  scripts/backup.sh
  docs/
/var/lib/deadletters/                deadletters:deadletters, 0750
  data/                              deadletters:deadletters, 0700
    deadletters.db                   mode 0600
    deadletters.db-wal / -shm        mode 0600
    config.json                      mode 0600, contains saved secrets
  uploads/                           deadletters:deadletters, 0750
  themes/                            deadletters:deadletters, 0750
  addons/                            deadletters:deadletters, 0750
  backups/                           deadletters:deadletters, 0700
/etc/deadletters/
  deadletters.env                    root:deadletters, 0640
/etc/systemd/system/
  deadletters.service
  deadletters-backup.service
  deadletters-backup.timer
```

Create the dedicated account without a login shell:

```bash
sudo useradd --system --home-dir /var/lib/deadletters \
  --shell /usr/sbin/nologin --user-group deadletters
sudo install -d -o deadletters -g deadletters -m 0750 /var/lib/deadletters
sudo install -d -o deadletters -g deadletters -m 0700 /var/lib/deadletters/data
sudo install -d -o deadletters -g deadletters -m 0700 /var/lib/deadletters/backups
sudo install -d -o deadletters -g deadletters -m 0750 \
  /var/lib/deadletters/uploads /var/lib/deadletters/themes /var/lib/deadletters/addons
```

The supplied service uses `StateDirectory=deadletters`, so systemd can also
create the state root. The explicit commands make ownership and modes obvious
and let you pre-create the directory tree.

## Install the engine

Install a released engine archive or a reviewed checkout into `/opt/deadletters`.
Do not run the engine directly out of a developer home directory in production.

```bash
sudo install -d -o root -g root -m 0755 /opt/deadletters
# Copy or extract the engine into /opt/deadletters, then:
cd /opt/deadletters
sudo npm ci --omit=dev
sudo chown -R root:root /opt/deadletters
```

Seed the writable theme/addon state from the bundled engine content. The bundled
themes include the default active theme; without this step the writable state
directories are empty and the publication has no installed themes or addons.
The demo images are optional, but copying them avoids broken images if the
installer seeds demo content:

```bash
sudo cp -a /opt/deadletters/src/themes/. /var/lib/deadletters/themes/
sudo cp -a /opt/deadletters/src/addons/. /var/lib/deadletters/addons/
sudo find /opt/deadletters/public/uploads -maxdepth 1 -type f -name 'deadplug_*.jpg' \
  -exec cp -a {} /var/lib/deadletters/uploads/ \;
sudo chown -R deadletters:deadletters \
  /var/lib/deadletters/themes /var/lib/deadletters/addons /var/lib/deadletters/uploads
sudo chmod -R u=rwX,g=rX,o= \
  /var/lib/deadletters/themes /var/lib/deadletters/addons /var/lib/deadletters/uploads
```

Future theme/addon installs through the admin UI write into these state
directories, so they must remain writable by `deadletters`.

The engine directory contains no runtime database, `config.json`, uploads, or
backups after a clean install. Runtime state is kept under `/var/lib/deadletters`.
The application never writes to `/opt/deadletters` when the `DEADLETTERS_*` paths
and `DB_PATH` point at the state tree.

The clean engine ZIP is built from a runtime source allowlist and does not include
`deploy/`, `docs/`, or `scripts/backup.sh`. If you deploy from that ZIP rather
than a repository checkout, copy those files into `/opt/deadletters` before
enabling the backup unit; the script still uses the engine's
`bin/deadletters.js` snapshot command.

The systemd unit uses `ProtectSystem=strict` and `ReadWritePaths=/var/lib/deadletters`,
so writes elsewhere fail even if file modes are accidentally permissive.

## Environment file

```bash
sudo install -d -o root -g deadletters -m 0750 /etc/deadletters
sudo install -m 0640 -o root -g deadletters \
  deploy/deadletters.env.example /etc/deadletters/deadletters.env
sudoedit /etc/deadletters/deadletters.env
```

Replace every placeholder secret. Generate long random values locally, for
example:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Do not reuse the JWT secret as the legacy provenance secret. Never commit the
filled environment file or paste secrets into tickets, logs, or chat.

The installer writes `<DEADLETTERS_DATA_DIR>/config.json`. That file contains the
saved JWT secret, legacy provenance secret, host, port, and installation
metadata. It is mode `0600` but is included in snapshots. The SQLite database also
contains the node's Ed25519 private key. Protect the environment file, the data
directory, and snapshot archives as credentials.

Environment values take precedence over saved `config.json` values for host,
port, JWT secret, and legacy provenance secret. `site_url` is an editorial
setting stored in SQLite and must be set in the admin UI after installation or
restore.

## Install and start systemd units

```bash
sudo install -m 0644 deploy/deadletters.service.example \
  /etc/systemd/system/deadletters.service
sudo install -m 0644 deploy/deadletters-backup.service.example \
  /etc/systemd/system/deadletters-backup.service
sudo install -m 0644 deploy/deadletters-backup.timer.example \
  /etc/systemd/system/deadletters-backup.timer

sudo systemd-analyze verify /etc/systemd/system/deadletters.service
sudo systemctl daemon-reload
sudo systemctl enable --now deadletters.service
```

Before installation, `/readyz` returns `503` because the node is not installed.
That is expected. Complete installation through `https://YOUR_HOST/installer`
with the one-time `DEADLETTERS_SETUP_TOKEN` from the environment file, or run the
interactive CLI with the same environment:

```bash
sudo systemd-run --uid=deadletters --gid=deadletters --pty \
  --property=EnvironmentFile=/etc/deadletters/deadletters.env \
  --property=WorkingDirectory=/opt/deadletters \
  /usr/bin/node /opt/deadletters/bin/deadletters.js install
```

After installation, remove or rotate the setup token and restart the service.
Production and remote web installation require a valid setup token; tokenless
installation is restricted to localhost in non-production mode.

Enable the daily backup timer after the environment file is final:

```bash
sudo systemctl enable --now deadletters-backup.timer
systemctl list-timers --all deadletters-backup.timer
```

The backup script and timer are described in [BACKUP.md](BACKUP.md).

## Reverse proxy and TLS

Use `deploy/Caddyfile.example` or `deploy/nginx.conf.example`. Both terminate TLS,
proxy to `127.0.0.1:3000`, preserve `Host`, and set `X-Forwarded-Proto` so the
application can emit HSTS correctly. Keep `HOST=127.0.0.1` in the environment
file; do not expose port 3000 on a public interface.

Caddy:

```bash
sudo install -m 0644 deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

nginx:

```bash
sudo install -m 0644 deploy/nginx.conf.example \
  /etc/nginx/sites-available/deadletters.conf
sudo ln -s /etc/nginx/sites-available/deadletters.conf \
  /etc/nginx/sites-enabled/deadletters.conf
sudo nginx -t
sudo systemctl reload nginx
```

Set `site_url` in **Admin → Settings** to the public origin, for example
`https://deadletters.example.com` with no trailing slash. Canonical links, feeds,
the sitemap, and discovery output use that value.

The proxy examples deliberately do not add CSP, frame, referrer, permissions, or
HSTS headers. The application already sends them. nginx `add_header` would append
a second value rather than replace the upstream header, so duplicating HSTS or
CSP at the proxy is actively harmful. If you move security-header responsibility
to the proxy later, remove the corresponding application behavior or verify that
duplicates do not appear.

Body limits accommodate the application's own bounds: the WXR importer enforces
20 MiB and media uploads enforce 25 MiB. The examples allow 26 MiB at the proxy
for multipart framing. Tighter per-location limits are fine if they remain above
the application limit.

CORS remains same-origin by default. Do not set a wildcard origin. If another
browser origin must call the API, list that exact HTTPS origin in
`DEADLETTERS_CORS_ORIGINS`.

## Firewall

Allow only the edge ports needed by the proxy, and keep the application port on
loopback:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw status verbose
```

With nftables or a cloud security group, apply the same policy: inbound 80/443
from the internet, no inbound 3000, and no database or file-share ports. If the
site is meant to be public, do not restrict 443 to a private range.

## Health and readiness

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS https://deadletters.example.com/healthz
```

- `/healthz` is liveness. It returns `200` before installation and after it.
- `/readyz` is readiness. It returns `200` only when the node is installed, SQLite
  answers, and the data and uploads directories are writable. It returns `503`
  with safe component booleans otherwise.
- Do not use `/readyz` as a process liveness check. An uninstalled node is
  intentionally not ready.
- Use an external monitor against `/healthz` for process availability and
  `/readyz` for service readiness. Both use `Cache-Control: no-store`.

## Upgrades and migrations

Migrations run automatically, in order, when the database is opened. There are no
down migrations. Back up first and plan a rollback that restores the pre-upgrade
snapshot if a migration is not reversible in practice.

Recommended procedure:

1. Run a fresh backup and copy the encrypted archive off-host. Verify the backup
   is newer than the current deployment and nonzero.
2. Stop the application: `sudo systemctl stop deadletters.service`.
3. Stage the new engine in a separate directory, run `npm ci --omit=dev` there,
   and review the diff and release notes.
4. Atomically switch directories, keeping the previous engine available:

   ```bash
   sudo mv /opt/deadletters /opt/deadletters.previous
   sudo mv /opt/deadletters.new /opt/deadletters
   sudo chown -R root:root /opt/deadletters
   ```

5. Start the service and follow the journal:
   `sudo systemctl start deadletters.service && journalctl -u deadletters -f`.
6. Check `/readyz`, then exercise login, a public letter, a feed, and media.
7. New bundled themes/addons are not copied into the writable state tree
   automatically. Compare the release contents and stage new bundled items
   without overwriting operator-customized or newer installed versions.
8. Keep `/opt/deadletters.previous` and the pre-upgrade backup until the new
   version has been stable for an agreed period.

If startup fails, stop the service and inspect the migration error before making
further changes. Do not repeatedly restart a service whose migration is failing.

## Rollback

**Engine-only rollback** is safe only when the database schema is still
compatible with the older engine:

```bash
sudo systemctl stop deadletters.service
sudo mv /opt/deadletters /opt/deadletters.failed
sudo mv /opt/deadletters.previous /opt/deadletters
sudo systemctl start deadletters.service
```

**Database-inclusive rollback** is required after a migration the older engine
does not understand. Restore into a new directory rather than overwriting the
live installation. See [BACKUP.md](BACKUP.md) for the restore-to-new-directory
drill. Then update `DEADLETTERS_DATA_DIR`, `DEADLETTERS_UPLOADS_DIR`,
`DEADLETTERS_THEMES_DIR`, `DEADLETTERS_ADDONS_DIR`, and `DB_PATH` in the
environment file, or replace the live state after taking a safety snapshot.

After any restore, set `site_url` to the correct public origin and re-check the
node identity if the restore is from before a key rotation.

## Logs

Application and backup logs go to journald:

```bash
journalctl -u deadletters.service -f
journalctl -u deadletters.service --since '1 hour ago'
journalctl -u deadletters-backup.service --since '7 days ago'
systemctl list-timers --all deadletters-backup.timer
```

`DEADLETTERS_LOG_REQUESTS=1` adds one JSON line per request with method, path,
status, and duration. Query strings, cookies, authorization headers, and request
bodies are not logged. Use journald's retention/rate limits; do not add a second
file logger that might capture secrets or grow without bound.

## Federation peers and key checks

Federation is delivery-only. Peers must be registered explicitly; there is no
automatic remote key discovery or ingestion of remote content.

1. Fetch the peer's public discovery document over HTTPS:
   `https://PEER/.well-known/deadletters.json`.
2. Verify the peer's node handle and Ed25519 public key through an independent,
   trusted channel. A key fetched only from the same TLS connection proves less
   than an out-of-band fingerprint comparison.
3. Register the peer with its endpoint, node handle, key ID, and public key in the
   Deadletters federation controls.
4. After either side runs `rotate-node-key --reason "..."`, the peer must
   re-register the new public key out-of-band. Old envelopes remain locally
   verifiable against retained public-key history, but they are not re-signed or
   re-delivered under the new identity.
5. Rotation is not revocation. A disclosed old private key stays compromised, and
   pre-rotation snapshots still contain that old private key. Rotate the node key
   and treat affected snapshots as sensitive even after rotation.

Use valid TLS between peers. Do not disable certificate verification to make a
peer work; fix the trust chain instead.

## Secret rotation

- **JWT secret**: generate a new value, update the environment file (or saved
  `config.json`), and restart. Existing bearer tokens become invalid.
- **Legacy provenance secret**: generate a new value and restart. It is used only
  to verify pre-envelope HMAC provenance rows; rotating it may make those old
  local-integrity rows unverifiable. New re-letters use Ed25519.
- **Setup token**: use a one-time random value. Remove it from the environment
  file after installation. Do not reuse it as a login password.
- **Node Ed25519 identity**: run
  `node bin/deadletters.js rotate-node-key --reason "..."` with the service
  environment while the server is stopped. Notify peers, re-register the new
  public key, and remember that old snapshots retain the old private key.
- **Backup age recipient**: generate a new age identity off-host, update
  `DEADLETTERS_BACKUP_AGE_RECIPIENT`, and retain the old private identity as long
  as old archives must be restorable. Backups are not re-encrypted automatically.
- **Filesystem secrets**: `config.json`, the database, environment files, backup
  archives, and age identities should be owner-only. Rotate any secret that may
  have been exposed; changing file modes is not a substitute for rotation.

## Explicit non-goals and limitations

This deployment shape does **not** provide:

- High availability, automatic failover, horizontal scaling, or multiple writers.
  SQLite and the in-process federation worker assume one active process.
- Automatic OS package management, container images, Kubernetes manifests, or
  configuration management.
- Built-in TLS termination. Use the reverse-proxy examples or a load balancer.
- A managed backup service, automatic off-site replication, or a guaranteed
  recovery point/time. See [BACKUP.md](BACKUP.md).
- Automatic federation key discovery, revocation, retraction, or remote content
  ingestion.
- Email delivery, hosted media/object storage, search clustering, or a CDN.
- Log rotation beyond journald's configured retention.
- A tested Windows service or non-Linux init integration.

Validate backups, restores, upgrades, firewall rules, and TLS in staging before
relying on them in production. Monitor the service and the backup timer; a unit
that is enabled is not proof that its last run succeeded.

## Deployment checklist

- [ ] Dedicated `deadletters` account has no login shell and owns only runtime state.
- [ ] Engine under `/opt` is root-owned and read-only to the service.
- [ ] Environment file is `root:deadletters 0640`; no placeholders remain.
- [ ] `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`.
- [ ] Data paths and `DB_PATH` point into `/var/lib/deadletters`.
- [ ] Bundled themes/addons (and optional demo images) are seeded into writable state.
- [ ] `site_url` is the public HTTPS origin with no trailing slash.
- [ ] TLS proxy preserves `Host` and sets `X-Forwarded-Proto: https`.
- [ ] Firewall allows 80/443 only; port 3000 is not publicly reachable.
- [ ] `/healthz` and `/readyz` behave as expected.
- [ ] Daily backup timer is enabled and a manual run succeeds.
- [ ] Backup archive has restrictive permissions and an off-site copy exists.
- [ ] A restore-to-new-directory drill has been completed.
- [ ] Federation peers were verified out-of-band and re-registered after rotation.
- [ ] Setup token was removed or rotated after installation.
