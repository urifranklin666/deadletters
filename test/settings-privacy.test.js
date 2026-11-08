'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-settings-test-'));
process.env.DEADLETTERS_DATA_DIR = dataDir;
process.env.DEADLETTERS_UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.JWT_SECRET = 'settings-test-secret-that-is-not-used-in-production';
process.env.NODE_ENV = 'test';

const { app } = require('../src/server');
const { closeDb, deleteOption, getDb, getOption } = require('../src/core/db');

let server;
let baseUrl;
let adminToken;

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
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(baseUrl + endpoint, { ...options, headers });
  const data = await response.json();
  return { response, data };
}

function optionRow(name) {
  return getDb().prepare('SELECT option_name FROM dl_options WHERE option_name = ?').get(name);
}

test('settings privacy, validation, and persistence boundaries', async t => {
  await t.test('temporary installation creates a superadmin session', async () => {
    const installed = await request('/api/v1/installer/execute', {
      method: 'POST',
      body: {
        siteTitle: 'Private Settings Test',
        siteTagline: 'keep the internal fields private',
        siteNodeHandle: '@deadplug/settings-test',
        siteUrl: 'https://settings.example',
        adminLogin: 'admin',
        adminEmail: 'admin@settings.example',
        adminPassword: 'a-secure-settings-password',
        seedDemoContent: false
      }
    });
    assert.equal(installed.response.status, 201, JSON.stringify(installed.data));
    adminToken = installed.data.token;
    assert.ok(adminToken);
  });

  await t.test('anonymous settings expose public reader fields only', async () => {
    const { response, data } = await request('/api/v1/settings');
    assert.equal(response.status, 200);

    assert.deepEqual(Object.keys(data).sort(), [
      'active_theme',
      'deadplug_atelier_branding',
      'front_page_display',
      'meta',
      'page_on_front',
      'posts_per_page',
      'reshares_enabled',
      'site_node_handle',
      'site_tagline',
      'site_title',
      'site_url'
    ].sort());

    assert.equal(data.site_title, 'Private Settings Test');
    assert.equal(data.site_tagline, 'keep the internal fields private');
    assert.equal(data.site_node_handle, '@deadplug/settings-test');
    assert.equal('admin_email' in data, false);
    assert.equal('default_comment_approved' in data, false);
    assert.equal('permalink_structure' in data, false);
    assert.doesNotMatch(JSON.stringify(data), /admin@settings\.example/);
  });

  await t.test('superadmin receives the complete settings document', async () => {
    const { response, data } = await request('/api/v1/settings', { token: adminToken });
    assert.equal(response.status, 200);
    assert.equal(data.admin_email, 'admin@settings.example');
    assert.equal(data.default_comment_approved, '0');
    assert.equal(data.permalink_structure, '/letter/%postname%');
    assert.equal(data.posts_per_page, 10);
    assert.equal(data.active_theme, 'deadplug-editorial');
    assert.deepEqual(data.meta, {
      engine: 'deadletters',
      version: '1.0.0',
      creator: 'deadplug.digital',
      tagline: 'the plug is dead. stay wired.',
      repo: 'https://github.com/urifranklin666/deadletters'
    });
  });

  await t.test('authenticated users without SETTINGS_MANAGE still receive only public fields', async () => {
    const created = await request('/api/v1/auth/users', {
      method: 'POST',
      token: adminToken,
      body: {
        login: 'settings-operator',
        email: 'operator@settings.example',
        password: 'operator-settings-password',
        role: 'operator'
      }
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { login: 'settings-operator', password: 'operator-settings-password' }
    });
    assert.equal(login.response.status, 200);

    const { response, data } = await request('/api/v1/settings', { token: login.data.token });
    assert.equal(response.status, 200);
    assert.equal(data.site_title, 'Private Settings Test');
    assert.equal('admin_email' in data, false);
    assert.equal('default_comment_approved' in data, false);
    assert.equal('permalink_structure' in data, false);
  });

  await t.test('invalid values are rejected without partially applying the payload', async () => {
    const invalidPayloads = [
      { site_title: '' },
      { site_title: 'x'.repeat(201) },
      { site_tagline: 'x'.repeat(501) },
      { site_node_handle: 'x'.repeat(101) },
      { site_url: 'ftp://settings.example' },
      { site_url: 'https://user:password@settings.example' },
      { site_url: 'not a url' },
      { admin_email: 'not-an-email' },
      { posts_per_page: 0 },
      { posts_per_page: 101 },
      { posts_per_page: 1.5 },
      { posts_per_page: 'ten' },
      { front_page_display: 'latest' },
      { reshares_enabled: 'yes' },
      { default_comment_approved: '2' },
      { page_on_front: -1 },
      { page_on_front: 1.5 },
      { permalink_structure: '/%year%/%month%/%postname%' },
      { permalink_structure: '/drop/%drop_code%' },
      { deadplug_atelier_branding: 'yes' }
    ];

    for (const body of invalidPayloads) {
      const { response, data } = await request('/api/v1/settings', {
        method: 'PUT',
        token: adminToken,
        body
      });
      assert.equal(response.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(data)}`);
      assert.match(data.error, /Invalid settings value/);
    }

    const mixed = await request('/api/v1/settings', {
      method: 'PUT',
      token: adminToken,
      body: { site_title: 'Must Not Stick', posts_per_page: 0 }
    });
    assert.equal(mixed.response.status, 400);
    assert.equal(getOption('site_title'), 'Private Settings Test');
  });

  await t.test('unsupported permalink choices are explicitly rejected', async () => {
    const { response, data } = await request('/api/v1/settings', {
      method: 'PUT',
      token: adminToken,
      body: { permalink_structure: '/%year%/%month%/%postname%' }
    });
    assert.equal(response.status, 400);
    assert.match(data.error, /canonical "\/letter\/%postname%"/);
    assert.equal(getOption('permalink_structure'), '/letter/%postname%');
  });

  await t.test('valid updates apply normalized values and report applied keys', async () => {
    const body = {
      site_title: '  Updated Atelier  ',
      site_tagline: 'updated transmission',
      site_node_handle: '@deadplug/updated',
      site_url: 'https://deadplug.example/',
      admin_email: 'ops@deadplug.example',
      permalink_structure: '/letter/%postname%',
      default_comment_approved: '1',
      posts_per_page: '25',
      front_page_display: 'page',
      page_on_front: '7',
      reshares_enabled: 0,
      deadplug_atelier_branding: '0'
    };

    const { response, data } = await request('/api/v1/settings', {
      method: 'PUT',
      token: adminToken,
      body: { ...body, future_unknown_setting: 'must be ignored' }
    });
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.deepEqual(data.appliedKeys, Object.keys(body));
    assert.deepEqual(data.applied, Object.keys(body));

    const full = await request('/api/v1/settings', { token: adminToken });
    assert.equal(full.data.site_title, 'Updated Atelier');
    assert.equal(full.data.site_tagline, 'updated transmission');
    assert.equal(full.data.site_node_handle, '@deadplug/updated');
    assert.equal(full.data.site_url, 'https://deadplug.example');
    assert.equal(full.data.admin_email, 'ops@deadplug.example');
    assert.equal(full.data.default_comment_approved, '1');
    assert.equal(full.data.posts_per_page, 25);
    assert.equal(full.data.front_page_display, 'page');
    assert.equal(full.data.page_on_front, 7);
    assert.equal(full.data.reshares_enabled, '0');
    assert.equal(full.data.deadplug_atelier_branding, '0');
    assert.equal(optionRow('future_unknown_setting'), undefined);

    const publicSettings = await request('/api/v1/settings');
    assert.equal(publicSettings.data.site_title, 'Updated Atelier');
    assert.equal(publicSettings.data.reshares_enabled, '0');
    assert.equal('admin_email' in publicSettings.data, false);
  });

  await t.test('unknown-only payloads do not persist options', async () => {
    const beforeTheme = getOption('active_theme');
    const { response, data } = await request('/api/v1/settings', {
      method: 'PUT',
      token: adminToken,
      body: { active_theme: 'unexpected-theme', arbitrary_private_option: 'do-not-store' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(data.appliedKeys, []);
    assert.deepEqual(data.applied, []);
    assert.equal(getOption('active_theme'), beforeTheme);
    assert.equal(optionRow('arbitrary_private_option'), undefined);
  });

  await t.test('default_comment_approved falls back to secure moderation', async () => {
    deleteOption('default_comment_approved');
    const { response, data } = await request('/api/v1/settings', { token: adminToken });
    assert.equal(response.status, 200);
    assert.equal(data.default_comment_approved, '0');

    const post = await request('/api/v1/posts', {
      method: 'POST',
      token: adminToken,
      body: { title: 'Fallback moderation letter', content: 'body', status: 'publish' }
    });
    assert.equal(post.response.status, 201, JSON.stringify(post.data));

    const comment = await request('/api/v1/comments', {
      method: 'POST',
      body: {
        postId: post.data.post.ID,
        content: 'This must wait for moderation.',
        authorName: 'Reader'
      }
    });
    assert.equal(comment.response.status, 201, JSON.stringify(comment.data));
    assert.equal(comment.data.comment.comment_approved, '0');
  });
});
