'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-key-rotation-test-'));
const dbPath = path.join(dataDir, 'rotation.db');

process.env.DEADLETTERS_DATA_DIR = dataDir;
process.env.DEADLETTERS_UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(dataDir, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(dataDir, 'addons');
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'key-rotation-test-secret-that-is-not-used-in-production';
process.env.NODE_ENV = 'test';

const { closeDb, getDb, updateOption } = require('../src/core/db');
const {
  MIN_ROTATION_REASON_LENGTH,
  NODE_KEY_HISTORY_TABLE,
  findPublicNodeKey,
  getDiscoveryDocument,
  getPublicNodeIdentity,
  listRetiredNodeKeys,
  rotateNodeIdentity,
  verifyReshareRecord
} = require('../src/core/provenance');
const { createReshare } = require('../src/core/reshare-engine');

let db;
let userId;
let sourcePostId;
let firstReshareId;
let currentBeforeRotation;
let privateBeforeRotation;

function reloadReshare(postId) {
  return db.prepare('SELECT * FROM dl_reshares WHERE post_id = ?').get(postId);
}

function historyColumns() {
  return db.prepare(`PRAGMA table_info(${NODE_KEY_HISTORY_TABLE})`).all().map(column => column.name);
}

function databaseModes() {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, mode: fs.statSync(file).mode & 0o777 }));
}

function assertOwnerOnly() {
  if (process.platform === 'win32') return;
  for (const { file, mode } of databaseModes()) {
    assert.equal(mode & 0o077, 0, `${path.basename(file)} must remain owner-only`);
  }
}

before(() => {
  db = getDb();
  updateOption('site_node_handle', '@test/rotation-node');
  updateOption('site_url', 'https://rotation.example.test');

  userId = Number(db.prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES ('rotation-curator', 'test-only', 'rotation@example.test', 'Rotation Curator', 'operator')
  `).run().lastInsertRowid);

  sourcePostId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, drop_code
    ) VALUES (?, 'Original rotation source', 'original-rotation-source', 'Original body',
      'Original excerpt', 'publish', 'post', 'ROT-001')
  `).run(userId).lastInsertRowid);
});

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('migration 4 creates a public-only retired-key history and rejects a missing identity', () => {
  const columns = historyColumns();
  for (const required of [
    'node_handle', 'public_key_der', 'key_id', 'algorithm', 'created_at', 'retired_at', 'reason'
  ]) {
    assert.equal(columns.includes(required), true, required);
  }
  assert.equal(columns.includes('private_key_der'), false);
  assert.equal(columns.includes('private_key'), false);

  assert.deepEqual(
    db.prepare('SELECT version FROM dl_schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2, 3, 4, 5]
  );

  assert.equal(getPublicNodeIdentity({ create: false }), null);
  assert.throws(
    () => rotateNodeIdentity({ reason: 'Database disclosure during incident review' }),
    /no local node identity/i
  );
  assert.equal(listRetiredNodeKeys().length, 0);
  assertOwnerOnly();
});

test('a signed reshare verifies under the current key before rotation', () => {
  currentBeforeRotation = getPublicNodeIdentity();
  privateBeforeRotation = db.prepare(
    'SELECT private_key_der FROM dl_node_identity WHERE identity_id = 1'
  ).get().private_key_der;

  const reshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed before the node identity changes.'
  });
  firstReshareId = reshare.id;

  const verification = verifyReshareRecord(reloadReshare(firstReshareId));
  assert.equal(verification.verification_status, 'verified');
  assert.equal(verification.key_id, currentBeforeRotation.key_id);
  assert.equal(verification.key_status, 'current');
  assert.equal(verification.key_retired, false);
  assertOwnerOnly();
});

test('rotation rejects missing, blank, short, and oversized reasons without changing the identity', () => {
  const keyId = getPublicNodeIdentity().key_id;
  const invalidReasons = [
    undefined,
    null,
    '',
    '        ',
    'short',
    'x'.repeat(MIN_ROTATION_REASON_LENGTH - 1)
  ];

  for (const reason of invalidReasons) {
    assert.throws(
      () => rotateNodeIdentity({ reason }),
      /rotation reason/i,
      `expected rejection for ${JSON.stringify(reason)}`
    );
  }
  assert.throws(
    () => rotateNodeIdentity({ reason: 'x'.repeat(501) }),
    /at most/i
  );

  assert.equal(getPublicNodeIdentity().key_id, keyId);
  assert.equal(listRetiredNodeKeys().length, 0);
});

test('rotation archives only the old public key, signs new envelopes with the new key, and keeps old envelopes verifiable', () => {
  const oldIdentity = getPublicNodeIdentity();
  const oldPrivate = db.prepare(
    'SELECT private_key_der FROM dl_node_identity WHERE identity_id = 1'
  ).get().private_key_der;

  const result = rotateNodeIdentity({ reason: '  Suspected local database disclosure  ' });

  assert.equal(result.rotated, true);
  assert.equal(result.reason, 'Suspected local database disclosure');
  assert.equal(result.current.key_id === oldIdentity.key_id, false);
  assert.equal(result.current.handle, '@test/rotation-node');
  assert.equal(result.retired.key_id, oldIdentity.key_id);
  assert.equal(result.retired.public_key, oldIdentity.public_key);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].key_id, oldIdentity.key_id);

  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes('private_key_der'), false);
  assert.equal(serializedResult.includes(oldPrivate), false);
  assert.equal(serializedResult.includes(privateBeforeRotation), false);

  const historyRow = db.prepare('SELECT * FROM dl_node_key_history WHERE key_id = ?')
    .get(oldIdentity.key_id);
  assert.ok(historyRow);
  assert.equal(historyRow.public_key_der, oldIdentity.public_key);
  assert.equal(Object.keys(historyRow).includes('private_key_der'), false);
  assert.equal(JSON.stringify(historyRow).includes(oldPrivate), false);

  const oldVerification = verifyReshareRecord(reloadReshare(firstReshareId));
  assert.equal(oldVerification.verification_status, 'verified');
  assert.equal(oldVerification.valid, true);
  assert.equal(oldVerification.key_id, oldIdentity.key_id);
  assert.equal(oldVerification.key_status, 'retired');
  assert.equal(oldVerification.key_retired, true);
  assert.equal(oldVerification.key_retired_at, result.retired.retired_at);
  assert.equal(oldVerification.key_retirement_reason, result.reason);
  assert.match(oldVerification.reason, /retired/i);

  const newReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed after the node identity changed.'
  });
  const newVerification = verifyReshareRecord(reloadReshare(newReshare.id));
  assert.equal(newVerification.verification_status, 'verified');
  assert.equal(newVerification.key_id, result.current.key_id);
  assert.equal(newVerification.key_id === oldIdentity.key_id, false);
  assert.equal(newVerification.key_status, 'current');
  assert.equal(newVerification.key_retired, false);

  const discovery = getDiscoveryDocument();
  assert.equal(discovery.public_key.key_id, result.current.key_id);
  const serializedDiscovery = JSON.stringify(discovery);
  assert.equal(serializedDiscovery.includes(oldIdentity.key_id), false);
  assert.equal(serializedDiscovery.includes(oldIdentity.public_key), false);
  assert.equal(serializedDiscovery.includes(oldPrivate), false);

  assertOwnerOnly();
});

test('multiple rotations retain a lookupable public history for every retired key', () => {
  const historyAfterFirstRotation = listRetiredNodeKeys();
  const firstRetiredKeyId = historyAfterFirstRotation[0].key_id;
  const midIdentity = getPublicNodeIdentity();

  const midReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed under the middle key.'
  });

  const secondRotation = rotateNodeIdentity({ reason: 'Scheduled signing-key hygiene rotation' });
  const keys = listRetiredNodeKeys();

  assert.equal(keys.length, 2);
  assert.deepEqual(keys.map(entry => entry.key_id), [firstRetiredKeyId, midIdentity.key_id]);
  assert.equal(secondRotation.current.key_id === midIdentity.key_id, false);

  for (const entry of keys) {
    assert.equal(Object.hasOwn(entry, 'private_key_der'), false);
    assert.equal(Object.hasOwn(entry, 'private_key'), false);
    assert.equal(entry.key_status, 'retired');
  }

  assert.equal(verifyReshareRecord(reloadReshare(firstReshareId)).verification_status, 'verified');
  assert.equal(verifyReshareRecord(reloadReshare(firstReshareId)).key_id, firstRetiredKeyId);
  assert.equal(verifyReshareRecord(reloadReshare(midReshare.id)).verification_status, 'verified');
  assert.equal(verifyReshareRecord(reloadReshare(midReshare.id)).key_id, midIdentity.key_id);

  const currentKey = getPublicNodeIdentity();
  const lookupFirst = findPublicNodeKey(firstRetiredKeyId);
  const lookupMid = findPublicNodeKey(midIdentity.key_id);
  const lookupCurrent = findPublicNodeKey(currentKey.key_id);
  assert.equal(lookupFirst.key_status, 'retired');
  assert.equal(lookupFirst.public_key, historyAfterFirstRotation[0].public_key);
  assert.equal(lookupMid.key_status, 'retired');
  assert.equal(lookupCurrent.key_status, 'current');
  assert.equal(findPublicNodeKey('ed25519-unknown-key'), null);

  const latestReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed under the newest key.'
  });
  const latestVerification = verifyReshareRecord(reloadReshare(latestReshare.id));
  assert.equal(latestVerification.verification_status, 'verified');
  assert.equal(latestVerification.key_id, currentKey.key_id);
  assert.equal(latestVerification.key_retired, false);

  const oldRow = reloadReshare(firstReshareId);
  const invalidSignature = verifyReshareRecord({
    ...oldRow,
    envelope_signature: 'A'.repeat(86)
  });
  assert.equal(invalidSignature.verification_status, 'invalid');
  assert.equal(invalidSignature.key_retired, true);

  const unknownKey = verifyReshareRecord({
    ...oldRow,
    signing_key_id: 'ed25519-does-not-exist'
  });
  assert.equal(unknownKey.verification_status, 'unverified');
  assert.equal(unknownKey.key_status, 'unknown');

  assertOwnerOnly();
});

test('a duplicate key id in retired history is rejected without rotating', () => {
  const current = getPublicNodeIdentity();
  const currentRow = db.prepare(
    'SELECT node_handle, public_key_der, key_id, algorithm, created_at FROM dl_node_identity WHERE identity_id = 1'
  ).get();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO dl_node_key_history (
      node_handle, public_key_der, key_id, algorithm, created_at, retired_at, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    currentRow.node_handle,
    currentRow.public_key_der,
    currentRow.key_id,
    currentRow.algorithm,
    currentRow.created_at,
    now,
    'Synthetic duplicate-key collision for the test.'
  );

  assert.throws(
    () => rotateNodeIdentity({ reason: 'This rotation must not happen' }),
    /already exists|duplicate/i
  );
  assert.equal(getPublicNodeIdentity().key_id, current.key_id);

  db.prepare('DELETE FROM dl_node_key_history WHERE key_id = ?').run(current.key_id);
  assert.equal(listRetiredNodeKeys().length, 2);
});

test('CLI requires a reason and rotates through a clean process exit without printing private keys', () => {
  const environment = {
    ...process.env,
    DEADLETTERS_DATA_DIR: dataDir,
    DEADLETTERS_UPLOADS_DIR: path.join(dataDir, 'uploads'),
    DEADLETTERS_THEMES_DIR: path.join(dataDir, 'themes'),
    DEADLETTERS_ADDONS_DIR: path.join(dataDir, 'addons'),
    DB_PATH: dbPath,
    NODE_ENV: 'test'
  };

  const missingReason = spawnSync(
    process.execPath,
    ['bin/deadletters.js', 'rotate-node-key'],
    { cwd: projectRoot, env: environment, encoding: 'utf8', timeout: 30000 }
  );
  assert.notEqual(missingReason.status, 0);
  assert.match(`${missingReason.stdout}${missingReason.stderr}`, /--reason/i);

  const preCliReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed before the CLI rotation.'
  });
  const preCliIdentity = getPublicNodeIdentity();
  const preCliPrivate = db.prepare(
    'SELECT private_key_der FROM dl_node_identity WHERE identity_id = 1'
  ).get().private_key_der;

  closeDb();
  db = null;

  const rotated = spawnSync(
    process.execPath,
    ['bin/deadletters.js', 'rotate-node-key', '--reason', 'Manual CLI rotation after operator review'],
    { cwd: projectRoot, env: environment, encoding: 'utf8', timeout: 30000 }
  );

  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stdout, /node identity rotated/i);
  assert.match(rotated.stdout, /Peers must re-register/i);
  assert.match(rotated.stdout, /Snapshots made before this rotation/i);
  assert.match(rotated.stdout, /No private key material/i);
  assert.match(rotated.stdout, /Re-register the new public key/i);
  assert.equal(rotated.stdout.includes(preCliPrivate), false);
  assert.equal(rotated.stdout.includes(privateBeforeRotation), false);
  assert.equal(rotated.stdout.includes('PRIVATE KEY'), false);

  db = getDb();
  const postCliIdentity = getPublicNodeIdentity();
  assert.equal(postCliIdentity.key_id === preCliIdentity.key_id, false);
  assert.equal(listRetiredNodeKeys().length, 3);

  const preCliVerification = verifyReshareRecord(reloadReshare(preCliReshare.id));
  assert.equal(preCliVerification.verification_status, 'verified');
  assert.equal(preCliVerification.key_id, preCliIdentity.key_id);
  assert.equal(preCliVerification.key_retired, true);

  const oldVerification = verifyReshareRecord(reloadReshare(firstReshareId));
  assert.equal(oldVerification.verification_status, 'verified');
  assert.equal(oldVerification.key_retired, true);

  const postCliReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed after the CLI rotation.'
  });
  const postCliVerification = verifyReshareRecord(reloadReshare(postCliReshare.id));
  assert.equal(postCliVerification.verification_status, 'verified');
  assert.equal(postCliVerification.key_id, postCliIdentity.key_id);
  assert.equal(postCliVerification.key_retired, false);

  assertOwnerOnly();
});
