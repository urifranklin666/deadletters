# Backup and restore

Deadletters snapshots use SQLite's online backup API and package the database
with site assets. `scripts/backup.sh` wraps the same `snapshot-zip` command,
adds owner-only output, optional age encryption, and retention pruning. The HTTP
server does not need to be running.

Read the sensitivity section before creating your first backup. A snapshot is a
credential-bearing archive, not a public export.

## What a snapshot includes and excludes

Included:

```text
data/deadletters.db    transactionally consistent SQLite database
data/config.json       when present; contains saved secrets and deployment settings
uploads/               uploaded media
themes/                installed themes
addons/                installed addons
```

Excluded from asset directories:

- old `.zip` archives and other snapshot files
- temporary files/directories (`.tmp`, `.temp`, `temp_uploads`, `tmp`, `temp`)
- SQLite sidecars (`.db-wal`, `.db-shm`, `-wal`, `-shm` files)
- `.git`, `node_modules`, symlinks, and special files
- the engine source and `node_modules` (snapshots restore site data, not the app)

The database is transactionally consistent. Asset files are read individually, so
a snapshot is not an atomic filesystem-wide freeze while uploads, themes, or
addons are being edited. Avoid changing themes/addons during scheduled backups
if exact cross-directory consistency matters.

Snapshots do **not** include the engine version, OS packages, reverse-proxy
configuration, environment file, age identity, or off-site copies. Those must be
managed separately.

## Sensitivity

`data/deadletters.db` contains the node's Ed25519 **private key**. Anyone with a
snapshot can sign re-letters as this node. `data/config.json`, when present,
contains the saved JWT secret and legacy provenance secret. A disclosed archive
can therefore be used to forge sessions and provenance.

- Keep `DEADLETTERS_BACKUP_DIR` owner-only (`0700`); the script sets `umask 077`
  and restricts directories/archives it creates.
- Prefer age encryption for any archive that leaves the host.
- Keep the age private identity offline, separate from the backups, and backed up
  independently.
- Never paste archive contents or environment values into logs, tickets, or chat.
- A snapshot made before a node-key rotation still contains the old private key.
  Rotating the live key does not make that archive safe.
- Deleting an archive is not a secure erase guarantee on every filesystem.

## Prerequisites

- Node.js 22.12+ (Node.js 24 LTS recommended) with the engine dependencies
  installed under the engine directory.
- SQLite database already initialized. The script refuses to run if the resolved
  database file is missing, so a misconfigured path cannot silently create an
  empty backup.
- `age` and `age-keygen` if encryption is enabled.
- Enough free space for one plaintext archive plus one encrypted archive before
  retention runs.

Run as the same account that owns the runtime state (normally `deadletters`):

```bash
sudo systemctl start deadletters-backup.service
sudo journalctl -u deadletters-backup.service -n 50 --no-pager
```

Manual invocation:

```bash
sudo -u deadletters \
  env DEADLETTERS_BACKUP_DIR=/var/lib/deadletters/backups \
      DEADLETTERS_DATA_DIR=/var/lib/deadletters/data \
      DEADLETTERS_UPLOADS_DIR=/var/lib/deadletters/uploads \
      DEADLETTERS_THEMES_DIR=/var/lib/deadletters/themes \
      DEADLETTERS_ADDONS_DIR=/var/lib/deadletters/addons \
      DB_PATH=/var/lib/deadletters/data/deadletters.db \
      /opt/deadletters/scripts/backup.sh
```

The script reads the same environment variables as the application, plus:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEADLETTERS_BACKUP_DIR` | `<engine>/backups` | Archive destination. The directory is created with mode `0700`. |
| `DEADLETTERS_BACKUP_AGE_RECIPIENT` | unset | Public age recipient. When set, the plaintext `.zip` is encrypted to `.zip.age`. |
| `DEADLETTERS_BACKUP_RETENTION_DAYS` | unset | Positive integer, `1`–`36500`. Prunes matching local archives older than that many days. |
| `DEADLETTERS_ENGINE_DIR` | script parent | Engine root containing `bin/deadletters.js`. |
| `DEADLETTERS_NODE_BIN` | `node` in `PATH` | Node executable to use. |
| `DEADLETTERS_DATA_DIR`, `DEADLETTERS_UPLOADS_DIR`, `DEADLETTERS_THEMES_DIR`, `DEADLETTERS_ADDONS_DIR`, `DB_PATH` | application defaults | Runtime paths exported to the snapshot process. |

The script validates the resulting archive exists and is nonzero before reporting
success. If any step fails, it removes incomplete output from that run.

## Scheduled backups

`deploy/deadletters-backup.service.example` and
`deploy/deadletters-backup.timer.example` provide a daily oneshot service with a
randomized delay and `Persistent=true` catch-up:

```bash
sudo install -m 0644 deploy/deadletters-backup.service.example \
  /etc/systemd/system/deadletters-backup.service
sudo install -m 0644 deploy/deadletters-backup.timer.example \
  /etc/systemd/system/deadletters-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now deadletters-backup.timer
systemctl list-timers --all deadletters-backup.timer
```

Set `DEADLETTERS_BACKUP_DIR`, `DEADLETTERS_BACKUP_RETENTION_DAYS`, and the
optional age recipient in `/etc/deadletters/deadletters.env`. The service also
sets `/var/lib/deadletters/backups` as a fallback; values in the environment file
take precedence.

The timer runs in the host's local timezone. Change `OnCalendar` in the timer if
the window should be UTC or aligned with another maintenance job.

## Encryption with age

Generate the identity on a trusted machine, not on the public web server:

```bash
age-keygen -o deadletters-backup-identity.txt
age-keygen -y deadletters-backup-identity.txt   # print the public recipient
```

Store `deadletters-backup-identity.txt` offline (password manager, encrypted
hardware, or an air-gapped backup) with restrictive permissions. Put only the
public `age1...` recipient in the server environment file:

```bash
DEADLETTERS_BACKUP_AGE_RECIPIENT=age1REPLACE_WITH_PUBLIC_RECIPIENT
```

When the recipient is set, the script:

1. checks that `age` is available and fails before taking a snapshot if it is not;
2. creates the normal `.zip` with owner-only permissions;
3. encrypts it to `<snapshot>.zip.age`;
4. verifies the encrypted file is nonzero;
5. removes the plaintext `.zip` only after successful encryption;
6. prunes old matching local archives if retention is configured.

The plaintext archive briefly exists in the backup directory before encryption.
The directory is mode `0700` and the file is mode `0600`; do not relax those
modes. If encryption fails, the script exits nonzero and removes the incomplete
run's outputs rather than leaving a plaintext backup behind.

To decrypt during a restore drill:

```bash
age --decrypt --identity /offline/identity.txt \
  --output /tmp/deadletters-restore.zip \
  /var/lib/deadletters/backups/deadletters-site-snapshot-YYYYMMDDTHHMMSSZ.zip.age
```

Keep the old identity until every archive encrypted to it is no longer needed.
Changing the recipient does not re-encrypt old archives.

## Retention

Retention is opt-in. It runs only after a new backup succeeds and only removes
top-level regular files whose names match the exact patterns:

```text
deadletters-site-snapshot-*.zip
deadletters-site-snapshot-*.zip.age
```

The value must be a positive integer (`1`–`36500`). It is validated before the
snapshot starts, so a value containing shell metacharacters, a path, a wildcard,
a sign, or a decimal is rejected. Pruning uses file modification time (`-mtime
+N`): an archive is eligible only after more than `N` 24-hour periods.

Files with a similar prefix (for example `important-deadletters-site-snapshot-…`),
a different suffix, unrelated archives, and archives in subdirectories are not
removed. Symlinks are not followed or removed. The newest backup is not eligible
unless the clock or retention value is pathological.

Retention is local only. Copy archives off-site **before** the local retention
window can delete them. An off-site policy commonly keeps more history than the
server does.

## Off-site copy

A backup on the same host is not disaster recovery. After each successful run,
copy the archive to a different trust domain.

Recommended properties:

- Copy only encrypted `.zip.age` files unless the destination is itself strongly
  protected and access-controlled.
- Use a tool with integrity checks and its own retention, such as `restic`,
  `borg`, `rclone`, or `rsync` over SSH.
- Do not copy the age private identity to the same off-site location as the
  archives. A stolen copy of both defeats encryption.
- Verify the copy (size, checksum, test restore) rather than trusting an exit code
  alone.
- Keep at least one copy that is not deletable by the web host's account or
  credentials.
- Record where the engine version, environment template, and deploy configuration
  are stored; a site-data snapshot alone does not rebuild the host.

Example shape (tool-specific flags omitted intentionally):

```bash
restic backup /var/lib/deadletters/backups
restic check
```

There is no built-in off-site upload in this repository. If you schedule one,
make it a separate unit with its own monitoring and failure handling.

## Restore-to-new-directory drill

Never test a restore by overwriting the live installation. `snapshot-restore`
requires a target that does not exist or is an empty directory.

1. Decrypt the archive if needed (see above).
2. Restore into a new directory owned by the service account:

   ```bash
   sudo install -d -o deadletters -g deadletters -m 0750 \
     /var/lib/deadletters-restore-YYYYMMDD
   sudo -u deadletters /usr/bin/node /opt/deadletters/bin/deadletters.js \
     snapshot-restore /tmp/deadletters-restore.zip \
     /var/lib/deadletters-restore-YYYYMMDD/site
   ```

3. Start a temporary instance on a different port with every runtime path
   explicitly set:

   ```bash
   sudo -u deadletters env NODE_ENV=production HOST=127.0.0.1 PORT=3001 \
     DEADLETTERS_DATA_DIR=/var/lib/deadletters-restore-YYYYMMDD/site/data \
     DEADLETTERS_UPLOADS_DIR=/var/lib/deadletters-restore-YYYYMMDD/site/uploads \
     DEADLETTERS_THEMES_DIR=/var/lib/deadletters-restore-YYYYMMDD/site/themes \
     DEADLETTERS_ADDONS_DIR=/var/lib/deadletters-restore-YYYYMMDD/site/addons \
     DB_PATH=/var/lib/deadletters-restore-YYYYMMDD/site/data/deadletters.db \
     /usr/bin/node /opt/deadletters/bin/deadletters.js start
   ```

4. Check the restored instance:

   ```bash
   curl -fsS http://127.0.0.1:3001/healthz
   curl -fsS http://127.0.0.1:3001/readyz
   ```

   Confirm that the expected site title, posts, users, themes, addons, and media
   are present. A public letter that references a missing upload is a useful
   negative check.

5. Stop the temporary process and remove the drill directory after recording the
   result. Do not point the production unit at a lightly tested restore.

The restore command validates archive entry paths, containment, expected snapshot
layout, and a SQLite `quick_check`, and refuses a non-empty target. It never
restores over a running installation.

## Post-restore path and environment requirements

- The engine directory and dependencies are not in the snapshot. Run the same or
  a compatible engine version from `/opt/deadletters`.
- Set `DEADLETTERS_DATA_DIR`, `DEADLETTERS_UPLOADS_DIR`,
  `DEADLETTERS_THEMES_DIR`, `DEADLETTERS_ADDONS_DIR`, and `DB_PATH` to the
  restored tree. The restore command prints one complete command; use its values.
- `data/config.json` may contain the old host, port, JWT secret, and provenance
  secret. Environment values take precedence for host, port, and secrets, but do
  not assume they repair every setting.
- `site_url` is stored in SQLite, not in the environment file. After restoring to
  a different public name, update it in **Admin → Settings** so canonical URLs,
  feeds, sitemap, and discovery links are correct.
- Restoring to a different host may require a new TLS certificate and proxy
  configuration.
- If the snapshot predates a node-key rotation, the restored database uses the
  old private key. Treat it as sensitive and re-register peers or rotate only
  after understanding the identity change.
- Never run production and drill instances against the same database or uploads
  directory. Use distinct ports and paths, and stop the drill before cleanup.
- Fix ownership and modes after a manual restore: runtime directories owned by
  `deadletters`, data/backups `0700`, uploads/themes/addons `0750`, and secret
  files `0600`.

## RPO and RTO language

These are planning statements, not guarantees:

- **Recovery point objective (RPO)**: with the supplied daily timer at 03:15 local
  time plus up to 30 minutes of randomized delay, the latest local snapshot may be
  roughly up to a day old at any point. The true RPO is the age of the newest
  verified copy at the off-site destination. Take an on-demand backup before
  upgrades, migrations, key rotation, or bulk editorial changes.
- **Recovery time objective (RTO)**: a restore depends on archive size, disk and
  network throughput, decryption, off-site retrieval, manual validation, and
  proxy/DNS changes. A large media library or a slow off-site link can dominate.
  Measure RTO with a real restore drill on the target hardware. This repository
  does not claim an RTO.
- Retention, off-site replication, and monitoring can fail independently. A
  nonzero backup count does not prove that the newest archive is restorable.

## Monitoring

Monitor both the backup run and the recovery path:

- `systemctl list-timers --all deadletters-backup.timer` and
  `systemctl status deadletters-backup.service`.
- `journalctl -u deadletters-backup.service` for nonzero exits, age failures,
  disk-full errors, and pruning results.
- The timestamp, size, and permissions of the newest matching archive. Alert if
  no new archive appears within the expected interval.
- Filesystem free space and inode usage in `/var/lib/deadletters`.
- Presence of `age` when encryption is enabled. The script fails rather than
  quietly falling back to plaintext.
- Off-site copy job status, object count, and an occasional decrypt/restore test.
- `/healthz` and `/readyz` for the application separately from backup health. A
  successful backup does not mean the site is serving correctly.

Do not build monitoring that prints archive contents, environment values, or
secret file contents. Log only paths, timestamps, exit statuses, sizes, and
non-secret configuration state.
