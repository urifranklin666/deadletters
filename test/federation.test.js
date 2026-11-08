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

test('fresh schema and migration 3 expose peers, outbox, inbox, foreign keys, and indexes', () => {
  const memory = new Database(':memory:');
  try {
    memory.exec(schema);
    const tables = new Set(memory.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    for (const required of [
      'dl_federation_peers',
      'dl_federation_outbox',
      'dl_federation_inbox'
    ]) {
      assert.equal(tables.has(required), true, required);
    }

    const outboxForeignKeys = memory.prepare('PRAGMA foreign_key_list(dl_federation_outbox)').all();
    assert.equal(outboxForeignKeys.some(row => row.table === 'dl_federation_peers'), true);
    assert.equal(outboxForeignKeys.some(row => row.table === 'dl_reshares'), true);

    const inboxForeignKeys = memory.prepare('PRAGMA foreign_key_list(dl_federation_inbox)').all();
    assert.equal(inboxForeignKeys.some(row => row.table === 'dl_federation_peers'), true);

    const indexes = new Set(memory.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    ).all().map(row => row.name));
    for (const required of [
      'idx_federation_peers_enabled',
      'idx_federation_outbox_peer',
      'idx_federation_outbox_due',
      'idx_federation_inbox_peer',
      'idx_federation_inbox_accepted_envelope'
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

  assert.deepEqual(
    db.prepare('SELECT version FROM dl_schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2, 3]
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
      assert.doesNotMatch(JSON.stringify(inbox.data), /private_key|stack|\n\s+at\s/i);
    });
  } finally {
    await stopNode(nodeA);
    await stopNode(nodeB);
  }
});
