#!/usr/bin/env bash
# Deadletters site backup wrapper.
#
# Creates the same transactionally consistent snapshot as `snapshot-zip`,
# optionally encrypts it with age, and prunes old backups. The HTTP server does
# not need to be running; SQLite's online backup API is used by the Node command.
#
# This script never prints environment values or archive contents. Snapshot
# archives contain data/config.json secrets and the node private key, so keep
# DEADLETTERS_BACKUP_DIR owner-only and copy encrypted archives off-site.
set -Eeuo pipefail

umask 077

log() {
  printf '[deadletters-backup] %s\n' "$*" >&2
}

fail() {
  printf '[deadletters-backup] ERROR: %s\n' "$*" >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="${DEADLETTERS_ENGINE_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd -P)}"
SNAPSHOT_CLI="${PROJECT_ROOT}/bin/deadletters.js"
NODE_BIN="${DEADLETTERS_NODE_BIN:-node}"
AGE_RECIPIENT="${DEADLETTERS_BACKUP_AGE_RECIPIENT:-}"
RETENTION_DAYS="${DEADLETTERS_BACKUP_RETENTION_DAYS:-}"

if [[ -n "$AGE_RECIPIENT" ]]; then
  command -v age >/dev/null 2>&1 || fail \
    "DEADLETTERS_BACKUP_AGE_RECIPIENT is set but the 'age' executable is not available in PATH."
fi

if [[ -n "$RETENTION_DAYS" ]]; then
  [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail \
    "DEADLETTERS_BACKUP_RETENTION_DAYS must be a positive integer number of days."
  # Bound the arithmetic conversion and reject zero before any find expression.
  if (( ${#RETENTION_DAYS} > 5 )); then
    fail "DEADLETTERS_BACKUP_RETENTION_DAYS is unreasonably large."
  fi
  RETENTION_DAYS=$((10#${RETENTION_DAYS}))
  (( RETENTION_DAYS >= 1 && RETENTION_DAYS <= 36500 )) || fail \
    "DEADLETTERS_BACKUP_RETENTION_DAYS must be between 1 and 36500."
fi

if [[ "$NODE_BIN" == */* ]]; then
  [[ -x "$NODE_BIN" ]] || fail "Node executable is not executable: $NODE_BIN"
else
  command -v "$NODE_BIN" >/dev/null 2>&1 || fail "Node executable not found in PATH: $NODE_BIN"
fi
[[ -r "$SNAPSHOT_CLI" ]] || fail "Deadletters CLI not found: $SNAPSHOT_CLI"

# Resolve a relative backup directory before changing into the engine directory.
BACKUP_DIR="${DEADLETTERS_BACKUP_DIR:-${PROJECT_ROOT}/backups}"
mkdir -p -- "$BACKUP_DIR"
BACKUP_DIR="$(cd -- "$BACKUP_DIR" && pwd -P)"
[[ "$BACKUP_DIR" != "/" ]] || fail "Refusing to use the filesystem root as DEADLETTERS_BACKUP_DIR."
chmod 700 -- "$BACKUP_DIR"

# The CLI resolves its own module paths, so the working directory does not need
# to be the engine root. Relative runtime overrides keep normal Node semantics
# and resolve against the caller's current directory.
DATA_DIR="${DEADLETTERS_DATA_DIR:-${PROJECT_ROOT}/src/content/data}"
UPLOADS_DIR="${DEADLETTERS_UPLOADS_DIR:-${PROJECT_ROOT}/public/uploads}"
THEMES_DIR="${DEADLETTERS_THEMES_DIR:-${PROJECT_ROOT}/src/themes}"
ADDONS_DIR="${DEADLETTERS_ADDONS_DIR:-${PROJECT_ROOT}/src/addons}"
DB_FILE="${DB_PATH:-${DATA_DIR}/deadletters.db}"

# Export the paths used by this wrapper so the snapshot subprocess cannot
# silently fall back to a different default directory.
export DEADLETTERS_DATA_DIR="$DATA_DIR"
export DEADLETTERS_UPLOADS_DIR="$UPLOADS_DIR"
export DEADLETTERS_THEMES_DIR="$THEMES_DIR"
export DEADLETTERS_ADDONS_DIR="$ADDONS_DIR"
export DB_PATH="$DB_FILE"

[[ -f "$DB_FILE" ]] || fail \
  "SQLite database not found at the configured path. Initialize the site or set DB_PATH/DEADLETTERS_DATA_DIR."

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAINTEXT="${BACKUP_DIR}/deadletters-site-snapshot-${TIMESTAMP}.zip"
if [[ -e "$PLAINTEXT" ]]; then
  PLAINTEXT="${BACKUP_DIR}/deadletters-site-snapshot-${TIMESTAMP}-$$.zip"
fi
[[ ! -e "$PLAINTEXT" ]] || fail "Refusing to overwrite an existing snapshot archive."
ENCRYPTED="${PLAINTEXT}.age"
[[ ! -e "$ENCRYPTED" ]] || fail "Refusing to overwrite an existing encrypted archive."

PRODUCED=0
cleanup() {
  local status=$?
  if (( status != 0 && PRODUCED == 0 )); then
    # Remove only incomplete output created by this run.
    if [[ -f "$PLAINTEXT" ]]; then rm -f -- "$PLAINTEXT"; fi
    if [[ -f "$ENCRYPTED" ]]; then rm -f -- "$ENCRYPTED"; fi
  fi
  return 0
}
trap cleanup EXIT

log "Creating consistent snapshot (database, uploads, themes, addons)..."
"$NODE_BIN" "$SNAPSHOT_CLI" snapshot-zip "$PLAINTEXT"

[[ -f "$PLAINTEXT" ]] || fail "Snapshot command did not produce an archive."
[[ -s "$PLAINTEXT" ]] || fail "Snapshot archive is empty."
chmod 600 -- "$PLAINTEXT"

FINAL_ARCHIVE="$PLAINTEXT"
if [[ -n "$AGE_RECIPIENT" ]]; then
  log "Encrypting snapshot with age..."
  # --recipient is passed as a separate argument so a value beginning with '-'
  # cannot be interpreted as an age option.
  if ! age --encrypt --recipient "$AGE_RECIPIENT" --output "$ENCRYPTED" -- "$PLAINTEXT"; then
    fail "age encryption failed; no encrypted backup was produced."
  fi
  [[ -f "$ENCRYPTED" ]] || fail "age did not produce an encrypted archive."
  [[ -s "$ENCRYPTED" ]] || fail "Encrypted archive is empty."
  chmod 600 -- "$ENCRYPTED"
  rm -f -- "$PLAINTEXT"
  FINAL_ARCHIVE="$ENCRYPTED"
fi

PRODUCED=1
log "Backup written: $FINAL_ARCHIVE"

if [[ -n "$RETENTION_DAYS" ]]; then
  log "Pruning matching backups older than ${RETENTION_DAYS} day(s)..."
  # The glob patterns are fixed. Retention is a validated decimal integer, and
  # only regular files directly inside the backup directory are removed, so a
  # similarly prefixed file or a nested/other archive is never touched.
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f \
    \( -name 'deadletters-site-snapshot-*.zip' -o -name 'deadletters-site-snapshot-*.zip.age' \) \
    -mtime +"$RETENTION_DAYS" -print0 |
    while IFS= read -r -d '' old_archive; do
      rm -f -- "$old_archive"
      log "Pruned old backup: $old_archive"
    done
fi

log "Backup complete."
