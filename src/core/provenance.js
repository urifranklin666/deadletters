'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { getDb, getOption } = require('./db');

/**
 * Local Ed25519 provenance for Deadletters re-letters.
 *
 * This module owns the node identity and the versioned signing envelope. It is
 * deliberately local-only: the private key never leaves the SQLite database,
 * and public-key discovery is served by this node. It does not fetch remote
 * keys, verify remote nodes, or attest that an arbitrary external URL really
 * belongs to the claimed author.
 */

const PROTOCOL_SPEC = 'deadletters-reletter-v1';
const PROTOCOL_VERSION = 'deadletters-provenance/1';
const ENVELOPE_TYPE = 'deadletters-reletter';
const SIGNATURE_ALGORITHM = 'Ed25519';
const VERIFICATION_SCOPE = 'deadletters-ed25519-v1';
const LEGACY_VERIFICATION_SCOPE = 'local-integrity';
const PUBLIC_KEY_PATH = '/.well-known/deadletters.json';
const DEFAULT_NODE_HANDLE = '@deadplug/main-node';
const DEFAULT_SITE_URL = 'http://localhost:3000';
const NODE_KEY_HISTORY_TABLE = 'dl_node_key_history';
const MIN_ROTATION_REASON_LENGTH = 8;
const MAX_ROTATION_REASON_LENGTH = 500;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LEGACY_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deterministic JSON: recursively sorts object keys while preserving array
 * order. Non-finite numbers, undefined/functions/symbols/bigints, dates,
 * buffers, class instances, cycles, and other unsupported values are rejected.
 */
function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON does not support non-finite numbers.');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical JSON does not support values of type ${typeof value}.`);
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('Canonical JSON only supports plain objects and arrays.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not support cyclic references.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError('Canonical JSON does not support sparse arrays.');
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Canonical JSON does not support symbol keys.');
    }

    const keys = Object.keys(value).sort();
    const members = keys.map(key => {
      const member = value[key];
      if (member === undefined) {
        throw new TypeError(`Canonical JSON does not support undefined at key "${key}".`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(member, ancestors)}`;
    });
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Base64Url(canonicalBytes) {
  return crypto.createHash('sha256').update(canonicalBytes, 'utf8').digest('base64url');
}

function createEnvelopeHash(envelope) {
  return sha256Base64Url(canonicalJson(envelope));
}

function normalizeSiteUrl(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_SITE_URL));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return DEFAULT_SITE_URL;
    }
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_SITE_URL;
  }
}

function getSiteUrl() {
  return normalizeSiteUrl(getOption('site_url', DEFAULT_SITE_URL));
}

function getPublicKeyUrl() {
  return `${getSiteUrl()}${PUBLIC_KEY_PATH}`;
}

function normalizeNodeHandle(value) {
  const handle = typeof value === 'string' ? value.trim() : '';
  return (handle || DEFAULT_NODE_HANDLE).slice(0, 100);
}

function createKeyId(publicKeyDer) {
  const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  return `ed25519-${fingerprint.slice(0, 16)}`;
}

function generateNodeIdentity(nodeHandle) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');

  return {
    node_handle: normalizeNodeHandle(nodeHandle),
    public_key_der: publicKeyDer,
    private_key_der: privateKeyDer,
    key_id: createKeyId(Buffer.from(publicKeyDer, 'base64url')),
    algorithm: SIGNATURE_ALGORITHM,
    created_at: new Date().toISOString()
  };
}

/**
 * Lazily create the singleton node identity. The private key stays in this
 * row and is never returned by the public helpers below.
 */
function ensureIdentityRow() {
  const db = getDb();
  const existing = db.prepare(`
    SELECT identity_id, node_handle, public_key_der, private_key_der, key_id, algorithm, created_at
    FROM dl_node_identity WHERE identity_id = 1
  `).get();
  if (existing) {
    const currentHandle = normalizeNodeHandle(getOption('site_node_handle', DEFAULT_NODE_HANDLE));
    if (existing.node_handle !== currentHandle) {
      db.prepare('UPDATE dl_node_identity SET node_handle = ? WHERE identity_id = 1')
        .run(currentHandle);
      existing.node_handle = currentHandle;
    }
    return existing;
  }

  const generated = generateNodeIdentity(getOption('site_node_handle', DEFAULT_NODE_HANDLE));
  db.prepare(`
    INSERT OR IGNORE INTO dl_node_identity (
      identity_id, node_handle, public_key_der, private_key_der, key_id, algorithm, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    generated.node_handle,
    generated.public_key_der,
    generated.private_key_der,
    generated.key_id,
    generated.algorithm,
    generated.created_at
  );

  return db.prepare(`
    SELECT identity_id, node_handle, public_key_der, private_key_der, key_id, algorithm, created_at
    FROM dl_node_identity WHERE identity_id = 1
  `).get();
}

function readPublicIdentityRow() {
  return getDb().prepare(`
    SELECT node_handle, public_key_der, key_id, algorithm, created_at
    FROM dl_node_identity WHERE identity_id = 1
  `).get() || null;
}

function toPublicIdentity(row) {
  if (!row) return null;
  return {
    handle: row.node_handle,
    algorithm: row.algorithm,
    key_id: row.key_id,
    public_key: row.public_key_der,
    created_at: row.created_at,
    public_key_url: getPublicKeyUrl()
  };
}

function toPublicHistoryEntry(row) {
  if (!row) return null;
  return {
    node_handle: row.node_handle,
    handle: row.node_handle,
    public_key_der: row.public_key_der,
    public_key: row.public_key_der,
    key_id: row.key_id,
    algorithm: row.algorithm,
    created_at: row.created_at,
    retired_at: row.retired_at,
    reason: row.reason,
    key_status: 'retired',
    retired: true,
    key_retired: true
  };
}

function readHistoryRows() {
  return getDb().prepare(`
    SELECT history_id, node_handle, public_key_der, key_id, algorithm, created_at, retired_at, reason
    FROM dl_node_key_history
    ORDER BY history_id ASC
  `).all();
}

/**
 * Return retired public keys only. No retired private key is stored or exposed.
 */
function listRetiredNodeKeys() {
  return readHistoryRows().map(toPublicHistoryEntry);
}

/**
 * Resolve a key id for local verification. The current key wins; retired public
 * keys remain available so historical envelopes survive a rotation.
 */
function findPublicNodeKey(keyId) {
  if (typeof keyId !== 'string' || keyId.length === 0) return null;

  const current = readPublicIdentityRow();
  if (current && current.key_id === keyId) {
    return {
      ...toPublicIdentity(current),
      public_key_der: current.public_key_der,
      key_status: 'current',
      retired: false,
      key_retired: false,
      key_retired_at: null,
      key_retirement_reason: null
    };
  }

  const row = getDb().prepare(`
    SELECT history_id, node_handle, public_key_der, key_id, algorithm, created_at, retired_at, reason
    FROM dl_node_key_history WHERE key_id = ?
  `).get(keyId);
  if (!row) return null;

  const entry = toPublicHistoryEntry(row);
  return {
    ...entry,
    key_retired_at: entry.retired_at,
    key_retirement_reason: entry.reason
  };
}

function normalizeRotationReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < MIN_ROTATION_REASON_LENGTH) {
    throw new Error(
      `A rotation reason of at least ${MIN_ROTATION_REASON_LENGTH} non-whitespace characters is required.`
    );
  }
  if (reason.length > MAX_ROTATION_REASON_LENGTH) {
    throw new Error(`Rotation reason must be at most ${MAX_ROTATION_REASON_LENGTH} characters.`);
  }
  return reason;
}

function historyHasKeyId(db, keyId) {
  return Boolean(
    db.prepare('SELECT 1 FROM dl_node_key_history WHERE key_id = ?').get(keyId)
  );
}

/**
 * Retire the current public key, replace the singleton Ed25519 identity, and
 * retain only public history for local verification of older envelopes.
 *
 * This is intentionally a one-way local operation: it cannot revoke copies of
 * old private keys in snapshots, restore old envelopes to a peer that still
 * trusts the previous key, or make a disclosed key safe. Peers must re-register
 * the new public key out-of-band.
 */
function rotateNodeIdentity({ reason } = {}) {
  const normalizedReason = normalizeRotationReason(reason);
  const db = getDb();

  const rotate = db.transaction(() => {
    const current = db.prepare(`
      SELECT identity_id, node_handle, public_key_der, private_key_der, key_id, algorithm, created_at
      FROM dl_node_identity WHERE identity_id = 1
    `).get();

    if (!current) {
      throw new Error('No local node identity exists to rotate.');
    }
    if (historyHasKeyId(db, current.key_id)) {
      throw new Error(`Cannot rotate: key id "${current.key_id}" already exists in retired key history.`);
    }

    const handle = normalizeNodeHandle(getOption('site_node_handle', current.node_handle));
    let generated = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateNodeIdentity(handle);
      if (candidate.key_id === current.key_id) continue;
      if (historyHasKeyId(db, candidate.key_id)) continue;
      generated = candidate;
      break;
    }
    if (!generated) {
      throw new Error('Cannot rotate: generated key id duplicates the current or a retired key id.');
    }

    const retiredAt = new Date().toISOString();
    const inserted = db.prepare(`
      INSERT INTO dl_node_key_history (
        node_handle, public_key_der, key_id, algorithm, created_at, retired_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.node_handle,
      current.public_key_der,
      current.key_id,
      current.algorithm,
      current.created_at,
      retiredAt,
      normalizedReason
    );

    const updated = db.prepare(`
      UPDATE dl_node_identity
      SET node_handle = ?, public_key_der = ?, private_key_der = ?, key_id = ?, algorithm = ?, created_at = ?
      WHERE identity_id = 1
    `).run(
      generated.node_handle,
      generated.public_key_der,
      generated.private_key_der,
      generated.key_id,
      generated.algorithm,
      generated.created_at
    );
    if (updated.changes !== 1) {
      throw new Error('Failed to update the singleton node identity.');
    }

    return {
      retired: db.prepare(`
        SELECT history_id, node_handle, public_key_der, key_id, algorithm, created_at, retired_at, reason
        FROM dl_node_key_history WHERE history_id = ?
      `).get(inserted.lastInsertRowid),
      current: db.prepare(`
        SELECT node_handle, public_key_der, key_id, algorithm, created_at
        FROM dl_node_identity WHERE identity_id = 1
      `).get()
    };
  });

  const result = rotate();
  return {
    rotated: true,
    rotated_at: result.retired.retired_at,
    reason: normalizedReason,
    current: {
      ...toPublicIdentity(result.current),
      key_status: 'current',
      retired: false,
      key_retired: false
    },
    retired: toPublicHistoryEntry(result.retired),
    history: listRetiredNodeKeys()
  };
}

/**
 * Return only public identity material. Callers must not persist or forward
 * private key material.
 */
function getPublicNodeIdentity({ create = true } = {}) {
  const row = create ? ensureIdentityRow() : readPublicIdentityRow();
  return toPublicIdentity(row);
}

function getDiscoveryDocument() {
  const identity = getPublicNodeIdentity();
  return {
    spec: PROTOCOL_SPEC,
    protocol: PROTOCOL_VERSION,
    node: identity.handle,
    node_handle: identity.handle,
    site_url: getSiteUrl(),
    public_key: {
      algorithm: identity.algorithm,
      key_id: identity.key_id,
      public_key: identity.public_key,
      created_at: identity.created_at,
      public_key_url: identity.public_key_url
    }
  };
}

function importPrivateKey(base64url) {
  return crypto.createPrivateKey({
    key: Buffer.from(base64url, 'base64url'),
    format: 'der',
    type: 'pkcs8'
  });
}

function importPublicKey(base64url) {
  return crypto.createPublicKey({
    key: Buffer.from(base64url, 'base64url'),
    format: 'der',
    type: 'spki'
  });
}

/**
 * Sign an envelope with the local node identity. `envelope_json` is the exact
 * canonical byte sequence that was signed; the hash is SHA-256 of those bytes.
 */
function signEnvelope(envelope) {
  const identity = ensureIdentityRow();
  const canonicalBytes = canonicalJson(envelope);
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalBytes, 'utf8'),
    importPrivateKey(identity.private_key_der)
  ).toString('base64url');

  return {
    envelope_json: canonicalBytes,
    envelope_hash: sha256Base64Url(canonicalBytes),
    envelope_signature: signature,
    signature_algorithm: SIGNATURE_ALGORITHM,
    signing_key_id: identity.key_id,
    signed_at: envelope.created_at
  };
}

/**
 * Build and sign a complete re-letter envelope. The caller supplies already
 * normalized source/curator/chain data.
 */
function createSignedEnvelope({
  source,
  curator,
  createdAt,
  parentEnvelopeHash = null,
  provenanceChain
}) {
  const identity = ensureIdentityRow();
  const envelope = {
    type: ENVELOPE_TYPE,
    spec: PROTOCOL_SPEC,
    source,
    curator,
    created_at: createdAt,
    signing_node: {
      handle: identity.node_handle,
      key_id: identity.key_id
    },
    parent_envelope_hash: parentEnvelopeHash === undefined ? null : parentEnvelopeHash,
    provenance_chain: provenanceChain
  };

  return {
    envelope,
    ...signEnvelope(envelope)
  };
}

function verifyEnvelopeSignature(envelope, signature, publicKeyDer) {
  if (typeof signature !== 'string' || !BASE64URL_PATTERN.test(signature)) return false;
  try {
    const canonicalBytes = canonicalJson(envelope);
    return crypto.verify(
      null,
      Buffer.from(canonicalBytes, 'utf8'),
      importPublicKey(publicKeyDer),
      Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}

function parseProvenanceChain(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function legacySignaturePayload(record, provenance) {
  return {
    sourceUrl: record.source_url,
    originalAuthor: record.original_author,
    originalTitle: record.original_title,
    provenance
  };
}

function verifyLegacyRecord(record) {
  const provenance = parseProvenanceChain(record.provenance_chain);
  const signature = record.signature;
  const signatureValid = typeof signature === 'string' &&
    LEGACY_SIGNATURE_PATTERN.test(signature) &&
    (() => {
      const expected = crypto.createHmac('sha256', config.provenanceSecret)
        .update(JSON.stringify(legacySignaturePayload(record, provenance)))
        .digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    })();

  if (typeof signature !== 'string' || !signature) {
    return {
      valid: false,
      hash_valid: null,
      signature_valid: false,
      verification_status: 'unverified',
      verification_scope: LEGACY_VERIFICATION_SCOPE,
      key_id: null,
      envelope_hash: null,
      parent_envelope_hash: null,
      public_key_url: null,
      reason: 'Legacy record has no stored HMAC signature.'
    };
  }

  return {
    valid: signatureValid,
    hash_valid: null,
    signature_valid: signatureValid,
    verification_status: signatureValid ? 'verified' : 'invalid',
    verification_scope: LEGACY_VERIFICATION_SCOPE,
    key_id: null,
    envelope_hash: null,
    parent_envelope_hash: null,
    public_key_url: null,
    reason: signatureValid
      ? 'Legacy local HMAC signature matches the stored record.'
      : 'Legacy local HMAC signature does not match the stored record.'
  };
}

function invalidResult(base, reason, extra = {}) {
  return {
    ...base,
    ...extra,
    valid: false,
    verification_status: 'invalid',
    reason
  };
}

function unverifiedResult(base, reason, extra = {}) {
  return {
    ...base,
    ...extra,
    valid: false,
    verification_status: 'unverified',
    reason
  };
}

function verifyEd25519Record(record) {
  let envelope;
  try {
    envelope = JSON.parse(record.envelope_json);
  } catch {
    return invalidResult({
      hash_valid: false,
      signature_valid: false,
      verification_scope: VERIFICATION_SCOPE,
      key_id: record.signing_key_id || null,
      envelope_hash: record.envelope_hash || null,
      parent_envelope_hash: record.parent_envelope_hash || null,
      public_key_url: getPublicKeyUrl()
    }, 'Stored provenance envelope is not valid JSON.');
  }

  if (!isPlainObject(envelope)) {
    return invalidResult({
      hash_valid: false,
      signature_valid: false,
      verification_scope: VERIFICATION_SCOPE,
      key_id: record.signing_key_id || null,
      envelope_hash: record.envelope_hash || null,
      parent_envelope_hash: record.parent_envelope_hash || null,
      public_key_url: getPublicKeyUrl()
    }, 'Stored provenance envelope is not a JSON object.');
  }

  let canonicalBytes;
  try {
    canonicalBytes = canonicalJson(envelope);
  } catch (error) {
    return invalidResult({
      hash_valid: false,
      signature_valid: false,
      verification_scope: VERIFICATION_SCOPE,
      key_id: record.signing_key_id || null,
      envelope_hash: record.envelope_hash || null,
      parent_envelope_hash: record.parent_envelope_hash || null,
      public_key_url: getPublicKeyUrl()
    }, `Stored provenance envelope contains unsupported values: ${error.message}`);
  }

  const computedHash = sha256Base64Url(canonicalBytes);
  const hashValid = typeof record.envelope_hash === 'string' &&
    record.envelope_hash.length === computedHash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(record.envelope_hash));

  const base = {
    hash_valid: hashValid,
    signature_valid: false,
    verification_scope: VERIFICATION_SCOPE,
    key_id: record.signing_key_id || null,
    envelope_hash: computedHash,
    parent_envelope_hash: record.parent_envelope_hash ?? envelope.parent_envelope_hash ?? null,
    public_key_url: getPublicKeyUrl(),
    key_status: 'unknown',
    key_retired: false,
    key_retired_at: null,
    key_retirement_reason: null
  };

  if (record.signature_algorithm !== SIGNATURE_ALGORITHM) {
    return invalidResult(base, 'Stored signature algorithm is missing or not Ed25519.');
  }
  if (!record.signing_key_id) {
    return unverifiedResult(base, 'Signing key id is missing from the stored record.');
  }

  const key = findPublicNodeKey(record.signing_key_id);
  if (!key) {
    return unverifiedResult(base, `Unknown signing key id "${record.signing_key_id}".`);
  }

  base.key_status = key.key_status;
  base.key_retired = Boolean(key.key_retired);
  base.key_retired_at = key.key_retired_at || null;
  base.key_retirement_reason = key.key_retirement_reason || null;

  const signatureValid = verifyEnvelopeSignature(
    envelope,
    record.envelope_signature,
    key.public_key_der
  );
  base.signature_valid = signatureValid;

  const mismatches = [];
  if (envelope.type !== ENVELOPE_TYPE) mismatches.push('type');
  if (envelope.spec !== PROTOCOL_SPEC) mismatches.push('spec');

  const source = envelope.source;
  if (!isPlainObject(source)) {
    mismatches.push('source');
  } else {
    if (record.source_url !== source.url) mismatches.push('source URL');
    if (record.source_node !== source.node) mismatches.push('source node');
    if (record.original_author !== source.author) mismatches.push('source author');
    if (record.original_title !== source.title) mismatches.push('source title');
    if (record.original_excerpt !== source.excerpt) mismatches.push('source excerpt');
  }

  const curator = envelope.curator;
  if (!isPlainObject(curator)) {
    mismatches.push('curator');
  } else if (record.curator_commentary !== curator.commentary) {
    mismatches.push('curator commentary');
  }

  const signingNode = envelope.signing_node;
  if (!isPlainObject(signingNode)) {
    mismatches.push('signing node');
  } else if (signingNode.key_id !== record.signing_key_id) {
    mismatches.push('signing key id');
  }

  if ((record.parent_envelope_hash ?? null) !== (envelope.parent_envelope_hash ?? null)) {
    mismatches.push('parent envelope hash');
  }
  if ((record.signed_at ?? null) !== (envelope.created_at ?? null)) {
    mismatches.push('signed timestamp');
  }

  const storedChain = parseProvenanceChain(record.provenance_chain);
  let chainMatches = false;
  try {
    chainMatches = canonicalJson(storedChain) === canonicalJson(envelope.provenance_chain);
  } catch {
    chainMatches = false;
  }
  if (!chainMatches) mismatches.push('provenance chain');

  if (!hashValid) {
    return invalidResult(base, 'Canonical envelope hash does not match the stored hash.');
  }
  if (!signatureValid) {
    return invalidResult(base, 'Ed25519 signature is invalid for the canonical envelope.');
  }
  if (mismatches.length > 0) {
    return invalidResult(base, `Stored fields do not match the signed envelope: ${mismatches.join(', ')}.`);
  }

  return {
    ...base,
    valid: true,
    verification_status: 'verified',
    reason: base.key_retired
      ? 'Canonical envelope hash and Ed25519 signature match a retained retired local public key.'
      : 'Canonical envelope hash and Ed25519 signature match the current local node record.'
  };
}

/**
 * Verify a dl_reshares row. New rows use the Ed25519 envelope path; rows
 * without an envelope fall back to the legacy installation-local HMAC.
 */
function verifyReshareRecord(record) {
  if (!record || typeof record !== 'object') {
    return {
      valid: false,
      hash_valid: false,
      signature_valid: false,
      verification_status: 'unverified',
      verification_scope: VERIFICATION_SCOPE,
      key_id: null,
      envelope_hash: null,
      parent_envelope_hash: null,
      public_key_url: getPublicKeyUrl(),
      reason: 'No provenance record was supplied.'
    };
  }

  if (typeof record.envelope_json !== 'string' || record.envelope_json.length === 0) {
    return verifyLegacyRecord(record);
  }
  return verifyEd25519Record(record);
}

module.exports = {
  PROTOCOL_SPEC,
  PROTOCOL_VERSION,
  ENVELOPE_TYPE,
  SIGNATURE_ALGORITHM,
  VERIFICATION_SCOPE,
  LEGACY_VERIFICATION_SCOPE,
  PUBLIC_KEY_PATH,
  NODE_KEY_HISTORY_TABLE,
  MIN_ROTATION_REASON_LENGTH,
  MAX_ROTATION_REASON_LENGTH,
  canonicalJson,
  createEnvelopeHash,
  createKeyId,
  createSignedEnvelope,
  findPublicNodeKey,
  getDiscoveryDocument,
  getPublicNodeIdentity,
  getPublicKeyUrl,
  listRetiredNodeKeys,
  rotateNodeIdentity,
  signEnvelope,
  verifyEnvelopeSignature,
  verifyReshareRecord
};
