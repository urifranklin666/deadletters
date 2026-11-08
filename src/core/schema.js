const schema = `
-- Deadletters Core Database Schema
-- Compatible with WordPress data models + Deadplug Resharing Mesh Engine

CREATE TABLE IF NOT EXISTS dl_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name TEXT UNIQUE NOT NULL,
  option_value TEXT,
  autoload TEXT DEFAULT 'yes'
);

CREATE TABLE IF NOT EXISTS dl_users (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login TEXT UNIQUE NOT NULL,
  user_pass TEXT NOT NULL,
  user_nicename TEXT,
  user_email TEXT UNIQUE NOT NULL,
  user_url TEXT,
  user_registered DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_status INTEGER DEFAULT 0,
  display_name TEXT,
  role TEXT DEFAULT 'operator',
  token_version INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  bio TEXT
);

CREATE TABLE IF NOT EXISTS dl_usermeta (
  umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (user_id) REFERENCES dl_users(ID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_posts (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  post_author INTEGER NOT NULL,
  post_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  post_date_gmt DATETIME DEFAULT CURRENT_TIMESTAMP,
  post_content TEXT,
  post_title TEXT,
  post_excerpt TEXT,
  post_status TEXT DEFAULT 'publish',
  comment_status TEXT DEFAULT 'open',
  post_name TEXT UNIQUE,
  post_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
  post_type TEXT DEFAULT 'post',
  post_mime_type TEXT,
  comment_count INTEGER DEFAULT 0,
  featured_image TEXT,
  reading_time INTEGER DEFAULT 3,
  drop_code TEXT,
  content_format TEXT DEFAULT 'standard',
  reshare_count INTEGER DEFAULT 0,
  is_sticky INTEGER DEFAULT 0,
  post_password TEXT DEFAULT NULL,
  menu_order INTEGER DEFAULT 0,
  post_parent INTEGER DEFAULT 0,
  FOREIGN KEY (post_author) REFERENCES dl_users(ID)
);

CREATE TABLE IF NOT EXISTS dl_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  post_title TEXT,
  post_content TEXT,
  post_excerpt TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES dl_posts(ID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_postmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (post_id) REFERENCES dl_posts(ID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_terms (
  term_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  term_group INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dl_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  taxonomy TEXT NOT NULL,
  description TEXT,
  parent INTEGER DEFAULT 0,
  count INTEGER DEFAULT 0,
  FOREIGN KEY (term_id) REFERENCES dl_terms(term_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_term_relationships (
  object_id INTEGER NOT NULL,
  term_taxonomy_id INTEGER NOT NULL,
  term_order INTEGER DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id),
  FOREIGN KEY (object_id) REFERENCES dl_posts(ID) ON DELETE CASCADE,
  FOREIGN KEY (term_taxonomy_id) REFERENCES dl_term_taxonomy(term_taxonomy_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_comments (
  comment_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_post_ID INTEGER NOT NULL,
  comment_author TEXT,
  comment_author_email TEXT,
  comment_author_url TEXT,
  comment_author_IP TEXT,
  comment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  comment_content TEXT,
  comment_approved TEXT DEFAULT '1',
  comment_parent INTEGER DEFAULT 0,
  user_id INTEGER DEFAULT 0,
  FOREIGN KEY (comment_post_ID) REFERENCES dl_posts(ID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_reshares (
  reshare_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  source_post_id INTEGER,
  source_url TEXT,
  source_node TEXT,
  original_author TEXT,
  original_title TEXT,
  original_excerpt TEXT,
  curator_commentary TEXT,
  provenance_chain TEXT,
  signature TEXT,
  reshare_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  envelope_json TEXT,
  envelope_hash TEXT,
  envelope_signature TEXT,
  signature_algorithm TEXT,
  signing_key_id TEXT,
  parent_envelope_hash TEXT,
  signed_at TEXT,
  FOREIGN KEY (post_id) REFERENCES dl_posts(ID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dl_node_identity (
  identity_id INTEGER PRIMARY KEY CHECK (identity_id = 1),
  node_handle TEXT NOT NULL,
  public_key_der TEXT NOT NULL,
  private_key_der TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL DEFAULT 'Ed25519',
  created_at TEXT NOT NULL
);

-- Retired node keys are public history only. Retired private keys are never
-- retained: historical envelopes remain locally verifiable, but old signing
-- material must not be recoverable from this table.
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

-- Delivery-only federation MVP. Peers are explicitly trusted by a superadmin;
-- public keys are never fetched automatically from remote endpoints.
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

CREATE TABLE IF NOT EXISTS dl_addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  is_active INTEGER DEFAULT 0,
  settings TEXT,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dl_theme_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_slug TEXT UNIQUE NOT NULL,
  tokens_json TEXT,
  custom_css TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dl_nav_menus (
  menu_id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_location TEXT UNIQUE NOT NULL,
  items_json TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_type_status ON dl_posts(post_type, post_status);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON dl_posts(post_name);
CREATE INDEX IF NOT EXISTS idx_postmeta_post ON dl_postmeta(post_id);
CREATE INDEX IF NOT EXISTS idx_reshares_post ON dl_reshares(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON dl_comments(comment_post_ID);
CREATE INDEX IF NOT EXISTS idx_revisions_post ON dl_revisions(post_id);
CREATE INDEX IF NOT EXISTS idx_node_key_history_retired_at ON dl_node_key_history(retired_at);
`;

module.exports = schema;
