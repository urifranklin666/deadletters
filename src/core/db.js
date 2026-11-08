const fs = require('node:fs');
const Database = require('better-sqlite3');
const config = require('../config');
const schema = require('./schema');

const { runMigrations } = require('./migrations');

let db = null;

// Database files contain credentials-equivalent local state, including the node
// private key. Restrict the main file and its WAL/SHM sidecars where the
// platform supports POSIX permission bits.
function restrictDatabasePermissions(dbPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(path)) fs.chmodSync(path, 0o600);
    } catch {
      // chmod is unavailable on some platforms/filesystems; opening still works.
    }
  }
}

function getDb() {
  if (!db) {
    // Create a new database file with owner-only permissions before SQLite
    // opens it, then restrict an existing file and sidecars as well.
    try {
      if (!fs.existsSync(config.dbPath)) {
        fs.closeSync(fs.openSync(config.dbPath, 'a', 0o600));
      }
    } catch {
      // Fall through to better-sqlite3, which reports a useful open error.
    }
    restrictDatabasePermissions(config.dbPath);
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.exec(schema);
    runMigrations(db);
    restrictDatabasePermissions(config.dbPath);
  }
  return db;
}

function initDb() {
  return getDb();
}

// WordPress-compatible Options API
function getOption(name, defaultValue = null) {
  const database = getDb();
  const row = database.prepare('SELECT option_value FROM dl_options WHERE option_name = ?').get(name);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.option_value);
  } catch {
    return row.option_value;
  }
}

function updateOption(name, value, autoload = 'yes') {
  const database = getDb();
  const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const exists = database.prepare('SELECT option_id FROM dl_options WHERE option_name = ?').get(name);
  if (exists) {
    database.prepare('UPDATE dl_options SET option_value = ? WHERE option_name = ?').run(stringValue, name);
  } else {
    database.prepare('INSERT INTO dl_options (option_name, option_value, autoload) VALUES (?, ?, ?)').run(name, stringValue, autoload);
  }
  return true;
}

function deleteOption(name) {
  const database = getDb();
  database.prepare('DELETE FROM dl_options WHERE option_name = ?').run(name);
}

// WordPress-compatible Post Meta API
function getPostMeta(postId, key = null) {
  const database = getDb();
  if (key) {
    const row = database.prepare('SELECT meta_value FROM dl_postmeta WHERE post_id = ? AND meta_key = ?').get(postId, key);
    if (!row) return null;
    try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
  } else {
    const rows = database.prepare('SELECT meta_key, meta_value FROM dl_postmeta WHERE post_id = ?').all(postId);
    const meta = {};
    rows.forEach(r => {
      try { meta[r.meta_key] = JSON.parse(r.meta_value); } catch { meta[r.meta_key] = r.meta_value; }
    });
    return meta;
  }
}

function updatePostMeta(postId, key, value) {
  const database = getDb();
  const stringVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const exists = database.prepare('SELECT meta_id FROM dl_postmeta WHERE post_id = ? AND meta_key = ?').get(postId, key);
  if (exists) {
    database.prepare('UPDATE dl_postmeta SET meta_value = ? WHERE meta_id = ?').run(stringVal, exists.meta_id);
  } else {
    database.prepare('INSERT INTO dl_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)').run(postId, key, stringVal);
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  initDb,
  closeDb,
  getOption,
  updateOption,
  deleteOption,
  getPostMeta,
  updatePostMeta
};
