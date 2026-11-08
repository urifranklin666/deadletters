const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-app-test-'));
process.env.DEADLETTERS_DATA_DIR = dataDir;
process.env.DEADLETTERS_UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.JWT_SECRET = 'integration-test-secret-that-is-not-used-in-production';
process.env.NODE_ENV = 'test';

const { app } = require('../src/server');
const { closeDb, getDb } = require('../src/core/db');

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(endpoint, { token, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(baseUrl + endpoint, { ...options, headers });
  const data = await response.json();
  return { response, data };
}

test('secure installation and editorial lifecycle', async t => {
  let adminToken;
  let publishedId;

  await t.test('fresh diagnostics are real and installation validates passwords', async () => {
    const status = await request('/api/v1/installer/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.data.isInstalled, false);
    assert.equal(status.data.systemReady, true);
    assert.equal(status.data.checks.sqliteSupport.passed, true);

    const weak = await request('/api/v1/installer/execute', {
      method: 'POST',
      body: { adminLogin: 'admin', adminEmail: 'admin@example.com', adminPassword: 'short' }
    });
    assert.equal(weak.response.status, 400);

    const discovery = await request('/.well-known/deadletters.json');
    assert.equal(discovery.response.status, 404);
  });

  await t.test('installation commits an admin and becomes immediately operational', async () => {
    const installed = await request('/api/v1/installer/execute', {
      method: 'POST',
      body: {
        siteTitle: 'Integration Letters',
        siteUrl: 'http://localhost:3000',
        adminLogin: 'admin',
        adminEmail: 'admin@example.com',
        adminPassword: 'a-secure-password',
        seedDemoContent: false
      }
    });
    assert.equal(installed.response.status, 201, JSON.stringify(installed.data));
    adminToken = installed.data.token;
    assert.ok(adminToken);

    const status = await request('/api/v1/installer/status');
    assert.equal(status.data.isInstalled, true);
    const me = await request('/api/v1/auth/me', { token: adminToken });
    assert.equal(me.response.status, 200);
    assert.equal(me.data.user.role, 'superadmin');

    const cookieOnly = await request('/api/v1/auth/me', {
      headers: { Cookie: `deadletters_token=${adminToken}` }
    });
    assert.equal(cookieOnly.response.status, 401);
  });

  await t.test('public node discovery exposes only the Ed25519 public identity', async () => {
    const response = await fetch(`${baseUrl}/.well-known/deadletters.json`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /max-age=\d+/);
    assert.doesNotMatch(body, /private_key|PRIVATE KEY/i);

    const discovery = JSON.parse(body);
    assert.equal(discovery.spec, 'deadletters-reletter-v1');
    assert.equal(discovery.node_handle, '@deadplug/main-node');
    assert.equal(discovery.site_url, 'http://localhost:3000');
    assert.equal(discovery.public_key.algorithm, 'Ed25519');
    assert.match(discovery.public_key.key_id, /^ed25519-/);
    assert.equal(typeof discovery.public_key.public_key, 'string');
    assert.ok(discovery.public_key.public_key.length > 40);
    assert.equal(
      discovery.public_key.public_key_url,
      'http://localhost:3000/.well-known/deadletters.json'
    );
  });

  await t.test('operators cannot administer posts or executable addons', async () => {
    const created = await request('/api/v1/auth/users', {
      method: 'POST',
      token: adminToken,
      body: {
        login: 'operator', email: 'operator@example.com',
        password: 'operator-password', role: 'operator'
      }
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));

    const login = await request('/api/v1/auth/login', {
      method: 'POST', body: { login: 'operator', password: 'operator-password' }
    });
    assert.equal(login.response.status, 200);
    const operatorToken = login.data.token;

    const post = await request('/api/v1/posts', {
      method: 'POST', token: operatorToken, body: { title: 'Nope', content: 'Nope' }
    });
    assert.equal(post.response.status, 403);
    const addons = await request('/api/v1/addons', { token: operatorToken });
    assert.equal(addons.response.status, 403);
  });

  await t.test('the shared preview renderer preserves shortcodes and removes XSS', async () => {
    const preview = await request('/api/v1/posts/render-preview', {
      method: 'POST',
      token: adminToken,
      body: {
        content: '## Safe\n\n[dropcap]D[/dropcap]anger <img src=x onerror=alert(1)> [callout type="alert"]**Read**[/callout]'
      }
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.match(preview.data.html, /<h2>Safe<\/h2>/);
    assert.match(preview.data.html, /dl-dropcap/);
    assert.match(preview.data.html, /dl-callout-alert/);
    assert.doesNotMatch(preview.data.html, /onerror|<script/);
  });

  await t.test('drafts stay private and published content uses the same renderer', async () => {
    const draft = await request('/api/v1/posts', {
      method: 'POST', token: adminToken,
      body: { title: 'Secret draft', content: 'draft', status: 'draft' }
    });
    assert.equal(draft.response.status, 201);
    assert.equal((await request(`/api/v1/posts/${draft.data.post.ID}`)).response.status, 403);
    assert.equal((await request(`/wp-json/wp/v2/posts/${draft.data.post.ID}`)).response.status, 404);

    const published = await request('/api/v1/posts', {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Public letter',
        content: '**Hello** <script>alert(1)</script>[glitch]mesh[/glitch]',
        status: 'publish',
        categories: ['Editorial'],
        tags: ['Test']
      }
    });
    assert.equal(published.response.status, 201, JSON.stringify(published.data));
    publishedId = published.data.post.ID;

    const single = await request('/api/v1/posts/public-letter');
    assert.equal(single.response.status, 200);
    assert.match(single.data.post.post_content_rendered, /<strong>Hello<\/strong>/);
    assert.match(single.data.post.post_content_rendered, /dl-glitch-text/);
    assert.doesNotMatch(single.data.post.post_content_rendered, /<script/);

    const wp = await request(`/wp-json/wp/v2/posts/${publishedId}`);
    assert.match(wp.data.content.rendered, /<strong>Hello<\/strong>/);
    assert.doesNotMatch(wp.data.content.rendered, /<script/);
  });

  await t.test('slug updates and taxonomy replacement remain consistent', async () => {
    const updated = await request(`/api/v1/posts/${publishedId}`, {
      method: 'PUT', token: adminToken,
      body: { slug: 'renamed-letter', categories: ['Replacement'] }
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.post.post_name, 'renamed-letter');

    const db = getDb();
    const editorial = db.prepare("SELECT tt.count FROM dl_terms t JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id WHERE t.slug = 'editorial'").get();
    const replacement = db.prepare("SELECT tt.count FROM dl_terms t JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id WHERE t.slug = 'replacement'").get();
    assert.equal(editorial.count, 0);
    assert.equal(replacement.count, 1);
    assert.equal((await request('/api/v1/posts/renamed-letter')).response.status, 200);
  });

  await t.test('canonical routes return the intended shell and safe server metadata', async () => {
    const letterResponse = await fetch(`${baseUrl}/letter/renamed-letter`);
    const letter = await letterResponse.text();
    assert.equal(letterResponse.status, 200);
    assert.match(letter, /<title>Public letter \| Integration Letters<\/title>/);
    assert.match(letter, /rel="canonical"/);
    assert.match(letter, /id="dl-initial-route"/);
    assert.match(letter, /#\/letter\/renamed-letter/);
    assert.match(letter, /application\/ld\+json/);

    const admin = await fetch(`${baseUrl}/admin`).then(response => response.text());
    assert.match(admin, /#\/admin/);
    const reshareStream = await fetch(`${baseUrl}/reshares`).then(response => response.text());
    assert.match(reshareStream, /#\/reshares/);
  });

  await t.test('pending comments and moderation update public visibility and counters atomically', async () => {
    const submitted = await request('/api/v1/comments', {
      method: 'POST',
      body: { postId: publishedId, content: '<img src=x onerror=alert(1)>A useful comment', authorName: 'Reader' }
    });
    assert.equal(submitted.response.status, 201, JSON.stringify(submitted.data));
    assert.equal(submitted.data.comment.comment_approved, '0');
    assert.equal(getDb().prepare('SELECT comment_count FROM dl_posts WHERE ID = ?').get(publishedId).comment_count, 0);
    assert.equal((await request(`/api/v1/comments/post/${publishedId}`)).data.comments.length, 0);

    const commentId = submitted.data.comment.comment_ID;
    const moderated = await request(`/api/v1/comments/${commentId}/status`, {
      method: 'PUT', token: adminToken, body: { status: '1' }
    });
    assert.equal(moderated.response.status, 200);
    assert.equal(getDb().prepare('SELECT comment_count FROM dl_posts WHERE ID = ?').get(publishedId).comment_count, 1);
    assert.equal((await request(`/api/v1/comments/post/${publishedId}`)).data.comments.length, 1);

    const wp = await request('/wp-json/wp/v2/comments');
    const comment = wp.data.find(item => item.id === commentId);
    assert.doesNotMatch(comment.content.rendered, /<img/);
    assert.match(comment.content.rendered, /&lt;img/);
  });

  await t.test('local reshares are transactional and locally verifiable', async () => {
    const login = await request('/api/v1/auth/login', {
      method: 'POST', body: { login: 'operator', password: 'operator-password' }
    });
    const reshared = await request('/api/v1/reshares', {
      method: 'POST', token: login.data.token,
      body: { sourcePostId: publishedId, curatorCommentary: 'A curator response' }
    });
    assert.equal(reshared.response.status, 201, JSON.stringify(reshared.data));

    assert.equal(reshared.data.reshare.signature, null, 'new reshares must not be HMAC-signed');
    assert.ok(reshared.data.reshare.envelope_hash);
    assert.ok(reshared.data.reshare.envelope_signature);

    const provenance = await request(`/api/v1/reshares/provenance/${reshared.data.reshare.id}`);
    assert.equal(provenance.response.status, 200);
    assert.equal(provenance.data.hash_valid, true);
    assert.equal(provenance.data.signature_valid, true);
    assert.equal(provenance.data.verification_status, 'verified');
    assert.equal(provenance.data.verification_scope, 'deadletters-ed25519-v1');
    assert.match(provenance.data.key_id, /^ed25519-/);
    assert.equal(provenance.data.envelope_hash, reshared.data.reshare.envelope_hash);
    assert.equal(provenance.data.parent_envelope_hash, null);
    assert.equal(
      provenance.data.public_key_url,
      'http://localhost:3000/.well-known/deadletters.json'
    );

    getDb().prepare('UPDATE dl_reshares SET original_title = ? WHERE post_id = ?')
      .run('Tampered title', reshared.data.reshare.id);
    const tampered = await request(`/api/v1/reshares/provenance/${reshared.data.reshare.id}`);
    assert.equal(tampered.data.verification_status, 'invalid');
    assert.match(tampered.data.reason, /do not match the signed envelope/i);
  });

  await t.test('password changes revoke the previous bearer token', async () => {
    const changed = await request('/api/v1/auth/profile', {
      method: 'PUT', token: adminToken,
      body: { password: 'a-new-secure-password' }
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
    assert.ok(changed.data.token);
    assert.equal((await request('/api/v1/auth/me', { token: adminToken })).response.status, 401);
    assert.equal((await request('/api/v1/auth/me', { token: changed.data.token })).response.status, 200);
    adminToken = changed.data.token;
  });

  await t.test('unknown API routes return JSON rather than the SPA', async () => {
    const missing = await request('/api/v1/not-a-route');
    assert.equal(missing.response.status, 404);
    assert.match(missing.data.error, /API endpoint not found/);
  });
});
