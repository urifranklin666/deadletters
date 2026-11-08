'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, test } = require('node:test');
const Database = require('better-sqlite3');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-federation-test-'));
process.env.DEADLETTERS_DATA_DIR = path.join(sandbox, 'unit-data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(sandbox, 'unit-uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(sandbox, 'unit-themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(sandbox, 'unit-addons');
process.env.DB_PATH = path.join(sandbox, 'unit-data', 'federation.db');
process.env.JWT_SECRET = 'federation-unit-test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const schema = require('../src/core/schema');
const { closeDb, getDb } = require('../src/core/db');
const federation = require('../src/core/federation');
const provenance = require('../src/core/provenance');
const { createReshare } = require('../src/core/reshare-engine');

const childNodes = new Set();
const helperPath = path.join(__dirname, 'helpers', 'federation-node.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function getClosedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function generatePeerKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    public_key: der.toString('base64url'),
    key_id: federation.createKeyId(der),
    privateKey
  };
}

function buildDelivery({
  privateKey,
  handle,
  keyId,
  deliveryId = `remote_${crypto.randomBytes(8).toString('hex')}`,
  commentary = 'Remote signed commentary.',
  parentEnvelopeHash = null,
  chain = null,
  sourceUrl = 'https://origin.example.test/letter'
}) {
  const createdAt = new Date().toISOString();
  const envelope = {
    type: provenance.ENVELOPE_TYPE,
    spec: provenance.PROTOCOL_SPEC,
    source: {
      url: sourceUrl,
      node: 'https://origin.example.test',
      author: 'Origin Author',
      title: 'Origin Letter',
      excerpt: 'Origin excerpt'
    },
    curator: {
      id: 'remote-curator',
      commentary
    },
    created_at: createdAt,
    signing_node: {
      handle,
      key_id: keyId
    },
    parent_envelope_hash: parentEnvelopeHash,
    provenance_chain: chain || [{
      action: 'original_drop',
      author: 'Origin Author',
      node: 'https://origin.example.test',
      timestamp: createdAt
    }]
  };

  const canonical = provenance.canonicalJson(envelope);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
  return {
    spec: federation.DELIVERY_SPEC,
    delivery_id: deliveryId,
    sent_at: new Date().toISOString(),
    envelope,
    envelope_hash: provenance.createEnvelopeHash(envelope),
    signature,
    signature_algorithm: provenance.SIGNATURE_ALGORITHM,
    key_id: keyId
  };
}

async function jsonRequest(baseUrl, endpoint, { token, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined && typeof options.body !== 'string' &&
    !(options.body instanceof FormData) && !(options.body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(baseUrl + endpoint, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { response, data, text };
}

async function spawnNode(label) {
  const nodeRoot = path.join(sandbox, label);
  const dataDir = path.join(nodeRoot, 'data');
  const uploadsDir = path.join(nodeRoot, 'uploads');
  const themesDir = path.join(nodeRoot, 'themes');
  const addonsDir = path.join(nodeRoot, 'addons');
  const readyFile = path.join(nodeRoot, 'ready.json');

  for (const directory of [dataDir, uploadsDir, themesDir, addonsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const child = spawn(process.execPath, [helperPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DEADLETTERS_DATA_DIR: dataDir,
      DEADLETTERS_UPLOADS_DIR: uploadsDir,
      DEADLETTERS_THEMES_DIR: themesDir,
      DEADLETTERS_ADDONS_DIR: addonsDir,
      DB_PATH: path.join(dataDir, 'deadletters.db'),
      JWT_SECRET: `federation-${label}-secret-not-for-production`,
      NODE_ENV: 'test',
      DEADLETTERS_TEST_READY_FILE: readyFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const node = {
    label,
    child,
    logs: [],
    stopped: false,
    dataDir,
    baseUrl: null,
    token: null,
    discovery: null,
    port: null
  };
  childNodes.add(node);

  child.stdout.on('data', chunk => node.logs.push(chunk.toString('utf8')));
  child.stderr.on('data', chunk => node.logs.push(chunk.toString('utf8')));
  child.on('exit', (code, signal) => {
    node.exit = { code, signal };
  });

  try {
    await waitFor(() => fs.existsSync(readyFile), 20000, `${label} readiness`);
  } catch (error) {
    throw new Error(`${error.message}\n${node.logs.join('')}`);
  }

  const info = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  node.baseUrl = info.baseUrl;
  node.port = info.port;
  return node;
}

async function installNode(node, handle, login) {
  const installed = await jsonRequest(node.baseUrl, '/api/v1/installer/execute', {
    method: 'POST',
    body: {
      siteTitle: `Federation ${node.label}`,
      siteTagline: 'delivery-only federation test',
      siteNodeHandle: handle,
      siteUrl: node.baseUrl,
      adminLogin: login,
      adminEmail: `${login}@example.test`,
      adminPassword: 'federation-secure-password',
      seedDemoContent: false
    }
  });
  assert.equal(installed.response.status, 201, JSON.stringify(installed.data));
  node.token = installed.data.token;
  assert.ok(node.token);

  const discovery = await jsonRequest(node.baseUrl, '/.well-known/deadletters.json');
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.data.node_handle, handle);
  assert.equal(discovery.data.public_key.algorithm, 'Ed25519');
  node.discovery = discovery.data;
  return node;
}

async function stopNode(node) {
  if (!node || node.stopped) return;
  node.stopped = true;
  childNodes.delete(node);

  if (node.child.exitCode !== null || node.child.signalCode !== null) return;

  const exited = new Promise(resolve => node.child.once('exit', resolve));
  node.child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(5000).then(() => true)
  ]);

  if (timedOut) {
    node.child.kill('SIGKILL');
    await exited;
  }
}

after(async () => {
  for (const node of [...childNodes]) {
    await stopNode(node);
  }
  closeDb();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('fresh schema and migration 5 expose peers, outbox, inbox, remote exchange, foreign keys, and indexes', () => {
  const memory = new Database(':memory:');
  try {
    memory.exec(schema);
    const tables = new Set(memory.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    for (const required of [
      'dl_federation_peers',
      'dl_federation_outbox',
      'dl_federation_inbox',
      'dl_federation_remote_posts'
    ]) {
      assert.equal(tables.has(required), true, required);
    }

    const outboxForeignKeys = memory.prepare('PRAGMA foreign_key_list(dl_federation_outbox)').all();
    assert.equal(outboxForeignKeys.some(row => row.table === 'dl_federation_peers'), true);
    assert.equal(outboxForeignKeys.some(row => row.table === 'dl_reshares'), true);

    const inboxForeignKeys = memory.prepare('PRAGMA foreign_key_list(dl_federation_inbox)').all();
    assert.equal(inboxForeignKeys.some(row => row.table === 'dl_federation_peers'), true);

    const remoteForeignKeys = memory.prepare('PRAGMA foreign_key_list(dl_federation_remote_posts)').all();
    assert.equal(remoteForeignKeys.some(row => row.table === 'dl_federation_inbox'), true);
    assert.equal(remoteForeignKeys.some(row => row.table === 'dl_users'), true);

    const indexes = new Set(memory.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    ).all().map(row => row.name));
    for (const required of [
      'idx_federation_peers_enabled',
      'idx_federation_outbox_peer',
      'idx_federation_outbox_due',
      'idx_federation_inbox_peer',
      'idx_federation_inbox_accepted_envelope',
      'idx_federation_remote_status_promoted',
      'idx_federation_remote_promoted_by'
    ]) {
      assert.equal(indexes.has(required), true, required);
    }
  } finally {
    memory.close();
  }

  const db = getDb();
  const peerColumns = db.prepare('PRAGMA table_info(dl_federation_peers)').all().map(row => row.name);
  assert.deepEqual(peerColumns, [
    'peer_id', 'endpoint_url', 'node_handle', 'public_key_der', 'key_id',
    'enabled', 'created_at', 'updated_at'
  ]);

  const outboxColumns = db.prepare('PRAGMA table_info(dl_federation_outbox)').all().map(row => row.name);
  for (const required of [
    'delivery_id', 'peer_id', 'envelope_hash', 'reshare_id', 'payload_json',
    'status', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at'
  ]) {
    assert.equal(outboxColumns.includes(required), true, required);
  }

  const inboxColumns = db.prepare('PRAGMA table_info(dl_federation_inbox)').all().map(row => row.name);
  for (const required of [
    'delivery_id', 'source_peer_id', 'source_node', 'key_id', 'envelope_hash',
    'payload_json', 'status', 'reason', 'received_at'
  ]) {
    assert.equal(inboxColumns.includes(required), true, required);
  }

  const remoteColumns = db.prepare('PRAGMA table_info(dl_federation_remote_posts)').all().map(row => row.name);
  assert.deepEqual(remoteColumns, [
    'remote_post_id', 'inbox_id', 'envelope_hash', 'status',
    'promoted_by', 'promoted_at', 'updated_at'
  ]);

  assert.deepEqual(
    db.prepare('SELECT version FROM dl_schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2, 3, 4, 5]
  );
});

test('peer registration normalizes endpoints and validates trusted Ed25519 key material', () => {
  const db = getDb();
  db.prepare('DELETE FROM dl_federation_peers').run();

  const key = generatePeerKey();
  const peer = federation.registerPeer({
    endpoint_url: 'https://peer.example/../mesh/base/',
    node_handle: '  @test/peer-node  ',
    public_key: key.public_key
  });

  assert.equal(peer.endpoint_url, 'https://peer.example/mesh/base');
  assert.equal(peer.node_handle, '@test/peer-node');
  assert.equal(peer.key_id, key.key_id);
  assert.equal(peer.key_id, federation.createKeyId(Buffer.from(key.public_key, 'base64url')));
  assert.equal(peer.public_key, key.public_key);
  assert.equal(peer.enabled, true);
  assert.equal(Object.hasOwn(peer, 'private_key'), false);

  assert.throws(
    () => federation.registerPeer({
      endpoint_url: 'https://peer.example/mesh/base',
      node_handle: '@test/duplicate',
      public_key: generatePeerKey().public_key
    }),
    error => error.status === 409
  );

  for (const invalid of [
    { endpoint_url: 'ftp://peer.example', node_handle: '@x/y', public_key: key.public_key },
    { endpoint_url: 'https://user:pass@peer.example', node_handle: '@x/y', public_key: key.public_key },
    { endpoint_url: 'https://peer.example/?query=1', node_handle: '@x/y', public_key: key.public_key },
    { endpoint_url: 'https://peer.example', node_handle: '', public_key: key.public_key },
    { endpoint_url: 'https://peer.example', node_handle: '@x/y', public_key: 'not-a-key' }
  ]) {
    assert.throws(
      () => federation.registerPeer(invalid),
      error => error.status === 400,
      JSON.stringify(invalid)
    );
  }

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaDer = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  assert.throws(
    () => federation.registerPeer({
      endpoint_url: 'https://rsa.example',
      node_handle: '@rsa/node',
      public_key: rsaDer
    }),
    error => error.status === 400
  );

  assert.throws(
    () => federation.registerPeer({
      endpoint_url: 'https://wrong-id.example',
      node_handle: '@wrong/id',
      public_key: key.public_key,
      key_id: 'ed25519-0000000000000000'
    }),
    error => error.status === 400
  );

  const disabled = federation.setPeerEnabled(peer.peer_id, false);
  assert.equal(disabled.enabled, false);
  assert.equal(federation.listPeers({ enabledOnly: true }).length, 0);
  const enabled = federation.setPeerEnabled(peer.peer_id, true);
  assert.equal(enabled.enabled, true);

  assert.deepEqual(federation.deletePeer(peer.peer_id), { deleted: true, peer_id: peer.peer_id });
  assert.equal(federation.listPeers().length, 0);
});

test('reshare hooks enqueue once per enabled peer and delivery ids are deterministic', () => {
  const db = getDb();
  db.prepare('DELETE FROM dl_federation_outbox').run();
  db.prepare('DELETE FROM dl_federation_peers').run();

  assert.equal(federation.registerPostResharedHook(), false, 'module load already registered the hook');

  const peerKey = generatePeerKey();
  const peer = federation.registerPeer({
    endpoint_url: 'https://enqueue.example',
    node_handle: '@test/enqueue-peer',
    public_key: peerKey.public_key
  });

  const userId = Number(db.prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES ('federation-curator', 'test-only', 'federation@example.test', 'Federation Curator', 'operator')
  `).run().lastInsertRowid);

  const postId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, drop_code
    ) VALUES (?, 'Federation source', 'federation-source', 'Signed body', 'Signed excerpt',
      'publish', 'post', 'FED-001')
  `).run(userId).lastInsertRowid);

  const reshare = createReshare({
    userId,
    sourcePostId: postId,
    curatorCommentary: 'A locally signed envelope.'
  });

  const firstItems = federation.listOutbox({ includePayload: true });
  assert.equal(firstItems.length, 1);
  assert.equal(firstItems[0].peer_id, peer.peer_id);
  assert.equal(firstItems[0].status, 'pending');
  assert.equal(firstItems[0].payload.spec, federation.DELIVERY_SPEC);
  assert.equal(firstItems[0].payload.envelope_hash, reshare.envelope_hash);
  assert.equal(firstItems[0].payload.signature, reshare.envelope_signature);
  assert.equal(firstItems[0].payload.key_id, reshare.signing_key_id);

  const repeated = federation.enqueueReshareForAllPeers({ postId: reshare.id });
  assert.equal(repeated.enqueued, 0);
  assert.equal(repeated.existing, 1);
  assert.equal(federation.listOutbox().length, 1);

  const secondKey = generatePeerKey();
  federation.registerPeer({
    endpoint_url: 'https://second-enqueue.example',
    node_handle: '@test/second-peer',
    public_key: secondKey.public_key
  });
  const secondEnqueue = federation.enqueueReshareForAllPeers({ postId: reshare.id });
  assert.equal(secondEnqueue.enqueued, 1);
  assert.equal(secondEnqueue.existing, 1);

  const items = federation.listOutbox();
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map(item => item.delivery_id)).size, 2);

  db.prepare('DELETE FROM dl_federation_peers').run();
  assert.equal(federation.listOutbox().length, 0, 'peer deletion cascades pending outbox rows');
});

test('inbox verification accepts real signatures, rejects tampering and unknown keys, and deduplicates', () => {
  const db = getDb();
  db.prepare('DELETE FROM dl_federation_outbox').run();
  db.prepare('DELETE FROM dl_federation_peers').run();
  db.prepare('DELETE FROM dl_federation_inbox').run();

  const peerKey = generatePeerKey();
  federation.registerPeer({
    endpoint_url: 'https://inbox.example',
    node_handle: '@test/inbox-peer',
    public_key: peerKey.public_key
  });

  const valid = buildDelivery({
    privateKey: peerKey.privateKey,
    handle: '@test/inbox-peer',
    keyId: peerKey.key_id,
    deliveryId: 'inbox_unit_delivery_1'
  });

  const accepted = federation.receiveDelivery(valid);
  assert.equal(accepted.httpStatus, 202);
  assert.equal(accepted.body.status, 'accepted');
  assert.equal(accepted.body.envelope_hash, valid.envelope_hash);
  assert.equal(accepted.body.parent_envelope_hash, null);
  assert.equal(accepted.body.parent_envelope_known_locally, false);
  assert.equal(accepted.body.parent_verification_scope, 'local-presence-only');
  assert.equal(accepted.body.local_post_created, false);
  assert.equal(accepted.body.storage, 'federation-inbox-audit');
  assert.equal(accepted.body.provenance_chain.length, 1);

  const duplicateDelivery = federation.receiveDelivery(valid);
  assert.equal(duplicateDelivery.httpStatus, 200);
  assert.equal(duplicateDelivery.body.status, 'duplicate');
  assert.equal(duplicateDelivery.body.duplicate_by, 'delivery_id');

  const sameEnvelope = federation.receiveDelivery({
    ...valid,
    delivery_id: 'inbox_unit_delivery_2'
  });
  assert.equal(sameEnvelope.httpStatus, 200);
  assert.equal(sameEnvelope.body.duplicate_by, 'envelope_hash');

  const tampered = JSON.parse(JSON.stringify(valid));
  tampered.delivery_id = 'inbox_unit_tampered';
  tampered.envelope.curator.commentary = 'Tampered after signing.';
  tampered.envelope_hash = provenance.createEnvelopeHash(tampered.envelope);
  const rejectedSignature = federation.receiveDelivery(tampered);
  assert.equal(rejectedSignature.httpStatus, 401);
  assert.match(rejectedSignature.body.error, /signature/i);

  const wrongClaim = JSON.parse(JSON.stringify(valid));
  wrongClaim.delivery_id = 'inbox_unit_wrong_hash';
  wrongClaim.envelope_hash = 'A'.repeat(43);
  const rejectedHash = federation.receiveDelivery(wrongClaim);
  assert.equal(rejectedHash.httpStatus, 400);
  assert.match(rejectedHash.body.error, /hash/i);

  const rogueKey = generatePeerKey();
  const rogue = buildDelivery({
    privateKey: rogueKey.privateKey,
    handle: '@rogue/node',
    keyId: rogueKey.key_id,
    deliveryId: 'inbox_unit_rogue'
  });
  const rejectedPeer = federation.receiveDelivery(rogue);
  assert.equal(rejectedPeer.httpStatus, 403);
  assert.match(rejectedPeer.body.error, /registered federation peer/i);

  const status = federation.getInboxStatus();
  assert.equal(status.accepted, 1);
  assert.equal(status.rejected, 3);

  const inbox = federation.listInbox({ includePayload: true });
  const acceptedRows = inbox.filter(row => row.status === 'accepted');
  assert.equal(acceptedRows.length, 1);
  assert.equal(acceptedRows[0].payload.envelope.signing_node.key_id, peerKey.key_id);
});

test('remote exchange promotion is explicit, reverified, idempotent, and audit-preserving', () => {
  const db = getDb();
  db.prepare('DELETE FROM dl_federation_remote_posts').run();
  db.prepare('DELETE FROM dl_federation_inbox').run();
  db.prepare('DELETE FROM dl_federation_outbox').run();
  db.prepare('DELETE FROM dl_federation_peers').run();

  const actorUserId = Number(db.prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES ('remote-moderator', 'test-only', 'remote-moderator@example.test', 'Remote Moderator', 'superadmin')
  `).run().lastInsertRowid);
  const localPostsBefore = db.prepare('SELECT COUNT(*) AS count FROM dl_posts').get().count;

  let sequence = 0;
  function acceptRemote(handle, endpoint) {
    sequence += 1;
    const key = generatePeerKey();
    const peer = federation.registerPeer({
      endpoint_url: endpoint,
      node_handle: handle,
      public_key: key.public_key
    });
    const delivery = buildDelivery({
      privateKey: key.privateKey,
      handle,
      keyId: key.key_id,
      deliveryId: `remote_exchange_${sequence}_${crypto.randomBytes(4).toString('hex')}`,
      parentEnvelopeHash: sequence === 1 ? null : 'A'.repeat(43),
      chain: [{
        action: 'original_drop',
        author: 'Origin Author',
        node: 'https://origin.example.test',
        timestamp: new Date().toISOString()
      }, {
        action: 're_lettered',
        curator_id: 'remote-curator',
        node: handle,
        commentary: `Remote commentary ${sequence}`,
        timestamp: new Date().toISOString()
      }]
    });
    const accepted = federation.receiveDelivery(delivery);
    assert.equal(accepted.httpStatus, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, 'accepted');
    return { key, peer, delivery, inboxId: accepted.body.inbox_id };
  }

  const first = acceptRemote('@test/remote-first', 'https://remote-first.example');
  let inboxItem = federation.listInbox().find(item => item.inbox_id === first.inboxId);
  assert.ok(inboxItem);
  assert.equal(inboxItem.remote_post_id, null);
  assert.equal(inboxItem.remote_status, null);
  assert.equal(inboxItem.promoted_at, null);

  assert.throws(
    () => federation.setInboxRemoteStatus({
      inboxId: first.inboxId,
      status: 'accepted',
      actorUserId
    }),
    error => error.status === 400
  );
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: 0, status: 'promoted', actorUserId }),
    error => error.status === 400
  );
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: 999999, status: 'promoted', actorUserId }),
    error => error.status === 404
  );
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: first.inboxId, status: 'hidden', actorUserId }),
    error => error.status === 409,
    'an item must be promoted before it can be hidden'
  );

  const promoted = federation.setInboxRemoteStatus({
    inboxId: first.inboxId,
    status: 'promoted',
    actorUserId
  });
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.inbox_id, first.inboxId);
  assert.equal(promoted.envelope_hash, first.delivery.envelope_hash);
  assert.match(promoted.remote_post_id, /^rpost_[a-f0-9]{32}$/);
  assert.equal(promoted.source_node, 'https://origin.example.test');
  assert.equal(promoted.signing_node_handle, '@test/remote-first');
  assert.equal(promoted.signing_node.handle, '@test/remote-first');
  assert.equal(promoted.source_url, 'https://origin.example.test/letter');
  assert.equal(promoted.source_author, 'Origin Author');
  assert.equal(promoted.source_title, 'Origin Letter');
  assert.equal(promoted.source_excerpt, 'Origin excerpt');
  assert.equal(promoted.curator_commentary, 'Remote signed commentary.');
  assert.equal(promoted.chain_length, 2);
  assert.equal(promoted.provenance_chain.length, 2);
  assert.equal(promoted.parent_envelope_hash, null);
  assert.equal(promoted.verification.scope, 'peer-ed25519-at-receipt');
  assert.equal(promoted.verification.peer_registered, true);
  assert.equal(promoted.verification.peer_enabled, true);
  assert.equal(promoted.verification.key_id, first.key.key_id);

  let publicList = federation.listPromotedRemote({ limit: 10, offset: 0 });
  assert.equal(publicList.total, 1);
  assert.equal(publicList.items.length, 1);
  const publicItem = publicList.items[0];
  assert.equal(publicItem.remote_post_id, promoted.remote_post_id);
  assert.equal(publicItem.inbox_id, first.inboxId);
  assert.equal(publicItem.envelope_hash, first.delivery.envelope_hash);
  assert.equal(publicItem.parent_envelope_hash, null);
  assert.equal(publicItem.chain_length, 2);
  assert.equal(publicItem.provenance_chain[0].action, 'original_drop');
  assert.equal(publicItem.verification.scope, 'peer-ed25519-at-receipt');
  for (const forbidden of ['delivery_id', 'payload', 'reason', 'last_error', 'local_post_id',
    'source_peer_id', 'promoted_by', 'email']) {
    assert.equal(Object.hasOwn(publicItem, forbidden), false, forbidden);
  }
  assert.doesNotMatch(JSON.stringify(publicItem),
    /delivery_id|payload_json|local_post_id|last_error|source_peer_id|promoted_by|@example\.test/);
  assert.equal(publicItem.provenance_chain.some(entry => Object.hasOwn(entry, 'local_post_id')), false);

  inboxItem = federation.listInbox().find(item => item.inbox_id === first.inboxId);
  assert.equal(inboxItem.remote_status, 'promoted');
  assert.equal(inboxItem.remote_post_id, promoted.remote_post_id);
  assert.equal(inboxItem.promoted_by, actorUserId);
  assert.ok(inboxItem.promoted_at);

  const duplicate = federation.setInboxRemoteStatus({
    inboxId: first.inboxId,
    status: 'promoted',
    actorUserId
  });
  assert.equal(duplicate.remote_post_id, promoted.remote_post_id);
  assert.equal(duplicate.promoted_at, promoted.promoted_at, 'duplicate promotion preserves audit timestamps');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM dl_federation_remote_posts').get().count,
    1,
    'duplicate promotion is an upsert, not a second row'
  );

  const hidden = federation.setInboxRemoteStatus({ inboxId: first.inboxId, status: 'hidden', actorUserId });
  assert.equal(hidden.status, 'hidden');
  assert.equal(federation.listPromotedRemote().total, 0);
  inboxItem = federation.listInbox().find(item => item.inbox_id === first.inboxId);
  assert.equal(inboxItem.status, 'accepted');
  assert.equal(inboxItem.remote_status, 'hidden');
  assert.ok(inboxItem.promoted_at, 'hide preserves the original promotion audit');

  const repromoted = federation.setInboxRemoteStatus({
    inboxId: first.inboxId,
    status: 'promoted',
    actorUserId
  });
  assert.equal(repromoted.status, 'promoted');
  assert.equal(federation.listPromotedRemote().total, 1);

  const removed = federation.setInboxRemoteStatus({ inboxId: first.inboxId, status: 'removed', actorUserId });
  assert.equal(removed.status, 'removed');
  assert.equal(federation.listPromotedRemote().total, 0);
  inboxItem = federation.listInbox().find(item => item.inbox_id === first.inboxId);
  assert.equal(inboxItem.status, 'accepted', 'removal must retain the inbox audit row');
  assert.equal(inboxItem.remote_status, 'removed');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM dl_federation_remote_posts WHERE inbox_id = ?')
      .get(first.inboxId).count,
    1,
    'removal retains the remote audit row'
  );

  const disabled = acceptRemote('@test/remote-disabled', 'https://remote-disabled.example');
  federation.setPeerEnabled(disabled.peer.peer_id, false);
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: disabled.inboxId, status: 'promoted', actorUserId }),
    error => error.status === 422 && /enabled|registered/i.test(error.message)
  );
  federation.setPeerEnabled(disabled.peer.peer_id, true);
  assert.equal(
    federation.setInboxRemoteStatus({ inboxId: disabled.inboxId, status: 'promoted', actorUserId }).status,
    'promoted'
  );
  federation.setInboxRemoteStatus({ inboxId: disabled.inboxId, status: 'hidden', actorUserId });

  const deleted = acceptRemote('@test/remote-deleted', 'https://remote-deleted.example');
  federation.deletePeer(deleted.peer.peer_id);
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: deleted.inboxId, status: 'promoted', actorUserId }),
    error => error.status === 422
  );

  const tampered = acceptRemote('@test/remote-tampered', 'https://remote-tampered.example');
  const storedPayload = JSON.parse(db.prepare(
    'SELECT payload_json FROM dl_federation_inbox WHERE inbox_id = ?'
  ).get(tampered.inboxId).payload_json);
  storedPayload.envelope.curator.commentary = 'Tampered after receipt.';
  db.prepare('UPDATE dl_federation_inbox SET payload_json = ? WHERE inbox_id = ?')
    .run(JSON.stringify(storedPayload), tampered.inboxId);
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: tampered.inboxId, status: 'promoted', actorUserId }),
    error => error.status === 422
  );

  const mismatched = acceptRemote('@test/remote-mismatched', 'https://remote-mismatched.example');
  db.prepare('UPDATE dl_federation_peers SET public_key_der = ? WHERE peer_id = ?')
    .run(generatePeerKey().public_key, mismatched.peer.peer_id);
  assert.throws(
    () => federation.setInboxRemoteStatus({ inboxId: mismatched.inboxId, status: 'promoted', actorUserId }),
    error => error.status === 422 && /signature|registered|enabled/i.test(error.message)
  );

  const rogueKey = generatePeerKey();
  const rejected = federation.receiveDelivery(buildDelivery({
    privateKey: rogueKey.privateKey,
    handle: '@rogue/remote-exchange',
    keyId: rogueKey.key_id,
    deliveryId: `rogue_remote_${crypto.randomBytes(4).toString('hex')}`
  }));
  assert.equal(rejected.httpStatus, 403);
  assert.ok(rejected.body.inbox_id);
  assert.throws(
    () => federation.setInboxRemoteStatus({
      inboxId: rejected.body.inbox_id,
      status: 'promoted',
      actorUserId
    }),
    error => error.status === 409
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM dl_posts').get().count,
    localPostsBefore,
    'remote exchange must never create a local post'
  );

  // The FK cascade removes the remote projection if an operator deletes the
  // underlying inbox audit row; normal hide/remove never deletes it.
  db.prepare('DELETE FROM dl_federation_inbox WHERE inbox_id = ?').run(first.inboxId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM dl_federation_remote_posts WHERE inbox_id = ?')
      .get(first.inboxId).count,
    0
  );
});

test('the outbox worker is optional, unref-able, and gracefully stoppable', () => {
  assert.equal(federation.isFederationWorkerRunning(), false);
  assert.equal(federation.startFederationWorker({ intervalMs: 1000 }), true);
  assert.equal(federation.startFederationWorker({ intervalMs: 1000 }), false);
  assert.equal(federation.isFederationWorkerRunning(), true);
  assert.equal(federation.stopFederationWorker(), true);
  assert.equal(federation.isFederationWorkerRunning(), false);
  assert.equal(federation.stopFederationWorker(), false);
});

test('startServer starts the optional federation worker and server close stops it', async () => {
  const config = require('../src/config');
  config.saveConfigFile({
    installed: true,
    jwtSecret: process.env.JWT_SECRET,
    provenanceSecret: 'federation-worker-test-provenance-secret'
  });

  const { startServer } = require('../src/server');
  const server = startServer(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    assert.equal(federation.isFederationWorkerRunning(), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(federation.isFederationWorkerRunning(), false);
});

test('two real nodes exchange a signed re-letter, detect tampering, deduplicate, and dead-letter failures', async t => {
  const nodeA = await spawnNode('node-a');
  const nodeB = await spawnNode('node-b');

  try {
    await installNode(nodeA, '@test/node-a', 'admin-a');
    await installNode(nodeB, '@test/node-b', 'admin-b');

    await t.test('superadmin-only peer registration and public peer projection', async () => {
      const unauthenticated = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers');
      assert.equal(unauthenticated.response.status, 401);

      const createdOperator = await jsonRequest(nodeA.baseUrl, '/api/v1/auth/users', {
        method: 'POST',
        token: nodeA.token,
        body: {
          login: 'federation-operator',
          email: 'federation-operator@example.test',
          password: 'operator-password',
          role: 'operator'
        }
      });
      assert.equal(createdOperator.response.status, 201, JSON.stringify(createdOperator.data));

      const operatorLogin = await jsonRequest(nodeA.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { login: 'federation-operator', password: 'operator-password' }
      });
      assert.equal(operatorLogin.response.status, 200);

      const forbidden = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers', {
        method: 'POST',
        token: operatorLogin.data.token,
        body: {
          endpoint_url: nodeB.baseUrl,
          node_handle: nodeB.discovery.node_handle,
          public_key: nodeB.discovery.public_key.public_key
        }
      });
      assert.equal(forbidden.response.status, 403);

      const registeredB = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers', {
        method: 'POST',
        token: nodeA.token,
        body: {
          endpoint_url: nodeB.baseUrl,
          node_handle: nodeB.discovery.node_handle,
          public_key: nodeB.discovery.public_key.public_key
        }
      });
      assert.equal(registeredB.response.status, 201, JSON.stringify(registeredB.data));
      assert.equal(registeredB.data.peer.key_id, nodeB.discovery.public_key.key_id);
      assert.equal(registeredB.data.peer.endpoint_url, nodeB.baseUrl);

      const listed = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers', {
        token: nodeA.token
      });
      assert.equal(listed.response.status, 200);
      assert.equal(listed.data.peers.length, 1);
      assert.equal(listed.data.peers[0].key_id, nodeB.discovery.public_key.key_id);
      assert.doesNotMatch(JSON.stringify(listed.data), /private_key|BEGIN PRIVATE/i);

      const registeredA = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/peers', {
        method: 'POST',
        token: nodeB.token,
        body: {
          endpoint_url: nodeA.baseUrl,
          node_handle: nodeA.discovery.node_handle,
          public_key: nodeA.discovery.public_key.public_key
        }
      });
      assert.equal(registeredA.response.status, 201, JSON.stringify(registeredA.data));
      assert.equal(registeredA.data.peer.key_id, nodeA.discovery.public_key.key_id);
    });

    let publishedPostId;
    let firstReshare;
    let firstOutboxItem;

    await t.test('a local post and re-letter are signed on node A and auto-enqueued through the hook', async () => {
      const published = await jsonRequest(nodeA.baseUrl, '/api/v1/posts', {
        method: 'POST',
        token: nodeA.token,
        body: {
          title: 'Federated origin dispatch',
          content: 'This letter crosses the mesh with a signed envelope.',
          status: 'publish'
        }
      });
      assert.equal(published.response.status, 201, JSON.stringify(published.data));
      publishedPostId = published.data.post.ID;

      const reshared = await jsonRequest(nodeA.baseUrl, '/api/v1/reshares', {
        method: 'POST',
        token: nodeA.token,
        body: {
          sourcePostId: publishedPostId,
          curatorCommentary: 'Node A curates this dispatch for node B.'
        }
      });
      assert.equal(reshared.response.status, 201, JSON.stringify(reshared.data));
      firstReshare = reshared.data.reshare;
      assert.equal(firstReshare.signature, null);
      assert.ok(firstReshare.envelope_hash);
      assert.ok(firstReshare.envelope_signature);

      const outbox = await jsonRequest(
        nodeA.baseUrl,
        '/api/v1/federation/outbox?include_payload=1',
        { token: nodeA.token }
      );
      assert.equal(outbox.response.status, 200);
      assert.equal(outbox.data.items.length, 1);
      firstOutboxItem = outbox.data.items[0];
      assert.equal(firstOutboxItem.status, 'pending');
      assert.equal(firstOutboxItem.peer_id, 1);
      assert.equal(firstOutboxItem.payload.spec, federation.DELIVERY_SPEC);
      assert.equal(firstOutboxItem.payload.envelope_hash, firstReshare.envelope_hash);
      assert.equal(firstOutboxItem.payload.key_id, nodeA.discovery.public_key.key_id);
      assert.equal(firstOutboxItem.payload.envelope.signing_node.handle, nodeA.discovery.node_handle);
      assert.equal(firstOutboxItem.payload.signature, firstReshare.envelope_signature);
    });

    await t.test('manual process delivers to node B and node B retains the signed chain', async () => {
      const processed = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/process', {
        method: 'POST',
        token: nodeA.token,
        body: {}
      });
      assert.equal(processed.response.status, 200, JSON.stringify(processed.data));
      assert.equal(processed.data.delivered, 1);

      const inbox = await jsonRequest(
        nodeB.baseUrl,
        '/api/v1/federation/inbox?include_payload=1',
        { token: nodeB.token }
      );
      assert.equal(inbox.response.status, 200);
      assert.equal(inbox.data.status.accepted, 1);
      const accepted = inbox.data.items.find(item => item.envelope_hash === firstReshare.envelope_hash);
      assert.ok(accepted);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.source_node, nodeA.discovery.node_handle);
      assert.equal(accepted.key_id, nodeA.discovery.public_key.key_id);
      assert.equal(accepted.local_post_created, false);
      assert.equal(accepted.parent_envelope_hash, null);
      assert.equal(accepted.payload.envelope.provenance_chain.length, 2);
      assert.equal(accepted.payload.envelope.curator.commentary,
        'Node A curates this dispatch for node B.');

      const status = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/status', {
        token: nodeB.token
      });
      assert.equal(status.response.status, 200);
      assert.equal(status.data.inbox.accepted, 1);
      assert.equal(status.data.limitations.remote_post_creation, false);
      assert.equal(status.data.limitations.remote_key_discovery, false);

      const posts = await jsonRequest(nodeB.baseUrl, '/api/v1/posts?status=all', {
        token: nodeB.token
      });
      assert.equal(posts.response.status, 200);
      assert.equal(posts.data.posts.length, 0, 'the inbox must not fabricate local posts');
    });

    await t.test('superadmin inbox exposes promotion state and the public remote exchange starts empty', async () => {
      const publicRemote = await jsonRequest(nodeB.baseUrl, '/api/v1/remote?limit=5&offset=0');
      assert.equal(publicRemote.response.status, 200, JSON.stringify(publicRemote.data));
      assert.deepEqual(publicRemote.data.remote, []);
      assert.equal(publicRemote.data.total, 0);
      assert.equal(publicRemote.data.limit, 5);
      assert.equal(publicRemote.data.offset, 0);
      assert.equal(publicRemote.response.headers.get('cache-control'), 'no-store');

      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      assert.equal(inbox.response.status, 200);
      const accepted = inbox.data.items.find(item => item.envelope_hash === firstReshare.envelope_hash);
      assert.ok(accepted);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.remote_post_id, null);
      assert.equal(accepted.remote_status, null);
      assert.equal(accepted.promoted_at, null);

      const unauthenticated = await jsonRequest(
        nodeB.baseUrl,
        `/api/v1/federation/inbox/${accepted.inbox_id}/status`,
        { method: 'POST', body: { status: 'promoted' } }
      );
      assert.equal(unauthenticated.response.status, 401);

      const badStatus = await jsonRequest(
        nodeB.baseUrl,
        `/api/v1/federation/inbox/${accepted.inbox_id}/status`,
        { method: 'POST', token: nodeB.token, body: { status: 'accepted' } }
      );
      assert.equal(badStatus.response.status, 400);

      const badId = await jsonRequest(
        nodeB.baseUrl,
        '/api/v1/federation/inbox/not-a-number/status',
        { method: 'POST', token: nodeB.token, body: { status: 'promoted' } }
      );
      assert.equal(badId.response.status, 400);

      const missingId = await jsonRequest(
        nodeB.baseUrl,
        '/api/v1/federation/inbox/999999/status',
        { method: 'POST', token: nodeB.token, body: { status: 'promoted' } }
      );
      assert.equal(missingId.response.status, 404);

      const unknownRemoteChild = await jsonRequest(nodeB.baseUrl, '/api/v1/remote/not-a-route');
      assert.equal(unknownRemoteChild.response.status, 404);
      assert.equal(unknownRemoteChild.data.error, 'API endpoint not found.');

      const wrongMethod = await jsonRequest(nodeB.baseUrl, '/api/v1/remote', { method: 'POST', body: {} });
      assert.equal(wrongMethod.response.status, 404);
      assert.equal(wrongMethod.data.error, 'API endpoint not found.');
    });

    await t.test('promoting one accepted envelope publishes only safe fields and creates no local post', async () => {
      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      const accepted = inbox.data.items.find(item => item.envelope_hash === firstReshare.envelope_hash);
      assert.ok(accepted);

      const promoted = await jsonRequest(
        nodeB.baseUrl,
        `/api/v1/federation/inbox/${accepted.inbox_id}/status`,
        { method: 'POST', token: nodeB.token, body: { status: 'promoted' } }
      );
      assert.equal(promoted.response.status, 200, JSON.stringify(promoted.data));
      assert.equal(promoted.data.item.status, 'promoted');
      assert.equal(promoted.data.item.inbox_id, accepted.inbox_id);
      assert.equal(promoted.data.item.envelope_hash, firstReshare.envelope_hash);
      assert.match(promoted.data.item.remote_post_id, /^rpost_[a-f0-9]{32}$/);
      assert.equal(promoted.data.item.source_node, 'deadplug://local');
      assert.equal(promoted.data.item.chain_length, 2);
      assert.equal(promoted.data.item.parent_envelope_hash, null);
      assert.equal(promoted.data.item.verification.scope, 'peer-ed25519-at-receipt');
      assert.equal(promoted.data.item.verification.peer_registered, true);
      assert.equal(promoted.data.item.verification.peer_enabled, true);
      assert.equal(promoted.data.item.verification.key_id, nodeA.discovery.public_key.key_id);
      const remotePostId = promoted.data.item.remote_post_id;

      const duplicate = await jsonRequest(
        nodeB.baseUrl,
        `/api/v1/federation/inbox/${accepted.inbox_id}/status`,
        { method: 'POST', token: nodeB.token, body: { status: 'promoted' } }
      );
      assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.data));
      assert.equal(duplicate.data.item.remote_post_id, remotePostId);
      assert.equal(duplicate.data.item.promoted_at, promoted.data.item.promoted_at);

      const publicRemote = await jsonRequest(nodeB.baseUrl, '/api/v1/remote');
      assert.equal(publicRemote.response.status, 200, JSON.stringify(publicRemote.data));
      assert.equal(publicRemote.data.total, 1);
      assert.equal(publicRemote.data.remote.length, 1);
      const item = publicRemote.data.remote[0];
      assert.equal(item.remote_post_id, remotePostId);
      assert.equal(item.inbox_id, accepted.inbox_id);
      assert.equal(item.envelope_hash, firstReshare.envelope_hash);
      assert.equal(item.source_node, 'deadplug://local');
      assert.equal(item.signing_node_handle, nodeA.discovery.node_handle);
      assert.equal(item.signing_node.handle, nodeA.discovery.node_handle);
      assert.equal(item.source_title, 'Federated origin dispatch');
      assert.equal(item.source_excerpt.length > 0, true);
      assert.equal(item.curator_commentary, 'Node A curates this dispatch for node B.');
      assert.equal(item.chain_length, 2);
      assert.equal(item.provenance_chain.length, 2);
      assert.equal(item.parent_envelope_hash, null);
      assert.equal(item.key_id, nodeA.discovery.public_key.key_id);
      assert.equal(item.verification.peer_registered, true);
      assert.equal(item.verification.peer_enabled, true);
      assert.equal(Object.hasOwn(item, 'status'), false);
      for (const forbidden of ['delivery_id', 'payload', 'reason', 'last_error',
        'source_peer_id', 'promoted_by', 'local_post_id', 'email']) {
        assert.equal(Object.hasOwn(item, forbidden), false, forbidden);
      }
      assert.doesNotMatch(JSON.stringify(publicRemote.data),
        /delivery_id|payload_json|local_post_id|last_error|source_peer_id|promoted_by|@example\.test/);

      const posts = await jsonRequest(nodeB.baseUrl, '/api/v1/posts?status=all', {
        token: nodeB.token
      });
      assert.equal(posts.response.status, 200);
      assert.equal(posts.data.posts.length, 0, 'promotion must not create a local post');

      const audited = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      const promotedAudit = audited.data.items.find(row => row.inbox_id === accepted.inbox_id);
      assert.equal(promotedAudit.status, 'accepted');
      assert.equal(promotedAudit.remote_status, 'promoted');
      assert.equal(promotedAudit.remote_post_id, remotePostId);
      assert.ok(promotedAudit.promoted_at);
      assert.ok(promotedAudit.promoted_by);
    });

    await t.test('hide, re-promote, and remove change visibility while retaining inbox audit', async () => {
      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      const accepted = inbox.data.items.find(item => item.envelope_hash === firstReshare.envelope_hash);
      assert.ok(accepted);
      const statusPath = `/api/v1/federation/inbox/${accepted.inbox_id}/status`;

      const hidden = await jsonRequest(nodeB.baseUrl, statusPath, {
        method: 'POST',
        token: nodeB.token,
        body: { status: 'hidden' }
      });
      assert.equal(hidden.response.status, 200, JSON.stringify(hidden.data));
      assert.equal(hidden.data.item.status, 'hidden');

      const hiddenPublic = await jsonRequest(nodeB.baseUrl, '/api/v1/remote');
      assert.equal(hiddenPublic.data.total, 0);
      assert.deepEqual(hiddenPublic.data.remote, []);
      const hiddenAudit = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      const hiddenRow = hiddenAudit.data.items.find(row => row.inbox_id === accepted.inbox_id);
      assert.equal(hiddenRow.status, 'accepted');
      assert.equal(hiddenRow.remote_status, 'hidden');
      assert.ok(hiddenRow.promoted_at, 'hide preserves promotion audit');

      const repromoted = await jsonRequest(nodeB.baseUrl, statusPath, {
        method: 'POST',
        token: nodeB.token,
        body: { status: 'promoted' }
      });
      assert.equal(repromoted.response.status, 200, JSON.stringify(repromoted.data));
      assert.equal(repromoted.data.item.status, 'promoted');
      assert.equal(
        (await jsonRequest(nodeB.baseUrl, '/api/v1/remote')).data.total,
        1,
        're-promotion restores public visibility'
      );

      const removed = await jsonRequest(nodeB.baseUrl, statusPath, {
        method: 'POST',
        token: nodeB.token,
        body: { status: 'removed' }
      });
      assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
      assert.equal(removed.data.item.status, 'removed');

      const removedPublic = await jsonRequest(nodeB.baseUrl, '/api/v1/remote');
      assert.equal(removedPublic.data.total, 0);
      assert.deepEqual(removedPublic.data.remote, []);
      const removedAudit = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      const removedRow = removedAudit.data.items.find(row => row.inbox_id === accepted.inbox_id);
      assert.equal(removedRow.status, 'accepted', 'removal preserves the inbox audit row');
      assert.equal(removedRow.remote_status, 'removed');
      assert.equal(removedRow.remote_post_id, accepted.remote_post_id);
      assert.ok(removedRow.remote_post_id);

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=not-a-number',
        '?offset=-1',
        `?offset=${federation.MAX_REMOTE_OFFSET + 1}`
      ]) {
        const invalid = await jsonRequest(nodeB.baseUrl, `/api/v1/remote${query}`);
        assert.equal(invalid.response.status, 400, query);
        assert.match(invalid.data.error, /(?:limit|offset)/i);
      }

      const bounded = await jsonRequest(nodeB.baseUrl, '/api/v1/remote?limit=1&offset=0');
      assert.equal(bounded.response.status, 200);
      assert.equal(bounded.data.limit, 1);
      assert.equal(bounded.data.offset, 0);
      assert.equal(bounded.data.total, 0);
    });

    let secondReshare;
    let secondOutboxItem;

    await t.test('a second-generation re-letter preserves and reports local parent presence', async () => {
      const reshared = await jsonRequest(nodeA.baseUrl, '/api/v1/reshares', {
        method: 'POST',
        token: nodeA.token,
        body: {
          sourcePostId: firstReshare.id,
          curatorCommentary: 'Node A re-letters its own re-letter.'
        }
      });
      assert.equal(reshared.response.status, 201, JSON.stringify(reshared.data));
      secondReshare = reshared.data.reshare;
      assert.equal(secondReshare.parent_envelope_hash, firstReshare.envelope_hash);

      const outbox = await jsonRequest(
        nodeA.baseUrl,
        '/api/v1/federation/outbox?include_payload=1',
        { token: nodeA.token }
      );
      secondOutboxItem = outbox.data.items.find(
        item => item.envelope_hash === secondReshare.envelope_hash
      );
      assert.ok(secondOutboxItem);

      // Deliver the exact queued payload manually first so the 202 response can
      // prove the parent hash is known locally from the earlier accepted row.
      const delivered = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: secondOutboxItem.payload
      });
      assert.equal(delivered.response.status, 202, JSON.stringify(delivered.data));
      assert.equal(delivered.data.status, 'accepted');
      assert.equal(delivered.data.parent_envelope_hash, firstReshare.envelope_hash);
      assert.equal(delivered.data.parent_envelope_known_locally, true);
      assert.equal(delivered.data.parent_verification_scope, 'local-presence-only');
      assert.equal(delivered.data.provenance_chain.length, 3);
    });

    await t.test('duplicate delivery ids and duplicate envelopes are idempotent', async () => {
      const duplicateById = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: secondOutboxItem.payload
      });
      assert.equal(duplicateById.response.status, 200);
      assert.equal(duplicateById.data.status, 'duplicate');
      assert.equal(duplicateById.data.duplicate_by, 'delivery_id');

      const duplicateByEnvelope = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: {
          ...secondOutboxItem.payload,
          delivery_id: `duplicate_envelope_${crypto.randomBytes(4).toString('hex')}`
        }
      });
      assert.equal(duplicateByEnvelope.response.status, 200);
      assert.equal(duplicateByEnvelope.data.status, 'duplicate');
      assert.equal(duplicateByEnvelope.data.duplicate_by, 'envelope_hash');

      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      assert.equal(inbox.data.status.accepted, 2);

      const processed = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/process', {
        method: 'POST',
        token: nodeA.token,
        body: { force: true }
      });
      assert.equal(processed.response.status, 200);
      assert.equal(processed.data.delivered, 1, 'the worker treats the replay as successful');

      const outbox = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox', {
        token: nodeA.token
      });
      assert.equal(
        outbox.data.items.find(item => item.envelope_hash === secondReshare.envelope_hash).status,
        'delivered'
      );
    });

    await t.test('tampered commentary and a wrong claimed hash are rejected and audited', async () => {
      const before = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });

      const tampered = JSON.parse(JSON.stringify(secondOutboxItem.payload));
      tampered.delivery_id = `tampered_${crypto.randomBytes(4).toString('hex')}`;
      tampered.envelope.curator.commentary = 'Tampered commentary after signing.';
      tampered.envelope_hash = provenance.createEnvelopeHash(tampered.envelope);

      const rejectedTamper = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: tampered
      });
      assert.equal(rejectedTamper.response.status, 401, JSON.stringify(rejectedTamper.data));
      assert.equal(rejectedTamper.data.status, 'rejected');
      assert.match(rejectedTamper.data.error, /signature/i);

      const wrongHash = JSON.parse(JSON.stringify(firstOutboxItem.payload));
      wrongHash.delivery_id = `wrong_hash_${crypto.randomBytes(4).toString('hex')}`;
      wrongHash.envelope_hash = 'A'.repeat(43);
      const rejectedHash = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: wrongHash
      });
      assert.equal(rejectedHash.response.status, 400, JSON.stringify(rejectedHash.data));
      assert.match(rejectedHash.data.error, /hash/i);

      const after = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      assert.equal(after.data.status.rejected, before.data.status.rejected + 2);
      assert.equal(after.data.status.accepted, before.data.status.accepted);

      const rejectedRows = after.data.items.filter(item => item.status === 'rejected');
      assert.equal(rejectedRows.some(item => /signature/i.test(item.reason || '')), true);
      assert.equal(rejectedRows.some(item => /hash/i.test(item.reason || '')), true);
    });

    await t.test('unregistered peers and malformed delivery bodies are rejected', async () => {
      const rogueKey = generatePeerKey();
      const rogue = buildDelivery({
        privateKey: rogueKey.privateKey,
        handle: '@rogue/unregistered',
        keyId: rogueKey.key_id,
        deliveryId: `rogue_${crypto.randomBytes(4).toString('hex')}`
      });
      const rejectedRogue = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: rogue
      });
      assert.equal(rejectedRogue.response.status, 403, JSON.stringify(rejectedRogue.data));
      assert.match(rejectedRogue.data.error, /registered federation peer/i);

      // Registering the peer and replaying the same deterministic delivery id
      // must recover the previously rejected audit row rather than deadlock.
      const registeredRogue = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/peers', {
        method: 'POST',
        token: nodeB.token,
        body: {
          endpoint_url: 'http://127.0.0.1:1',
          node_handle: '@rogue/unregistered',
          public_key: rogueKey.public_key
        }
      });
      assert.equal(registeredRogue.response.status, 201, JSON.stringify(registeredRogue.data));

      const recoveredRogue = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: rogue
      });
      assert.equal(recoveredRogue.response.status, 202, JSON.stringify(recoveredRogue.data));
      assert.equal(recoveredRogue.data.status, 'accepted');
      assert.equal(recoveredRogue.data.promoted_from_rejected, true);
      assert.equal(recoveredRogue.data.delivery_id, rogue.delivery_id);

      const badSpec = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: {
          spec: 'not-the-federation-spec',
          delivery_id: 'bad_spec_delivery',
          sent_at: new Date().toISOString(),
          envelope: {}
        }
      });
      assert.equal(badSpec.response.status, 400);
      assert.equal(badSpec.data.status, 'rejected');

      const wrongContentType = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json'
      });
      assert.equal(wrongContentType.response.status, 415);

      const oversized = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        method: 'POST',
        body: {
          spec: federation.DELIVERY_SPEC,
          delivery_id: 'oversized_delivery',
          sent_at: new Date().toISOString(),
          envelope: {},
          padding: 'x'.repeat(federation.MAX_DELIVERY_BYTES + 1024)
        }
      });
      assert.equal(oversized.response.status, 413);
    });

    await t.test('a failed endpoint retries with backoff and becomes dead after five attempts', async () => {
      const deadPort = await getClosedPort();
      const deadKey = generatePeerKey();
      const registeredDead = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers', {
        method: 'POST',
        token: nodeA.token,
        body: {
          endpoint_url: `http://127.0.0.1:${deadPort}`,
          node_handle: '@test/dead-peer',
          public_key: deadKey.public_key
        }
      });
      assert.equal(registeredDead.response.status, 201, JSON.stringify(registeredDead.data));

      const reshared = await jsonRequest(nodeA.baseUrl, '/api/v1/reshares', {
        method: 'POST',
        token: nodeA.token,
        body: {
          sourcePostId: publishedPostId,
          curatorCommentary: 'This delivery is aimed at a dead endpoint.'
        }
      });
      assert.equal(reshared.response.status, 201, JSON.stringify(reshared.data));
      const deadLetterHash = reshared.data.reshare.envelope_hash;

      let deadItem;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const processed = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/process', {
          method: 'POST',
          token: nodeA.token,
          body: { force: true }
        });
        assert.equal(processed.response.status, 200, JSON.stringify(processed.data));

        const outbox = await jsonRequest(
          nodeA.baseUrl,
          '/api/v1/federation/outbox?include_payload=1',
          { token: nodeA.token }
        );
        deadItem = outbox.data.items.find(item => (
          item.envelope_hash === deadLetterHash && item.node_handle === '@test/dead-peer'
        ));
        assert.ok(deadItem, `dead peer outbox row at attempt ${attempt}`);
        assert.equal(deadItem.attempts, attempt);
        assert.equal(deadItem.status, attempt < 5 ? 'failed' : 'dead');
        if (attempt < 5) {
          assert.equal(deadItem.next_attempt_at > deadItem.updated_at, true, 'backoff must schedule a future retry');
        }
      }

      assert.equal(deadItem.status, 'dead');
      assert.equal(deadItem.attempts, 5);
      assert.ok(deadItem.last_error);
      assert.doesNotMatch(deadItem.last_error, /\n|\bat\s+\S+:\d+:\d+/);
      assert.equal(deadItem.last_error.includes('stack'), false);

      const deliveredToB = await jsonRequest(
        nodeB.baseUrl,
        '/api/v1/federation/inbox?include_payload=1',
        { token: nodeB.token }
      );
      assert.equal(
        deliveredToB.data.items.some(item => (
          item.envelope_hash === deadLetterHash && item.status === 'accepted'
        )),
        true,
        'the healthy peer still receives the same re-letter'
      );
    });

    await t.test('disabling a peer skips the hook and manual enqueue can restore delivery', async () => {
      const peers = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/peers', {
        token: nodeA.token
      });
      const peerB = peers.data.peers.find(peer => peer.node_handle === nodeB.discovery.node_handle);
      assert.ok(peerB);

      const disabled = await jsonRequest(
        nodeA.baseUrl,
        `/api/v1/federation/peers/${peerB.peer_id}`,
        { method: 'PATCH', token: nodeA.token, body: { enabled: false } }
      );
      assert.equal(disabled.response.status, 200);
      assert.equal(disabled.data.peer.enabled, false);

      const reshared = await jsonRequest(nodeA.baseUrl, '/api/v1/reshares', {
        method: 'POST',
        token: nodeA.token,
        body: {
          sourcePostId: publishedPostId,
          curatorCommentary: 'This re-letter is explicitly enqueued after re-enabling a peer.'
        }
      });
      assert.equal(reshared.response.status, 201, JSON.stringify(reshared.data));
      const manualHash = reshared.data.reshare.envelope_hash;

      const outboxWhileDisabled = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox', {
        token: nodeA.token
      });
      assert.equal(
        outboxWhileDisabled.data.items.some(item => (
          item.envelope_hash === manualHash && item.node_handle === nodeB.discovery.node_handle
        )),
        false,
        'a disabled peer must not receive hook-enqueued rows'
      );

      const reenabled = await jsonRequest(
        nodeA.baseUrl,
        `/api/v1/federation/peers/${peerB.peer_id}`,
        { method: 'PATCH', token: nodeA.token, body: { enabled: true } }
      );
      assert.equal(reenabled.response.status, 200);
      assert.equal(reenabled.data.peer.enabled, true);

      const manuallyEnqueued = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/enqueue', {
        method: 'POST',
        token: nodeA.token,
        body: { post_id: reshared.data.reshare.id }
      });
      assert.equal(manuallyEnqueued.response.status, 200, JSON.stringify(manuallyEnqueued.data));
      assert.equal(manuallyEnqueued.data.enqueued, 1);

      const repeatedEnqueue = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/enqueue', {
        method: 'POST',
        token: nodeA.token,
        body: { post_id: reshared.data.reshare.id }
      });
      assert.equal(repeatedEnqueue.response.status, 200);
      assert.equal(repeatedEnqueue.data.enqueued, 0);
      assert.equal(repeatedEnqueue.data.existing, 2);

      const processed = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/outbox/process', {
        method: 'POST',
        token: nodeA.token,
        body: { force: true }
      });
      assert.equal(processed.response.status, 200);

      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      assert.equal(
        inbox.data.items.some(item => (
          item.envelope_hash === manualHash && item.status === 'accepted'
        )),
        true
      );
    });

    await t.test('final status exposes counts without secrets or stack traces', async () => {
      const status = await jsonRequest(nodeA.baseUrl, '/api/v1/federation/status', {
        token: nodeA.token
      });
      assert.equal(status.response.status, 200);
      assert.equal(status.data.peers.total, 2);
      assert.equal(status.data.peers.enabled, 2);
      assert.ok(status.data.outbox.delivered >= 2);
      assert.equal(status.data.outbox.dead >= 1, true);
      assert.equal(status.data.delivery.spec, federation.DELIVERY_SPEC);
      assert.equal(status.data.delivery.max_attempts, 5);
      assert.equal(status.data.delivery.timeout_ms <= 5000, true);
      assert.doesNotMatch(JSON.stringify(status.data), /private_key|stack|\n\s+at\s/i);

      const inbox = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/inbox', {
        token: nodeB.token
      });
      assert.equal(inbox.response.status, 200);
      assert.ok(inbox.data.status.accepted >= 3);
      assert.ok(inbox.data.status.rejected >= 3);
      assert.equal(inbox.data.items.some(item => item.remote_status === 'removed'), true);
      assert.equal(inbox.data.items.some(item => item.remote_post_id), true);
      assert.doesNotMatch(JSON.stringify(inbox.data), /private_key|stack|\n\s+at\s/i);

      const remoteStatus = await jsonRequest(nodeB.baseUrl, '/api/v1/federation/status', {
        token: nodeB.token
      });
      assert.equal(remoteStatus.response.status, 200);
      assert.equal(remoteStatus.data.remote_exchange.promoted, 0);
      assert.equal(remoteStatus.data.remote_exchange.removed, 1);
      assert.equal(remoteStatus.data.remote_exchange.public_count, 0);
      assert.equal(remoteStatus.data.limitations.automatic_remote_promotion, false);
      assert.equal(remoteStatus.data.limitations.cross_node_parent_proof, false);
    });
  } finally {
    await stopNode(nodeA);
    await stopNode(nodeB);
  }
});
