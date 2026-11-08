const migrations = [
  {
    version: 1,
    name: 'user-token-versions',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(dl_users)').all().map(column => column.name);
      if (!columns.includes('token_version')) {
        db.exec('ALTER TABLE dl_users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
      }
    }
  },
  {
    version: 2,
    name: 'ed25519-provenance-envelopes',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dl_node_identity (
          identity_id INTEGER PRIMARY KEY CHECK (identity_id = 1),
          node_handle TEXT NOT NULL,
          public_key_der TEXT NOT NULL,
          private_key_der TEXT NOT NULL,
          key_id TEXT NOT NULL UNIQUE,
          algorithm TEXT NOT NULL DEFAULT 'Ed25519',
          created_at TEXT NOT NULL
        )
      `);

      const columns = new Set(
        db.prepare('PRAGMA table_info(dl_reshares)').all().map(column => column.name)
      );
      const additions = [
        ['envelope_json', 'TEXT'],
        ['envelope_hash', 'TEXT'],
        ['envelope_signature', 'TEXT'],
        ['signature_algorithm', 'TEXT'],
        ['signing_key_id', 'TEXT'],
        ['parent_envelope_hash', 'TEXT'],
        ['signed_at', 'TEXT']
      ];

      for (const [name, type] of additions) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE dl_reshares ADD COLUMN ${name} ${type}`);
        }
      }
    }
  },
  {
    version: 3,
    name: 'delivery-federation-mvp',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dl_federation_peers (
          peer_id INTEGER PRIMARY KEY AUTOINCREMENT,
          endpoint_url TEXT NOT NULL UNIQUE,
          node_handle TEXT NOT NULL,
          public_key_der TEXT NOT NULL,
          key_id TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dl_federation_outbox (
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL UNIQUE,
          peer_id INTEGER NOT NULL,
          envelope_hash TEXT NOT NULL,
          reshare_id INTEGER,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (peer_id, envelope_hash),
          FOREIGN KEY (peer_id) REFERENCES dl_federation_peers(peer_id) ON DELETE CASCADE,
          FOREIGN KEY (reshare_id) REFERENCES dl_reshares(reshare_id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS dl_federation_inbox (
          inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT UNIQUE,
          source_peer_id INTEGER,
          source_node TEXT,
          key_id TEXT,
          envelope_hash TEXT,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
          reason TEXT,
          received_at TEXT NOT NULL,
          FOREIGN KEY (source_peer_id) REFERENCES dl_federation_peers(peer_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_federation_peers_enabled ON dl_federation_peers(enabled);
        CREATE INDEX IF NOT EXISTS idx_federation_outbox_peer ON dl_federation_outbox(peer_id);
        CREATE INDEX IF NOT EXISTS idx_federation_outbox_due ON dl_federation_outbox(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_federation_outbox_envelope ON dl_federation_outbox(envelope_hash);
        CREATE INDEX IF NOT EXISTS idx_federation_inbox_peer ON dl_federation_inbox(source_peer_id);
        CREATE INDEX IF NOT EXISTS idx_federation_inbox_envelope ON dl_federation_inbox(envelope_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_federation_inbox_accepted_envelope
          ON dl_federation_inbox(envelope_hash)
          WHERE status = 'accepted' AND envelope_hash IS NOT NULL;
      `);
    }
  },
  {
    version: 4,
    name: 'node-key-rotation-history',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dl_node_key_history (
          history_id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_handle TEXT NOT NULL,
          public_key_der TEXT NOT NULL,
          key_id TEXT NOT NULL UNIQUE,
          algorithm TEXT NOT NULL DEFAULT 'Ed25519',
          created_at TEXT NOT NULL,
          retired_at TEXT NOT NULL,
          reason TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_node_key_history_retired_at
          ON dl_node_key_history(retired_at);
      `);
    }
  },
  {
    version: 5,
    name: 'remote-exchange-promotion',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dl_federation_remote_posts (
          remote_post_id TEXT PRIMARY KEY,
          inbox_id INTEGER NOT NULL UNIQUE,
          envelope_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'promoted'
            CHECK (status IN ('promoted', 'hidden', 'removed')),
          promoted_by INTEGER,
          promoted_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (inbox_id) REFERENCES dl_federation_inbox(inbox_id) ON DELETE CASCADE,
          FOREIGN KEY (promoted_by) REFERENCES dl_users(ID) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_federation_remote_status_promoted
          ON dl_federation_remote_posts(status, promoted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_federation_remote_promoted_by
          ON dl_federation_remote_posts(promoted_by);
      `);
    }
  }
];

function runMigrations(db) {
  if (!db) throw new Error('A database connection is required for migrations.');

  db.exec(`
    CREATE TABLE IF NOT EXISTS dl_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM dl_schema_migrations').all().map(row => row.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO dl_schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });

    applyMigration();
  }
}

module.exports = { migrations, runMigrations };
