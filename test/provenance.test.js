'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-provenance-test-'));
process.env.DEADLETTERS_DATA_DIR = dataDir;
process.env.DEADLETTERS_UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(dataDir, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(dataDir, 'addons');
process.env.DB_PATH = path.join(dataDir, 'provenance.db');
process.env.JWT_SECRET = 'provenance-test-secret-that-is-not-used-in-production';
process.env.NODE_ENV = 'test';

const { closeDb, getDb, getOption, updateOption } = require('../src/core/db');
const {
  ENVELOPE_TYPE,
  PROTOCOL_SPEC,
  SIGNATURE_ALGORITHM,
  VERIFICATION_SCOPE,
  canonicalJson,
  createEnvelopeHash,
  createSignedEnvelope,
  getDiscoveryDocument,
  getPublicNodeIdentity,
  signEnvelope,
  verifyEnvelopeSignature,
  verifyReshareRecord
} = require('../src/core/provenance');
const {
  createReshare,
  generateSignature,
  getSignaturePayload
} = require('../src/core/reshare-engine');

let db;
let userId;
let sourcePostId;
let firstReshare;
let firstRow;

function reloadReshare(postId) {
  return db.prepare('SELECT * FROM dl_reshares WHERE post_id = ?').get(postId);
}

function restoreRow(row) {
  db.prepare(`
    UPDATE dl_reshares SET
      source_url = ?, source_node = ?, original_author = ?, original_title = ?,
      original_excerpt = ?, curator_commentary = ?, provenance_chain = ?,
      envelope_json = ?, envelope_hash = ?, envelope_signature = ?,
      signature_algorithm = ?, signing_key_id = ?, parent_envelope_hash = ?, signed_at = ?
    WHERE reshare_id = ?
  `).run(
    row.source_url, row.source_node, row.original_author, row.original_title,
    row.original_excerpt, row.curator_commentary, row.provenance_chain,
    row.envelope_json, row.envelope_hash, row.envelope_signature,
    row.signature_algorithm, row.signing_key_id, row.parent_envelope_hash,
    row.signed_at, row.reshare_id
  );
}

before(() => {
  db = getDb();
  updateOption('site_node_handle', '@test/provenance-node');
  updateOption('site_url', 'https://letters.example.test');

  userId = Number(db.prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES ('provenance-curator', 'test-only', 'provenance@example.test', 'Provenance Curator', 'operator')
  `).run().lastInsertRowid);

  sourcePostId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, drop_code
    ) VALUES (?, 'Original dispatch', 'original-dispatch', 'Original body', 'Original excerpt',
      'publish', 'post', 'PROV-001')
  `).run(userId).lastInsertRowid);

  firstReshare = createReshare({
    userId,
    sourcePostId,
    curatorCommentary: 'Signed curator commentary.'
  });
  firstRow = reloadReshare(firstReshare.id);
});

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('canonical JSON sorts keys recursively, preserves arrays, and rejects unsupported values', () => {
  const canonical = canonicalJson({
    z: 1,
    a: {
      d: [3, { b: 2, a: 1 }],
      c: null
    },
    list: ['first', 'second']
  });

  assert.equal(
    canonical,
    '{"a":{"c":null,"d":[3,{"a":1,"b":2}]},"list":["first","second"],"z":1}'
  );
  assert.equal(canonicalJson(JSON.parse(canonical)), canonical, 're-serialization must be deterministic');
  assert.equal(
    canonicalJson({ b: 2, a: 1 }),
    canonicalJson({ a: 1, b: 2 }),
    'insertion order must not matter'
  );
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]', 'array order must be preserved');

  for (const value of [NaN, Infinity, -Infinity, undefined, () => {}, 1n, new Date(), Symbol('x')]) {
    assert.throws(() => canonicalJson({ value }), /canonical json/i);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic/i);
});

test('Ed25519 signing and verification round-trip over exact canonical bytes', () => {
  const identity = getPublicNodeIdentity();
  assert.equal(identity.algorithm, SIGNATURE_ALGORITHM);
  assert.equal(identity.handle, '@test/provenance-node');
  assert.equal(identity.public_key_url, 'https://letters.example.test/.well-known/deadletters.json');
  assert.equal(Object.hasOwn(identity, 'private_key'), false);

  const envelope = {
    type: ENVELOPE_TYPE,
    spec: PROTOCOL_SPEC,
    source: {
      url: 'https://origin.example.test/letter',
      node: 'https://origin.example.test',
      author: 'Origin Author',
      title: 'Origin Title',
      excerpt: 'Origin excerpt'
    },
    curator: { id: userId, commentary: 'A signed note.' },
    created_at: '2026-11-08T00:00:00.000Z',
    signing_node: { handle: identity.handle, key_id: identity.key_id },
    parent_envelope_hash: null,
    provenance_chain: [{ action: 'original_drop', author: 'Origin Author' }]
  };

  const signed = signEnvelope(envelope);
  assert.equal(signed.envelope_json, canonicalJson(envelope));
  assert.equal(signed.envelope_hash, createEnvelopeHash(envelope));
  assert.equal(signed.signature_algorithm, SIGNATURE_ALGORITHM);
  assert.equal(signed.signing_key_id, identity.key_id);
  assert.equal(verifyEnvelopeSignature(envelope, signed.envelope_signature, identity.public_key), true);

  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.curator.commentary = 'A different note.';
  assert.equal(verifyEnvelopeSignature(tampered, signed.envelope_signature, identity.public_key), false);
});

test('migration 2 creates the identity and envelope columns, and the database is owner-only', () => {
  const reshareColumns = db.prepare('PRAGMA table_info(dl_reshares)').all().map(column => column.name);
  for (const required of [
    'envelope_json', 'envelope_hash', 'envelope_signature', 'signature_algorithm',
    'signing_key_id', 'parent_envelope_hash', 'signed_at'
  ]) {
    assert.equal(reshareColumns.includes(required), true, required);
  }

  const identityColumns = db.prepare('PRAGMA table_info(dl_node_identity)').all().map(column => column.name);
  for (const required of [
    'node_handle', 'public_key_der', 'private_key_der', 'key_id', 'algorithm', 'created_at'
  ]) {
    assert.equal(identityColumns.includes(required), true, required);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_node_identity').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT version FROM dl_schema_migrations ORDER BY version').all().map(row => row.version),
    [1, 2, 3, 4, 5]
  );

  if (process.platform !== 'win32') {
    for (const file of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) {
      if (!fs.existsSync(file)) continue;
      assert.equal(fs.statSync(file).mode & 0o077, 0, `${path.basename(file)} must be owner-only`);
    }
  }
});

test('new reshares are Ed25519-signed, not HMAC-signed, and verify against the local node', () => {
  assert.equal(firstRow.signature, null, 'new rows must not store a legacy HMAC signature');
  assert.equal(firstRow.signature_algorithm, SIGNATURE_ALGORITHM);
  assert.ok(firstRow.envelope_json);
  assert.ok(firstRow.envelope_hash);
  assert.ok(firstRow.envelope_signature);
  assert.equal(firstRow.signed_at, JSON.parse(firstRow.envelope_json).created_at);

  const verification = verifyReshareRecord(firstRow);
  assert.equal(verification.verification_status, 'verified');
  assert.equal(verification.verification_scope, VERIFICATION_SCOPE);
  assert.equal(verification.hash_valid, true);
  assert.equal(verification.signature_valid, true);
  assert.equal(verification.key_id, firstRow.signing_key_id);
  assert.equal(verification.envelope_hash, firstRow.envelope_hash);
  assert.equal(verification.public_key_url, 'https://letters.example.test/.well-known/deadletters.json');

  const envelope = JSON.parse(firstRow.envelope_json);
  assert.equal(envelope.source.url, firstRow.source_url);
  assert.equal(envelope.source.author, firstRow.original_author);
  assert.equal(envelope.curator.commentary, firstRow.curator_commentary);
  assert.deepEqual(envelope.provenance_chain, JSON.parse(firstRow.provenance_chain));
});

test('tampered source, commentary, chain, and hash are reported invalid', async t => {
  const tamperedRows = [
    ['commentary', row => {
      db.prepare('UPDATE dl_reshares SET curator_commentary = ? WHERE reshare_id = ?')
        .run('Tampered commentary', row.reshare_id);
    }],
    ['source fields', row => {
      db.prepare('UPDATE dl_reshares SET source_url = ? WHERE reshare_id = ?')
        .run('https://tampered.example.test/letter', row.reshare_id);
    }],
    ['chain', row => {
      const chain = JSON.parse(row.provenance_chain);
      chain[0].author = 'Tampered Author';
      db.prepare('UPDATE dl_reshares SET provenance_chain = ? WHERE reshare_id = ?')
        .run(JSON.stringify(chain), row.reshare_id);
    }],
    ['canonical hash', row => {
      db.prepare('UPDATE dl_reshares SET envelope_hash = ? WHERE reshare_id = ?')
        .run('A'.repeat(43), row.reshare_id);
    }]
  ];

  for (const [label, tamper] of tamperedRows) {
    await t.test(label, () => {
      const row = reloadReshare(firstReshare.id);
      try {
        tamper(row);
        const verification = verifyReshareRecord(reloadReshare(firstReshare.id));
        assert.equal(verification.verification_status, 'invalid', label);
        assert.equal(verification.valid, false, label);
        assert.equal(
          verification.hash_valid,
          label !== 'canonical hash',
          `${label}: the stored envelope hash itself is only altered by the hash tamper`
        );
      } finally {
        restoreRow(row);
      }
    });
  }

  assert.equal(verifyReshareRecord(reloadReshare(firstReshare.id)).verification_status, 'verified');
});

test('missing or unknown signing keys are unverified rather than valid', () => {
  const row = reloadReshare(firstReshare.id);
  try {
    db.prepare('UPDATE dl_reshares SET signing_key_id = ? WHERE reshare_id = ?')
      .run('ed25519-unknown-key', row.reshare_id);
    let verification = verifyReshareRecord(reloadReshare(firstReshare.id));
    assert.equal(verification.verification_status, 'unverified');
    assert.equal(verification.valid, false);
    assert.match(verification.reason, /unknown signing key/i);

    db.prepare('UPDATE dl_reshares SET signing_key_id = NULL WHERE reshare_id = ?').run(row.reshare_id);
    verification = verifyReshareRecord(reloadReshare(firstReshare.id));
    assert.equal(verification.verification_status, 'unverified');
    assert.equal(verification.valid, false);
    assert.match(verification.reason, /missing/i);
  } finally {
    restoreRow(row);
  }

  assert.equal(verifyReshareRecord(reloadReshare(firstReshare.id)).verification_status, 'verified');
});

test('re-lettering preserves source metadata, the full chain, and the parent envelope hash', () => {
  const parent = reloadReshare(firstReshare.id);
  const parentEnvelope = JSON.parse(parent.envelope_json);
  const parentChain = JSON.parse(parent.provenance_chain);

  const secondReshare = createReshare({
    userId,
    sourcePostId: firstReshare.id,
    curatorCommentary: 'A second-generation note.'
  });
  const child = reloadReshare(secondReshare.id);
  const childEnvelope = JSON.parse(child.envelope_json);
  const childChain = JSON.parse(child.provenance_chain);

  assert.equal(child.source_url, parent.source_url);
  assert.equal(child.source_node, parent.source_node);
  assert.equal(child.original_author, parent.original_author);
  assert.equal(child.original_title, parent.original_title);
  assert.equal(child.original_excerpt, parent.original_excerpt);
  assert.equal(child.parent_envelope_hash, parent.envelope_hash);
  assert.equal(childEnvelope.parent_envelope_hash, parent.envelope_hash);
  assert.equal(childChain.length, parentChain.length + 1);
  assert.deepEqual(childChain.slice(0, parentChain.length), parentChain);
  assert.equal(childEnvelope.source.url, parentEnvelope.source.url);
  assert.equal(childEnvelope.source.author, parentEnvelope.source.author);
  assert.equal(childEnvelope.source.title, parentEnvelope.source.title);
  assert.equal(childEnvelope.source.local_post_id, parentEnvelope.source.local_post_id);

  const verification = verifyReshareRecord(child);
  assert.equal(verification.verification_status, 'verified');
  assert.equal(verification.parent_envelope_hash, parent.envelope_hash);
});

test('discovery exposes only the Ed25519 public identity', () => {
  const identity = getPublicNodeIdentity();
  const document = getDiscoveryDocument();
  const serialized = JSON.stringify(document);

  assert.equal(document.spec, PROTOCOL_SPEC);
  assert.equal(document.protocol, 'deadletters-provenance/1');
  assert.equal(document.node, '@test/provenance-node');
  assert.equal(document.node_handle, '@test/provenance-node');
  assert.equal(document.site_url, 'https://letters.example.test');
  assert.equal(document.public_key.algorithm, 'Ed25519');
  assert.equal(document.public_key.key_id, identity.key_id);
  assert.equal(document.public_key.public_key, identity.public_key);
  assert.equal(document.public_key.created_at, identity.created_at);
  assert.equal(document.public_key.public_key_url, 'https://letters.example.test/.well-known/deadletters.json');

  assert.equal(serialized.includes('private_key'), false);
  assert.equal(serialized.includes('private_key_der'), false);
  assert.equal(serialized.includes('PRIVATE KEY'), false);
  assert.equal(serialized.includes(getDb().prepare(
    'SELECT private_key_der FROM dl_node_identity WHERE identity_id = 1'
  ).get().private_key_der), false);
});

test('legacy rows without an envelope fall back to the local HMAC verifier', () => {
  const provenance = [{
    action: 'original_drop',
    author: 'Legacy Author',
    node: 'deadplug://legacy',
    timestamp: '2025-01-01T00:00:00.000Z'
  }];
  const legacy = {
    source_url: 'https://legacy.example.test/letter',
    original_author: 'Legacy Author',
    original_title: 'Legacy Title',
    provenance_chain: JSON.stringify(provenance)
  };
  const signature = generateSignature(getSignaturePayload({
    sourceUrl: legacy.source_url,
    originalAuthor: legacy.original_author,
    originalTitle: legacy.original_title,
    provenance
  }));
  const postId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, drop_code
    ) VALUES (?, 'Legacy reshare', 'legacy-reshare', 'Legacy', 'Legacy',
      'publish', 'reshare', 'PROV-LEGACY')
  `).run(userId).lastInsertRowid);

  db.prepare(`
    INSERT INTO dl_reshares (
      post_id, source_url, source_node, original_author, original_title,
      original_excerpt, curator_commentary, provenance_chain, signature
    ) VALUES (?, ?, 'deadplug://legacy', ?, ?, '', '', ?, ?)
  `).run(
    postId, legacy.source_url, legacy.original_author, legacy.original_title,
    legacy.provenance_chain, signature
  );

  const row = reloadReshare(postId);
  const valid = verifyReshareRecord(row);
  assert.equal(valid.verification_status, 'verified');
  assert.equal(valid.verification_scope, 'local-integrity');
  assert.equal(valid.signature_valid, true);
  assert.equal(valid.hash_valid, null);

  db.prepare('UPDATE dl_reshares SET original_title = ? WHERE reshare_id = ?')
    .run('Tampered Legacy Title', row.reshare_id);
  const invalid = verifyReshareRecord(reloadReshare(postId));
  assert.equal(invalid.verification_status, 'invalid');
  assert.equal(invalid.verification_scope, 'local-integrity');
  assert.equal(invalid.signature_valid, false);
});

test('createSignedEnvelope binds parent hashes and the full chain into the hash', () => {
  const identity = getPublicNodeIdentity();
  const chain = [{ action: 'original_drop', author: 'Origin' }];
  const signed = createSignedEnvelope({
    source: {
      url: 'https://origin.example.test/a',
      node: 'https://origin.example.test',
      author: 'Origin',
      title: 'Origin',
      excerpt: 'Excerpt'
    },
    curator: { id: userId, commentary: 'Curated.' },
    createdAt: '2026-11-08T01:02:03.000Z',
    parentEnvelopeHash: 'parent-hash-value',
    provenanceChain: chain
  });

  assert.equal(signed.envelope.parent_envelope_hash, 'parent-hash-value');
  assert.equal(signed.envelope.signing_node.handle, identity.handle);
  assert.equal(signed.envelope.signing_node.key_id, identity.key_id);
  assert.equal(signed.envelope_hash, createEnvelopeHash(signed.envelope));
  assert.equal(
    verifyEnvelopeSignature(signed.envelope, signed.envelope_signature, identity.public_key),
    true
  );

  const altered = { ...signed.envelope, provenance_chain: [...chain, { action: 'tampered' }] };
  assert.equal(verifyEnvelopeSignature(altered, signed.envelope_signature, identity.public_key), false);
});
