'use strict';

const crypto = require('node:crypto');
const { getDb } = require('./db');
const provenance = require('./provenance');
const hooks = require('./hooks');

/**
 * Delivery-only federation MVP.
 *
 * Peers are explicitly registered by a superadmin with an endpoint URL, node
 * handle, and Ed25519 SPKI public key discovered out-of-band. This module never
 * fetches remote keys and does not claim that a remote envelope proves factual
 * authorship. The inbox is an auditable exchange store: it verifies and retains
 * signed envelopes but deliberately does not fabricate local posts from them.
 */

const DELIVERY_SPEC = 'deadletters-federation-delivery-v1';
const INBOX_PATH = '/api/v1/federation/inbox';
const MAX_DELIVERY_BYTES = 256 * 1024;
const MAX_CHAIN_ENTRIES = 100;
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const WORKER_INTERVAL_MS = 60000;
const BACKOFF_SCHEDULE_MS = Object.freeze([30000, 60000, 120000, 240000, 480000]);
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const HOOK_ADDON = 'core-federation';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const KEY_ID_PATTERN = /^ed25519-[a-f0-9]{16}$/i;

const REMOTE_STATUSES = Object.freeze(['promoted', 'hidden', 'removed']);
const REMOTE_STATUS_SET = new Set(REMOTE_STATUSES);
const DEFAULT_REMOTE_LIMIT = 20;
const MAX_REMOTE_LIMIT = 100;
const MAX_REMOTE_OFFSET = 100000;
const MAX_REMOTE_COMMENTARY = 10000;
const MAX_REMOTE_CHAIN_COMMENTARY = 1000;
const REMOTE_VERIFICATION_SCOPE = 'peer-ed25519-at-receipt';

let postResharedHandler = null;
let activeProcessing = null;
let workerTimer = null;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function truncate(value, maximum) {
  return String(value).slice(0, maximum);
}

function safeErrorMessage(error) {
  const raw = error && typeof error.message === 'string' ? error.message : 'Delivery failed.';
  return truncate(raw.replace(/\s+/g, ' ').trim() || 'Delivery failed.', 300);
}

function resolveNow(now) {
  if (typeof now === 'function') return new Date(now());
  if (now instanceof Date) return new Date(now.getTime());
  if (typeof now === 'number') return new Date(now);
  return new Date();
}

/**
 * Must remain byte-for-byte compatible with provenance.createKeyId(), which is
 * not exported by the provenance module.
 */
function createKeyId(publicKeyDer) {
  const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  return `ed25519-${fingerprint.slice(0, 16)}`;
}

function normalizeEndpointUrl(value) {
  if (typeof value !== 'string') return { error: 'Peer endpoint must be an HTTP(S) base URL.' };
  const raw = value.trim();
  if (!raw || raw.length > 2048) {
    return { error: 'Peer endpoint must be an HTTP(S) base URL.' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'Peer endpoint must be an HTTP(S) base URL without credentials.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { error: 'Peer endpoint must be an HTTP(S) base URL without credentials.' };
  }
  if (parsed.search || parsed.hash) {
    return { error: 'Peer endpoint must not contain a query string or fragment.' };
  }

  const normalized = parsed.href.replace(/\/+$/, '');
  if (!normalized) return { error: 'Peer endpoint must be an HTTP(S) base URL.' };
  return { value: normalized };
}

function normalizeNodeHandle(value) {
  const handle = typeof value === 'string' ? value.trim() : '';
  if (!handle || handle.length > 100 || /[\u0000-\u001f\u007f]/.test(handle)) {
    return { error: 'Peer node handle must contain between 1 and 100 printable characters.' };
  }
  return { value: handle };
}

function parseEd25519PublicKey(value) {
  if (typeof value !== 'string') {
    return { error: 'Peer public key must be a base64url Ed25519 SPKI DER value.' };
  }
  const encoded = value.trim();
  if (!encoded || encoded.length > 1024 || !BASE64URL_PATTERN.test(encoded)) {
    return { error: 'Peer public key must be a base64url Ed25519 SPKI DER value.' };
  }

  let der;
  let key;
  try {
    der = Buffer.from(encoded, 'base64url');
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return { error: 'Peer public key is not valid SPKI DER.' };
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    return { error: 'Peer public key must be Ed25519.' };
  }

  let roundTrip;
  try {
    roundTrip = key.export({ type: 'spki', format: 'der' });
  } catch {
    return { error: 'Peer public key is not valid SPKI DER.' };
  }
  if (!roundTrip.equals(der) || roundTrip.toString('base64url') !== encoded) {
    return { error: 'Peer public key must use canonical base64url encoding.' };
  }

  return {
    value: {
      public_key_der: roundTrip.toString('base64url'),
      key_id: createKeyId(roundTrip)
    }
  };
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function firstDefined(body, names) {
  for (const name of names) {
    if (Object.hasOwn(body, name) && body[name] !== undefined) return body[name];
  }
  return undefined;
}

function validatePeerInput(input) {
  const body = isPlainObject(input) ? input : {};

  const endpoint = normalizeEndpointUrl(
    firstDefined(body, ['endpoint_url', 'endpointUrl', 'endpoint'])
  );
  if (endpoint.error) return { error: endpoint.error };

  const handle = normalizeNodeHandle(
    firstDefined(body, ['node_handle', 'nodeHandle', 'handle'])
  );
  if (handle.error) return { error: handle.error };

  const publicKey = parseEd25519PublicKey(
    firstDefined(body, ['public_key', 'publicKey', 'public_key_der', 'publicKeyDer'])
  );
  if (publicKey.error) return { error: publicKey.error };

  const suppliedKeyId = firstDefined(body, ['key_id', 'keyId']);
  if (suppliedKeyId !== undefined) {
    if (typeof suppliedKeyId !== 'string' || !KEY_ID_PATTERN.test(suppliedKeyId)) {
      return { error: 'Peer key_id is malformed.' };
    }
    if (suppliedKeyId.toLowerCase() !== publicKey.value.key_id) {
      return { error: 'Peer key_id does not match the supplied Ed25519 public key.' };
    }
  }

  const enabled = normalizeBoolean(firstDefined(body, ['enabled']), true);
  if (enabled === null) return { error: 'Peer enabled flag must be a boolean.' };

  return {
    value: {
      endpoint_url: endpoint.value,
      node_handle: handle.value,
      public_key_der: publicKey.value.public_key_der,
      key_id: publicKey.value.key_id,
      enabled
    }
  };
}

function publicPeer(row) {
  if (!row) return null;
  return {
    peer_id: row.peer_id,
    endpoint_url: row.endpoint_url,
    node_handle: row.node_handle,
    key_id: row.key_id,
    public_key: row.public_key_der,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getPeerRow(peerId) {
  return getDb().prepare('SELECT * FROM dl_federation_peers WHERE peer_id = ?').get(peerId) || null;
}

function listPeers({ enabledOnly = false } = {}) {
  const query = enabledOnly
    ? 'SELECT * FROM dl_federation_peers WHERE enabled = 1 ORDER BY peer_id ASC'
    : 'SELECT * FROM dl_federation_peers ORDER BY peer_id ASC';
  return getDb().prepare(query).all().map(publicPeer);
}

function registerPeer(input) {
  const validation = validatePeerInput(input);
  if (validation.error) throw httpError(400, validation.error);

  const peer = validation.value;
  const now = new Date().toISOString();
  const db = getDb();

  let result;
  try {
    result = db.prepare(`
      INSERT INTO dl_federation_peers (
        endpoint_url, node_handle, public_key_der, key_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      peer.endpoint_url,
      peer.node_handle,
      peer.public_key_der,
      peer.key_id,
      peer.enabled ? 1 : 0,
      now,
      now
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) {
      throw httpError(409, 'A peer with this endpoint URL or key id is already registered.');
    }
    throw error;
  }

  return publicPeer(getPeerRow(Number(result.lastInsertRowid)));
}

function setPeerEnabled(peerId, enabled) {
  const peer = getPeerRow(peerId);
  if (!peer) throw httpError(404, 'Federation peer not found.');

  getDb().prepare('UPDATE dl_federation_peers SET enabled = ?, updated_at = ? WHERE peer_id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), peerId);
  return publicPeer(getPeerRow(peerId));
}

function deletePeer(peerId) {
  const result = getDb().prepare('DELETE FROM dl_federation_peers WHERE peer_id = ?').run(peerId);
  if (result.changes === 0) throw httpError(404, 'Federation peer not found.');
  return { deleted: true, peer_id: peerId };
}

function findLocalReshare({ reshareId = null, postId = null }) {
  const db = getDb();
  if (reshareId !== null && reshareId !== undefined) {
    return db.prepare('SELECT * FROM dl_reshares WHERE reshare_id = ?').get(reshareId) || null;
  }
  if (postId !== null && postId !== undefined) {
    return db.prepare('SELECT * FROM dl_reshares WHERE post_id = ?').get(postId) || null;
  }
  return null;
}

function parseStoredEnvelope(row) {
  if (!row || typeof row.envelope_json !== 'string' || row.envelope_json.length === 0) {
    throw httpError(422, 'Local reshare has no signed Ed25519 envelope to enqueue.');
  }

  let envelope;
  try {
    envelope = JSON.parse(row.envelope_json);
  } catch {
    throw httpError(422, 'Local reshare envelope is not valid JSON.');
  }
  if (!isPlainObject(envelope)) {
    throw httpError(422, 'Local reshare envelope is not a JSON object.');
  }

  const shapeError = validateEnvelopeShape(envelope);
  if (shapeError) {
    throw httpError(422, `Local reshare envelope is not federatable: ${shapeError}`);
  }

  let envelopeHash;
  try {
    envelopeHash = provenance.createEnvelopeHash(envelope);
  } catch {
    throw httpError(422, 'Local reshare envelope cannot be canonicalized.');
  }
  if (row.envelope_hash !== envelopeHash) {
    throw httpError(422, 'Local reshare envelope hash does not match the stored envelope.');
  }
  if (row.signature_algorithm !== provenance.SIGNATURE_ALGORITHM) {
    throw httpError(422, 'Local reshare envelope is not Ed25519-signed.');
  }

  const identity = provenance.getPublicNodeIdentity();
  if (!identity || row.signing_key_id !== identity.key_id ||
    envelope.signing_node.key_id !== identity.key_id) {
    throw httpError(422, 'Local reshare was not signed by this node identity.');
  }
  if (!provenance.verifyEnvelopeSignature(envelope, row.envelope_signature, identity.public_key)) {
    throw httpError(422, 'Local reshare envelope signature is invalid.');
  }

  return { envelope, envelope_hash: envelopeHash };
}

function deliveryIdFor(peerId, envelopeHash) {
  const digest = crypto.createHash('sha256')
    .update(`${peerId}:${envelopeHash}`, 'utf8')
    .digest('hex');
  return `dlv_${digest.slice(0, 32)}`;
}

function buildDeliveryPayload(peer, signed, sentAt) {
  const payload = {
    spec: DELIVERY_SPEC,
    delivery_id: deliveryIdFor(peer.peer_id, signed.envelope_hash),
    sent_at: sentAt,
    envelope: signed.envelope,
    envelope_hash: signed.envelope_hash,
    signature: signed.signature,
    signature_algorithm: provenance.SIGNATURE_ALGORITHM,
    key_id: signed.envelope.signing_node && signed.envelope.signing_node.key_id
  };

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DELIVERY_BYTES) {
    throw httpError(422, 'Signed envelope exceeds the federation delivery size limit.');
  }
  return { payload, payload_json: serialized };
}

function signedEnvelopeFromRow(row) {
  const parsed = parseStoredEnvelope(row);
  return {
    envelope: parsed.envelope,
    envelope_hash: parsed.envelope_hash,
    signature: row.envelope_signature
  };
}

/**
 * Enqueue every enabled peer with one deterministic delivery id per
 * peer + envelope hash. Re-running this is intentionally idempotent.
 */
function enqueueReshareForAllPeers({ reshareId = null, postId = null } = {}) {
  const db = getDb();
  const row = findLocalReshare({ reshareId, postId });
  if (!row) throw httpError(404, 'Local reshare not found.');

  const signed = signedEnvelopeFromRow(row);
  const peers = db.prepare('SELECT * FROM dl_federation_peers WHERE enabled = 1 ORDER BY peer_id ASC').all();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO dl_federation_outbox (
      delivery_id, peer_id, envelope_hash, reshare_id, payload_json,
      status, attempts, next_attempt_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
  `);

  let enqueued = 0;
  let existing = 0;

  const enqueue = db.transaction(() => {
    for (const peer of peers) {
      const delivery = buildDeliveryPayload(peer, signed, now);
      const result = insert.run(
        delivery.payload.delivery_id,
        peer.peer_id,
        signed.envelope_hash,
        row.reshare_id,
        delivery.payload_json,
        now,
        now,
        now
      );
      if (result.changes === 1) enqueued += 1;
      else existing += 1;
    }
  });
  enqueue();

  return {
    reshare_id: row.reshare_id,
    post_id: row.post_id,
    envelope_hash: signed.envelope_hash,
    peer_count: peers.length,
    enqueued,
    existing
  };
}

/**
 * Register the core post_reshared listener once. Re-registration is a no-op so
 * addon reloads or duplicate route requires cannot multiply deliveries.
 */
function registerPostResharedHook() {
  if (postResharedHandler) return false;
  postResharedHandler = reshare => {
    try {
      enqueueReshareForAllPeers({ postId: reshare && reshare.id });
    } catch (error) {
      console.error('[Federation] Unable to enqueue re-letter:', safeErrorMessage(error));
    }
  };
  hooks.addAction('post_reshared', postResharedHandler, 20, HOOK_ADDON);
  return true;
}

function unregisterPostResharedHook() {
  if (!postResharedHandler) return false;
  hooks.removeAction('post_reshared', postResharedHandler);
  postResharedHandler = null;
  return true;
}

function backoffForAttempt(attempts) {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_SCHEDULE_MS.length - 1);
  return Math.min(BACKOFF_SCHEDULE_MS[index], MAX_BACKOFF_MS);
}

async function readResponseBodyCapped(response, limit = MAX_RESPONSE_BYTES) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : '';
    return truncate(text, limit);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The response is being discarded; a cancel failure is not actionable.
        }
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some fetch implementations do not expose releaseLock.
    }
  }

  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

async function postDelivery(peer, payloadJson, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available.');

  const controller = new AbortController();
  const timeout = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetchImpl(`${peer.endpoint_url}${INBOX_PATH}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: payloadJson,
      signal: controller.signal
    });

    await readResponseBodyCapped(response);
    if (!response.ok) {
      throw new Error(`Remote inbox responded with HTTP ${response.status}.`);
    }
    return { status: response.status };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Delivery timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverOutboxRow(row, options, nowDate) {
  const update = getDb().prepare(`
    UPDATE dl_federation_outbox
    SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE outbox_id = ?
  `);

  const nextAttempts = Number(row.attempts) + 1;
  const nowIso = nowDate.toISOString();

  try {
    const peer = { peer_id: row.peer_id, endpoint_url: row.endpoint_url };
    await postDelivery(peer, row.payload_json, options);
    update.run('delivered', nextAttempts, nowIso, null, nowIso, row.outbox_id);
    return { status: 'delivered', attempts: nextAttempts };
  } catch (error) {
    const maxAttempts = options.maxAttempts;
    const dead = nextAttempts >= maxAttempts;
    const status = dead ? 'dead' : 'failed';
    const nextAttemptAt = dead
      ? nowIso
      : new Date(nowDate.getTime() + backoffForAttempt(nextAttempts)).toISOString();
    update.run(status, nextAttempts, nextAttemptAt, safeErrorMessage(error), nowIso, row.outbox_id);
    return { status, attempts: nextAttempts, error: safeErrorMessage(error) };
  }
}

async function runOutbox(options) {
  const db = getDb();
  const nowDate = resolveNow(options.now);
  const nowIso = nowDate.toISOString();
  const force = options.force === true;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : MAX_ATTEMPTS;
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, 200)
    : 50;

  const baseQuery = `
    SELECT o.*, p.endpoint_url, p.node_handle, p.enabled AS peer_enabled
    FROM dl_federation_outbox o
    JOIN dl_federation_peers p ON p.peer_id = o.peer_id
    WHERE p.enabled = 1 AND o.status IN ('pending', 'failed')
  `;

  const rows = force
    ? db.prepare(`${baseQuery} ORDER BY o.next_attempt_at ASC, o.outbox_id ASC LIMIT ?`).all(limit)
    : db.prepare(`${baseQuery} AND o.next_attempt_at <= ? ORDER BY o.next_attempt_at ASC, o.outbox_id ASC LIMIT ?`)
      .all(nowIso, limit);

  const result = { processed: 0, delivered: 0, failed: 0, dead: 0 };

  for (const row of rows) {
    const outcome = await deliverOutboxRow(row, { ...options, maxAttempts }, nowDate);
    result.processed += 1;
    if (outcome.status === 'delivered') result.delivered += 1;
    else if (outcome.status === 'dead') result.dead += 1;
    else result.failed += 1;
  }

  return result;
}

/**
 * Process due pending/failed deliveries once. Concurrent callers share the same
 * in-flight run so the worker cannot double-send the same row.
 */
function processOutboxDue(options = {}) {
  if (activeProcessing) return activeProcessing;
  const defaults = {
    fetchImpl: globalThis.fetch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    limit: 50,
    maxAttempts: MAX_ATTEMPTS,
    force: false,
    ...options
  };
  activeProcessing = runOutbox(defaults).finally(() => {
    activeProcessing = null;
  });
  return activeProcessing;
}

function countByStatus(table, column = 'status') {
  const rows = getDb().prepare(`SELECT ${column} AS status, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all();
  const counts = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function getOutboxStatus(now = new Date()) {
  const counts = countByStatus('dl_federation_outbox');
  const nowIso = resolveNow(now).toISOString();
  const due = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM dl_federation_outbox o
    JOIN dl_federation_peers p ON p.peer_id = o.peer_id
    WHERE p.enabled = 1 AND o.status IN ('pending', 'failed') AND o.next_attempt_at <= ?
  `).get(nowIso).count;

  return {
    pending: counts.pending || 0,
    delivered: counts.delivered || 0,
    failed: counts.failed || 0,
    dead: counts.dead || 0,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    due
  };
}

function safePayloadObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listOutbox({ limit = 50, includePayload = false } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = getDb().prepare(`
    SELECT o.*, p.endpoint_url, p.node_handle
    FROM dl_federation_outbox o
    JOIN dl_federation_peers p ON p.peer_id = o.peer_id
    ORDER BY o.outbox_id DESC
    LIMIT ?
  `).all(boundedLimit);

  return rows.map(row => {
    const item = {
      outbox_id: row.outbox_id,
      delivery_id: row.delivery_id,
      peer_id: row.peer_id,
      endpoint_url: row.endpoint_url,
      node_handle: row.node_handle,
      envelope_hash: row.envelope_hash,
      reshare_id: row.reshare_id,
      status: row.status,
      attempts: row.attempts,
      next_attempt_at: row.next_attempt_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
    if (includePayload) item.payload = safePayloadObject(row.payload_json);
    return item;
  });
}

function validateEnvelopeShape(envelope) {
  if (!isPlainObject(envelope)) return 'Envelope must be a JSON object.';
  if (envelope.type !== provenance.ENVELOPE_TYPE) return 'Envelope type is not supported.';
  if (envelope.spec !== provenance.PROTOCOL_SPEC) return 'Envelope spec is not supported.';

  const createdAt = envelope.created_at;
  if (typeof createdAt !== 'string' || !createdAt || Number.isNaN(Date.parse(createdAt))) {
    return 'Envelope created_at must be a valid timestamp.';
  }

  const source = envelope.source;
  if (!isPlainObject(source)) return 'Envelope source must be an object.';
  if (!(source.url === null || typeof source.url === 'string')) return 'Envelope source URL is malformed.';
  if (typeof source.url === 'string' && source.url.length > 2048) return 'Envelope source URL is too long.';
  if (typeof source.node !== 'string' || source.node.length > 500) return 'Envelope source node is malformed.';
  if (typeof source.author !== 'string' || source.author.length > 300) return 'Envelope source author is malformed.';
  if (typeof source.title !== 'string' || source.title.length > 500) return 'Envelope source title is malformed.';
  if (typeof source.excerpt !== 'string' || source.excerpt.length > 2000) return 'Envelope source excerpt is malformed.';
  if (source.local_post_id !== undefined && source.local_post_id !== null &&
    (!Number.isSafeInteger(source.local_post_id) || source.local_post_id < 0)) {
    return 'Envelope source local_post_id is malformed.';
  }

  const curator = envelope.curator;
  if (!isPlainObject(curator)) return 'Envelope curator must be an object.';
  if (!(typeof curator.id === 'number' || typeof curator.id === 'string')) {
    return 'Envelope curator id is malformed.';
  }
  if (typeof curator.commentary !== 'string' || curator.commentary.length > 100000) {
    return 'Envelope curator commentary is malformed.';
  }

  const signingNode = envelope.signing_node;
  if (!isPlainObject(signingNode)) return 'Envelope signing node must be an object.';
  if (typeof signingNode.handle !== 'string' || !signingNode.handle.trim() ||
    signingNode.handle.length > 100) {
    return 'Envelope signing node handle is malformed.';
  }
  if (typeof signingNode.key_id !== 'string' || !KEY_ID_PATTERN.test(signingNode.key_id)) {
    return 'Envelope signing key id is malformed.';
  }

  const parentHash = envelope.parent_envelope_hash;
  if (parentHash !== null && parentHash !== undefined) {
    if (typeof parentHash !== 'string' || !BASE64URL_PATTERN.test(parentHash) || parentHash.length > 200) {
      return 'Envelope parent hash is malformed.';
    }
  }

  const chain = envelope.provenance_chain;
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > MAX_CHAIN_ENTRIES) {
    return `Envelope provenance chain must contain 1-${MAX_CHAIN_ENTRIES} entries.`;
  }
  for (const entry of chain) {
    if (!isPlainObject(entry) || typeof entry.action !== 'string' || entry.action.length > 100) {
      return 'Envelope provenance chain entry is malformed.';
    }
  }

  return null;
}

function validateDeliveryShape(body) {
  if (!isPlainObject(body)) return { error: 'Federation delivery must be a JSON object.' };
  if (body.spec !== DELIVERY_SPEC) return { error: 'Unsupported federation delivery spec.' };

  if (typeof body.delivery_id !== 'string' || !DELIVERY_ID_PATTERN.test(body.delivery_id)) {
    return { error: 'Federation delivery id is malformed.' };
  }
  if (typeof body.sent_at !== 'string' || !body.sent_at || Number.isNaN(Date.parse(body.sent_at))) {
    return { error: 'Federation sent_at must be a valid timestamp.' };
  }

  const envelopeError = validateEnvelopeShape(body.envelope);
  if (envelopeError) return { error: envelopeError };
  const envelope = body.envelope;

  const signatureAlgorithm = body.signature_algorithm === undefined
    ? provenance.SIGNATURE_ALGORITHM
    : body.signature_algorithm;
  if (signatureAlgorithm !== provenance.SIGNATURE_ALGORITHM) {
    return { error: 'Federation delivery signature algorithm must be Ed25519.' };
  }
  const signature = body.signature === undefined ? body.envelope_signature : body.signature;
  if (typeof signature !== 'string' || !BASE64URL_PATTERN.test(signature) ||
    signature.length > 1024) {
    return { error: 'Federation delivery signature is malformed.' };
  }

  const keyId = envelope.signing_node.key_id;
  if (body.key_id !== undefined && body.key_id !== keyId) {
    return { error: 'Federation delivery key_id does not match the signed envelope.' };
  }

  let computedHash;
  try {
    computedHash = provenance.createEnvelopeHash(envelope);
  } catch {
    return { error: 'Envelope cannot be canonicalized.' };
  }

  if (body.envelope_hash !== undefined && body.envelope_hash !== computedHash) {
    return { error: 'Payload claims an envelope hash that does not match the signed envelope.' };
  }
  if (Object.hasOwn(envelope, 'envelope_hash') && envelope.envelope_hash !== computedHash) {
    return { error: 'Envelope claims a different envelope hash.' };
  }

  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { error: 'Federation delivery cannot be serialized.' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DELIVERY_BYTES) {
    return { error: 'Federation delivery exceeds the size limit.' };
  }

  return {
    value: {
      deliveryId: body.delivery_id,
      envelope,
      envelopeHash: computedHash,
      sourceNode: envelope.signing_node.handle,
      keyId,
      signature: body.signature,
      serialized
    }
  };
}

function isParentKnownLocally(parentHash) {
  if (!parentHash) return false;
  const db = getDb();
  const reshare = db.prepare('SELECT 1 FROM dl_reshares WHERE envelope_hash = ? LIMIT 1').get(parentHash);
  if (reshare) return true;
  const inbox = db.prepare(
    "SELECT 1 FROM dl_federation_inbox WHERE status = 'accepted' AND envelope_hash = ? LIMIT 1"
  ).get(parentHash);
  return Boolean(inbox);
}

function storeRejected({ deliveryId = null, sourceNode = null, keyId = null, envelopeHash = null, payload, reason }) {
  try {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    getDb().prepare(`
      INSERT OR IGNORE INTO dl_federation_inbox (
        delivery_id, source_peer_id, source_node, key_id, envelope_hash,
        payload_json, status, reason, received_at
      ) VALUES (?, NULL, ?, ?, ?, ?, 'rejected', ?, ?)
    `).run(
      deliveryId,
      sourceNode ? truncate(sourceNode, 100) : null,
      keyId ? truncate(keyId, 100) : null,
      envelopeHash ? truncate(envelopeHash, 200) : null,
      truncate(serialized || 'null', MAX_DELIVERY_BYTES),
      truncate(reason, 500),
      new Date().toISOString()
    );
    if (deliveryId) {
      const stored = getDb().prepare(
        'SELECT inbox_id, status FROM dl_federation_inbox WHERE delivery_id = ?'
      ).get(deliveryId);
      return stored && stored.status === 'rejected' ? stored : null;
    }
  } catch (error) {
    console.error('[Federation] Unable to persist rejected inbox audit row:', safeErrorMessage(error));
  }
  return null;
}

function rejectedResult(status, reason, context = {}) {
  const audit = storeRejected({ ...context, reason });
  return {
    httpStatus: status,
    body: {
      status: 'rejected',
      error: reason,
      delivery_id: context.deliveryId || null,
      inbox_id: audit ? audit.inbox_id : null
    }
  };
}

function duplicateResult(existing, submittedDeliveryId, duplicateBy) {
  return {
    httpStatus: 200,
    body: {
      status: 'duplicate',
      duplicate_by: duplicateBy,
      inbox_id: existing.inbox_id,
      delivery_id: existing.delivery_id,
      submitted_delivery_id: submittedDeliveryId,
      envelope_hash: existing.envelope_hash,
      received_at: existing.received_at,
      local_post_created: false,
      storage: 'federation-inbox-audit'
    }
  };
}

function acceptedResult({ inboxId, delivery, receivedAt, promoted = false }) {
  const parentHash = delivery.envelope.parent_envelope_hash ?? null;
  return {
    httpStatus: 202,
    body: {
      status: 'accepted',
      inbox_id: inboxId,
      delivery_id: delivery.deliveryId,
      envelope_hash: delivery.envelopeHash,
      parent_envelope_hash: parentHash,
      parent_envelope_known_locally: isParentKnownLocally(parentHash),
      parent_verification_scope: 'local-presence-only',
      source_node: delivery.sourceNode,
      key_id: delivery.keyId,
      provenance_chain: delivery.envelope.provenance_chain,
      received_at: receivedAt,
      verification_scope: provenance.VERIFICATION_SCOPE,
      promoted_from_rejected: promoted,
      local_post_created: false,
      storage: 'federation-inbox-audit',
      note: 'Signed envelope retained for audit only. This MVP does not create a local post from a remote envelope.'
    }
  };
}

/**
 * Validate, verify, and audit one federation delivery. Returns a structured
 * result rather than throwing so the public route never leaks stack traces.
 */
function receiveDelivery(body) {
  const shape = validateDeliveryShape(body);
  if (shape.error) {
    const rawDeliveryId = isPlainObject(body) && typeof body.delivery_id === 'string' &&
      DELIVERY_ID_PATTERN.test(body.delivery_id)
      ? body.delivery_id
      : null;
    return rejectedResult(400, shape.error, {
      deliveryId: rawDeliveryId,
      sourceNode: isPlainObject(body) && isPlainObject(body.envelope) &&
        isPlainObject(body.envelope.signing_node)
        ? body.envelope.signing_node.handle
        : null,
      keyId: isPlainObject(body) && isPlainObject(body.envelope) &&
        isPlainObject(body.envelope.signing_node)
        ? body.envelope.signing_node.key_id
        : null,
      payload: body
    });
  }

  const delivery = shape.value;
  const db = getDb();
  const peer = db.prepare(
    'SELECT * FROM dl_federation_peers WHERE enabled = 1 AND key_id = ?'
  ).get(delivery.keyId);

  if (!peer || peer.node_handle !== delivery.sourceNode) {
    return rejectedResult(403, 'No enabled registered federation peer matches the envelope signing key and handle.', {
      deliveryId: delivery.deliveryId,
      sourceNode: delivery.sourceNode,
      keyId: delivery.keyId,
      envelopeHash: delivery.envelopeHash,
      payload: body
    });
  }

  if (!provenance.verifyEnvelopeSignature(delivery.envelope, delivery.signature, peer.public_key_der)) {
    return rejectedResult(401, 'Ed25519 signature is invalid for the canonical envelope.', {
      deliveryId: delivery.deliveryId,
      sourceNode: delivery.sourceNode,
      keyId: delivery.keyId,
      envelopeHash: delivery.envelopeHash,
      payload: body
    });
  }

  const existingDelivery = db.prepare(
    'SELECT * FROM dl_federation_inbox WHERE delivery_id = ?'
  ).get(delivery.deliveryId);

  if (existingDelivery) {
    if (existingDelivery.status === 'accepted' && existingDelivery.envelope_hash === delivery.envelopeHash) {
      return duplicateResult(existingDelivery, delivery.deliveryId, 'delivery_id');
    }

    // A deterministic sender may reuse the same delivery id after the receiver
    // registers a previously unknown peer or re-enables it. Once the envelope
    // and signature verify, promote that audit row instead of blocking forever.
    // A different envelope hash under the same delivery id is still a conflict.
    if (existingDelivery.envelope_hash === null ||
      existingDelivery.envelope_hash === delivery.envelopeHash) {
      const alreadyAccepted = db.prepare(
        "SELECT * FROM dl_federation_inbox WHERE status = 'accepted' AND envelope_hash = ? LIMIT 1"
      ).get(delivery.envelopeHash);
      if (alreadyAccepted) {
        return duplicateResult(alreadyAccepted, delivery.deliveryId, 'envelope_hash');
      }

      const receivedAt = new Date().toISOString();
      db.prepare(`
        UPDATE dl_federation_inbox
        SET source_peer_id = ?, source_node = ?, key_id = ?, envelope_hash = ?,
            payload_json = ?, status = 'accepted', reason = NULL, received_at = ?
        WHERE inbox_id = ?
      `).run(
        peer.peer_id,
        delivery.sourceNode,
        delivery.keyId,
        delivery.envelopeHash,
        delivery.serialized,
        receivedAt,
        existingDelivery.inbox_id
      );
      return acceptedResult({
        inboxId: existingDelivery.inbox_id,
        delivery,
        receivedAt,
        promoted: true
      });
    }

    return {
      httpStatus: 409,
      body: {
        status: 'rejected',
        error: 'This delivery id was already recorded for different content.',
        delivery_id: delivery.deliveryId
      }
    };
  }

  const existingEnvelope = db.prepare(
    "SELECT * FROM dl_federation_inbox WHERE status = 'accepted' AND envelope_hash = ? LIMIT 1"
  ).get(delivery.envelopeHash);
  if (existingEnvelope) {
    return duplicateResult(existingEnvelope, delivery.deliveryId, 'envelope_hash');
  }

  const receivedAt = new Date().toISOString();
  let result;
  try {
    result = db.prepare(`
      INSERT INTO dl_federation_inbox (
        delivery_id, source_peer_id, source_node, key_id, envelope_hash,
        payload_json, status, reason, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', NULL, ?)
    `).run(
      delivery.deliveryId,
      peer.peer_id,
      delivery.sourceNode,
      delivery.keyId,
      delivery.envelopeHash,
      delivery.serialized,
      receivedAt
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) {
      const raced = db.prepare(
        "SELECT * FROM dl_federation_inbox WHERE status = 'accepted' AND envelope_hash = ? LIMIT 1"
      ).get(delivery.envelopeHash);
      if (raced) return duplicateResult(raced, delivery.deliveryId, 'envelope_hash');
    }
    throw error;
  }

  return acceptedResult({
    inboxId: Number(result.lastInsertRowid),
    delivery,
    receivedAt
  });
}

function getInboxStatus() {
  const counts = countByStatus('dl_federation_inbox');
  return {
    accepted: counts.accepted || 0,
    rejected: counts.rejected || 0,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0)
  };
}

function remotePostIdFor(envelopeHash) {
  const digest = crypto.createHash('sha256')
    .update(`deadletters-remote-exchange-v1:${envelopeHash}`, 'utf8')
    .digest('hex');
  return `rpost_${digest.slice(0, 32)}`;
}

function sanitizeRemoteChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain.slice(0, MAX_CHAIN_ENTRIES).map(entry => {
    if (!isPlainObject(entry)) return { action: 'unknown' };
    const safe = {};
    const textFields = [
      ['action', 100],
      ['author', 300],
      ['node', 500],
      ['timestamp', 100],
      ['commentary', MAX_REMOTE_CHAIN_COMMENTARY]
    ];
    for (const [name, maximum] of textFields) {
      if (typeof entry[name] === 'string') safe[name] = truncate(entry[name], maximum);
    }
    if (typeof entry.curator_id === 'number' && Number.isSafeInteger(entry.curator_id)) {
      safe.curator_id = entry.curator_id;
    } else if (typeof entry.curator_id === 'string') {
      safe.curator_id = truncate(entry.curator_id, 100);
    }
    return safe;
  });
}

function buildRemoteProjection(remoteRow, inboxRow, { includeStatus = false } = {}) {
  if (!remoteRow || !inboxRow) return null;
  const payload = safePayloadObject(inboxRow.payload_json);
  const envelope = payload && isPlainObject(payload.envelope) ? payload.envelope : null;
  if (!envelope) return null;

  const source = isPlainObject(envelope.source) ? envelope.source : {};
  const curator = isPlainObject(envelope.curator) ? envelope.curator : {};
  const signingNode = isPlainObject(envelope.signing_node) ? envelope.signing_node : {};
  const chain = Array.isArray(envelope.provenance_chain) ? envelope.provenance_chain : [];
  const keyId = truncate(signingNode.key_id || inboxRow.key_id || '', 100);
  const signingNodeHandle = truncate(signingNode.handle || inboxRow.source_node || '', 100);
  const sourceNode = truncate(source.node || inboxRow.source_node || '', 500);
  const peer = getDb().prepare(
    'SELECT enabled FROM dl_federation_peers WHERE key_id = ? AND node_handle = ?'
  ).get(keyId, signingNodeHandle) || null;

  const item = {
    remote_post_id: remoteRow.remote_post_id,
    inbox_id: remoteRow.inbox_id,
    envelope_hash: remoteRow.envelope_hash,
    source_node: sourceNode,
    source_url: source.url === null || source.url === undefined ? null : truncate(source.url, 2048),
    source_author: truncate(source.author || '', 300),
    source_title: truncate(source.title || '', 500),
    source_excerpt: truncate(source.excerpt || '', 2000),
    source: {
      node: sourceNode,
      url: source.url === null || source.url === undefined ? null : truncate(source.url, 2048),
      author: truncate(source.author || '', 300),
      title: truncate(source.title || '', 500),
      excerpt: truncate(source.excerpt || '', 2000)
    },
    curator_commentary: truncate(curator.commentary || '', MAX_REMOTE_COMMENTARY),
    created_at: truncate(envelope.created_at || '', 100),
    signed_at: truncate(envelope.created_at || '', 100),
    promoted_at: remoteRow.promoted_at || null,
    signing_node_handle: signingNodeHandle,
    signing_node: {
      handle: signingNodeHandle,
      key_id: keyId
    },
    provenance_chain: sanitizeRemoteChain(chain),
    key_id: keyId,
    chain_length: chain.length,
    parent_envelope_hash: envelope.parent_envelope_hash === null || envelope.parent_envelope_hash === undefined
      ? null
      : truncate(envelope.parent_envelope_hash, 200),
    verification: {
      scope: REMOTE_VERIFICATION_SCOPE,
      peer_registered: Boolean(peer),
      peer_enabled: Boolean(peer && peer.enabled),
      key_id: keyId,
      note: 'Ed25519 signature and canonical hash were verified against an enabled registered peer key when this item was promoted. Peer registry state shown is current.'
    }
  };
  if (includeStatus) item.status = remoteRow.status;
  return item;
}

/**
 * Explicitly promote or moderate one accepted inbox envelope. Promotion always
 * re-verifies the stored payload against the current enabled peer registry;
 * hiding/removing never rewrites the audit row. No local post is ever created.
 */
function setInboxRemoteStatus({ inboxId, status, actorUserId } = {}) {
  if (!Number.isSafeInteger(inboxId) || inboxId <= 0) {
    throw httpError(400, 'A positive federation inbox id is required.');
  }
  if (!REMOTE_STATUS_SET.has(status)) {
    throw httpError(400, 'Remote exchange status must be promoted, hidden, or removed.');
  }
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw httpError(400, 'An authenticated actor id is required.');
  }

  const db = getDb();
  const apply = db.transaction(() => {
    const inbox = db.prepare('SELECT * FROM dl_federation_inbox WHERE inbox_id = ?').get(inboxId);
    if (!inbox) throw httpError(404, 'Federation inbox record not found.');
    if (inbox.status !== 'accepted' || !inbox.envelope_hash) {
      throw httpError(409, 'Only accepted federation inbox records can be promoted or moderated.');
    }

    const existing = db.prepare(`
      SELECT * FROM dl_federation_remote_posts
      WHERE inbox_id = ? OR envelope_hash = ?
      LIMIT 1
    `).get(inboxId, inbox.envelope_hash);
    if (existing && existing.inbox_id !== inboxId) {
      throw httpError(409, 'This envelope is already linked to a different inbox record.');
    }

    if (status === 'promoted') {
      // Re-verify the retained delivery, not the promotion request, so a peer
      // that was disabled, deleted, rotated, or a payload that was tampered
      // with in storage cannot become public.
      verifyInboxPromotion(inbox);
      const now = new Date().toISOString();

      if (!existing) {
        db.prepare(`
          INSERT INTO dl_federation_remote_posts (
            remote_post_id, inbox_id, envelope_hash, status,
            promoted_by, promoted_at, updated_at
          ) VALUES (?, ?, ?, 'promoted', ?, ?, ?)
        `).run(
          remotePostIdFor(inbox.envelope_hash),
          inbox.inbox_id,
          inbox.envelope_hash,
          actorUserId,
          now,
          now
        );
      } else if (existing.status !== 'promoted') {
        db.prepare(`
          UPDATE dl_federation_remote_posts
          SET status = 'promoted', promoted_by = ?, promoted_at = ?, updated_at = ?
          WHERE remote_post_id = ?
        `).run(actorUserId, now, now, existing.remote_post_id);
      }
      // A duplicate promotion is idempotent: the original audit timestamps are
      // preserved after successful re-verification.
    } else {
      if (!existing) {
        throw httpError(409, 'A remote exchange item must be promoted before it can be hidden or removed.');
      }
      db.prepare(`
        UPDATE dl_federation_remote_posts
        SET status = ?, updated_at = ?
        WHERE remote_post_id = ?
      `).run(status, new Date().toISOString(), existing.remote_post_id);
    }

    const updated = db.prepare(
      'SELECT * FROM dl_federation_remote_posts WHERE inbox_id = ?'
    ).get(inbox.inbox_id);
    const projection = buildRemoteProjection(updated, inbox, { includeStatus: true });
    if (projection) return projection;

    // Hiding/removing must still be possible even if the retained payload was
    // damaged after promotion: visibility is independent of projection detail.
    if (status !== 'promoted') {
      return {
        remote_post_id: updated.remote_post_id,
        inbox_id: updated.inbox_id,
        envelope_hash: updated.envelope_hash,
        status: updated.status,
        promoted_at: updated.promoted_at || null,
        updated_at: updated.updated_at
      };
    }
    throw httpError(500, 'Remote exchange projection failed.');
  });

  return apply();
}

function verifyInboxPromotion(inbox) {
  const stored = safePayloadObject(inbox.payload_json);
  if (!stored) throw httpError(422, 'Stored federation payload is not valid JSON.');

  const shape = validateDeliveryShape(stored);
  if (shape.error) {
    throw httpError(422, `Stored federation payload is no longer valid: ${shape.error}`);
  }
  const delivery = shape.value;

  if (!inbox.envelope_hash || inbox.envelope_hash !== delivery.envelopeHash) {
    throw httpError(422, 'Stored federation payload no longer matches the inbox envelope hash.');
  }
  if (!inbox.key_id || inbox.key_id !== delivery.keyId) {
    throw httpError(422, 'Stored federation payload no longer matches the inbox signing key id.');
  }
  if (!inbox.source_node || inbox.source_node !== delivery.sourceNode) {
    throw httpError(422, 'Stored federation payload no longer matches the inbox node handle.');
  }

  const peer = getDb().prepare(
    'SELECT * FROM dl_federation_peers WHERE key_id = ? AND node_handle = ?'
  ).get(delivery.keyId, delivery.sourceNode);
  if (!peer) {
    throw httpError(422, 'The stored envelope no longer matches a registered federation peer (the peer may be disabled, deleted, or rotated).');
  }
  if (!peer.enabled) {
    throw httpError(422, 'The stored envelope peer is not enabled for federation.');
  }
  if (inbox.source_peer_id !== null && inbox.source_peer_id !== undefined &&
    Number(inbox.source_peer_id) !== Number(peer.peer_id)) {
    throw httpError(422, 'The stored envelope peer identity no longer matches the inbox trust anchor.');
  }
  if (!provenance.verifyEnvelopeSignature(delivery.envelope, delivery.signature, peer.public_key_der)) {
    throw httpError(422, 'The stored envelope Ed25519 signature is invalid for the registered peer key.');
  }

  return { delivery, peer };
}

function countPromotedRemote() {
  return getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM dl_federation_remote_posts r
    JOIN dl_federation_inbox i ON i.inbox_id = r.inbox_id
    WHERE r.status = 'promoted' AND i.status = 'accepted'
  `).get().count;
}

function listPromotedRemote({ limit = DEFAULT_REMOTE_LIMIT, offset = 0 } = {}) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);
  const boundedLimit = Math.min(
    Math.max(Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_REMOTE_LIMIT, 1),
    MAX_REMOTE_LIMIT
  );
  const boundedOffset = Math.min(
    Math.max(Number.isFinite(parsedOffset) ? parsedOffset : 0, 0),
    MAX_REMOTE_OFFSET
  );

  const rows = getDb().prepare(`
    SELECT
      r.remote_post_id, r.inbox_id, r.envelope_hash, r.status AS remote_status,
      r.promoted_by, r.promoted_at, r.updated_at AS remote_updated_at,
      i.payload_json, i.source_node, i.key_id, i.received_at
    FROM dl_federation_remote_posts r
    JOIN dl_federation_inbox i ON i.inbox_id = r.inbox_id
    WHERE r.status = 'promoted' AND i.status = 'accepted'
    ORDER BY r.promoted_at DESC, r.remote_post_id DESC
    LIMIT ? OFFSET ?
  `).all(boundedLimit, boundedOffset);

  const items = [];
  for (const row of rows) {
    const item = buildRemoteProjection(row, row);
    if (item) items.push(item);
  }

  return {
    items,
    total: countPromotedRemote(),
    limit: boundedLimit,
    offset: boundedOffset
  };
}

function listInbox({ limit = 50, includePayload = false } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = getDb().prepare(`
    SELECT
      i.*,
      r.remote_post_id,
      r.status AS remote_status,
      r.promoted_by,
      r.promoted_at,
      r.updated_at AS remote_updated_at
    FROM dl_federation_inbox i
    LEFT JOIN dl_federation_remote_posts r ON r.inbox_id = i.inbox_id
    ORDER BY i.inbox_id DESC
    LIMIT ?
  `).all(boundedLimit);

  return rows.map(row => {
    const payload = safePayloadObject(row.payload_json);
    const envelope = payload && isPlainObject(payload.envelope) ? payload.envelope : null;
    const item = {
      inbox_id: row.inbox_id,
      delivery_id: row.delivery_id,
      source_peer_id: row.source_peer_id,
      source_node: row.source_node,
      key_id: row.key_id,
      envelope_hash: row.envelope_hash,
      source_title: envelope && isPlainObject(envelope.source)
        ? truncate(envelope.source.title || '', 500)
        : null,
      parent_envelope_hash: envelope ? (envelope.parent_envelope_hash ?? null) : null,
      status: row.status,
      reason: row.reason,
      received_at: row.received_at,
      remote_post_id: row.remote_post_id || null,
      remote_status: row.remote_status || null,
      promoted_by: row.promoted_by ?? null,
      promoted_at: row.promoted_at || null,
      remote_updated_at: row.remote_updated_at || null,
      local_post_created: false,
      storage: 'federation-inbox-audit'
    };
    if (includePayload) item.payload = payload;
    return item;
  });
}

function getFederationStatus() {
  const peers = getDb().prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
    FROM dl_federation_peers
  `).get();
  const remoteCounts = countByStatus('dl_federation_remote_posts');

  return {
    peers: {
      total: peers.total || 0,
      enabled: peers.enabled || 0
    },
    outbox: getOutboxStatus(),
    inbox: getInboxStatus(),
    remote_exchange: {
      promoted: remoteCounts.promoted || 0,
      hidden: remoteCounts.hidden || 0,
      removed: remoteCounts.removed || 0,
      total: Object.values(remoteCounts).reduce((sum, value) => sum + value, 0),
      public_count: countPromotedRemote()
    },
    worker: {
      running: workerTimer !== null,
      interval_ms: WORKER_INTERVAL_MS
    },
    delivery: {
      spec: DELIVERY_SPEC,
      max_attempts: MAX_ATTEMPTS,
      timeout_ms: DEFAULT_TIMEOUT_MS,
      max_body_bytes: MAX_DELIVERY_BYTES
    },
    limitations: {
      remote_key_discovery: false,
      remote_post_creation: false,
      automatic_remote_promotion: false,
      cross_node_parent_proof: false,
      confidentiality: 'HTTPS only; no application-layer encryption'
    }
  };
}

function startFederationWorker({ intervalMs = WORKER_INTERVAL_MS } = {}) {
  if (workerTimer) return false;
  const interval = Math.max(1000, Number(intervalMs) || WORKER_INTERVAL_MS);
  workerTimer = setInterval(() => {
    processOutboxDue().catch(error => {
      console.error('[Federation] Outbox worker error:', safeErrorMessage(error));
    });
  }, interval);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  return true;
}

function stopFederationWorker() {
  if (!workerTimer) return false;
  clearInterval(workerTimer);
  workerTimer = null;
  return true;
}

function isFederationWorkerRunning() {
  return workerTimer !== null;
}

// Registering at module load means reshares are enqueued even when only the
// app is imported by an integration test; the delivery worker itself is still
// started exclusively by startServer().
registerPostResharedHook();

module.exports = {
  DELIVERY_SPEC,
  INBOX_PATH,
  MAX_DELIVERY_BYTES,
  MAX_ATTEMPTS,
  WORKER_INTERVAL_MS,
  BACKOFF_SCHEDULE_MS,
  REMOTE_STATUSES,
  DEFAULT_REMOTE_LIMIT,
  MAX_REMOTE_LIMIT,
  MAX_REMOTE_OFFSET,
  REMOTE_VERIFICATION_SCOPE,
  createKeyId,
  normalizeEndpointUrl,
  validatePeerInput,
  registerPeer,
  listPeers,
  setPeerEnabled,
  deletePeer,
  enqueueReshareForAllPeers,
  registerPostResharedHook,
  unregisterPostResharedHook,
  processOutboxDue,
  getOutboxStatus,
  listOutbox,
  receiveDelivery,
  getInboxStatus,
  listInbox,
  setInboxRemoteStatus,
  countPromotedRemote,
  listPromotedRemote,
  getFederationStatus,
  startFederationWorker,
  stopFederationWorker,
  isFederationWorkerRunning
};
