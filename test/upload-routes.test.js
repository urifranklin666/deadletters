'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const AdmZip = require('adm-zip');

const sandbox = fs.mkdtempSync('/tmp/opencode/deadletters-upload-routes-');
process.env.DEADLETTERS_DATA_DIR = path.join(sandbox, 'data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(sandbox, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(sandbox, 'addons');
process.env.DB_PATH = path.join(sandbox, 'data', 'test.db');

const config = require('../src/config');
const authPath = require.resolve('../src/core/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth: (req, res, next) => {
      req.user = { ID: 1, role: 'superadmin' };
      next();
    }
  }
};

const mediaRouter = require('../src/api/media.routes');
const themesRouter = require('../src/api/themes.routes');
const { updateOption } = require('../src/core/db');
const { router: addonsRouter } = require('../src/api/addons.routes');

const app = express();
app.use('/media', mediaRouter);
app.use('/themes', themesRouter);
app.use('/addons', addonsRouter);
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(500).json({ error: error.message });
});

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.beforeEach(() => {
  for (const directory of [config.uploadsDir, config.themesDir, config.addonsDir, path.join(config.dataDir, 'temp_uploads')]) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function uploadForm(field, filename, payload, mimetype) {
  const form = new FormData();
  form.append(field, new Blob([payload], { type: mimetype }), filename);
  return form;
}

async function postForm(route, form) {
  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

function themeArchive(manifest = { slug: 'safe-theme', name: 'Safe Theme' }, stylesheet = 'body{}') {
  const zip = new AdmZip();
  if (manifest !== undefined) zip.addFile('theme.json', Buffer.from(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)));
  zip.addFile('style.css', Buffer.from(stylesheet));
  return zip.toBuffer();
}

function temporaryFiles() {
  const directory = path.join(config.dataDir, 'temp_uploads');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

test('media route stores canonical valid uploads and lists files without traversing directories', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const uploaded = await postForm('/media/upload', uploadForm('file', '../../My Photo.PNG', png, 'image/png'));
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.match(uploaded.body.filename, /^my-photo-[a-z0-9]+-[a-f0-9]{12}\.png$/);
  assert.equal(fs.existsSync(path.join(config.uploadsDir, uploaded.body.filename)), true);

  fs.mkdirSync(path.join(config.uploadsDir, 'directory.jpg'));
  fs.writeFileSync(path.join(config.uploadsDir, 'legacy.svg'), '<svg/>');
  const response = await fetch(`${baseUrl}/media`);
  const listing = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(listing.media.map(item => item.filename), [uploaded.body.filename]);
});

test('media route deletes signature mismatches and rejects SVG and multiple files', async () => {
  const fakeJpeg = await postForm('/media/upload', uploadForm('file', 'fake.jpg', '<html>not a jpeg</html>', 'image/jpeg'));
  assert.equal(fakeJpeg.status, 400);
  assert.match(fakeJpeg.body.error, /signature/);

  const svg = await postForm('/media/upload', uploadForm('file', 'vector.svg', '<svg/>', 'image/svg+xml'));
  assert.equal(svg.status, 400);

  const multiple = new FormData();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  multiple.append('file', new Blob([png], { type: 'image/png' }), 'one.png');
  multiple.append('file', new Blob([png], { type: 'image/png' }), 'two.png');
  const rejected = await postForm('/media/upload', multiple);
  assert.equal(rejected.status, 400);
  assert.deepEqual(fs.readdirSync(config.uploadsDir), []);
});

test('theme route turns missing and malformed manifests into 400 responses and cleans temp files', async () => {
  const missingManifest = new AdmZip();
  missingManifest.addFile('style.css', Buffer.from('body{}'));
  for (const archive of [
    missingManifest.toBuffer(),
    themeArchive('{bad json'),
    themeArchive([]),
    themeArchive({ name: 'No slug' }),
    themeArchive({ slug: '../escape' })
  ]) {
    const result = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', archive, 'application/zip'));
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(temporaryFiles(), []);
    assert.deepEqual(fs.readdirSync(config.themesDir), []);
  }
});

test('theme route installs once, returns 409 on replacement, and cleans temp files', async () => {
  const first = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', themeArchive(), 'application/zip'));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(fs.readFileSync(path.join(config.themesDir, 'safe-theme', 'style.css'), 'utf8'), 'body{}');
  assert.deepEqual(temporaryFiles(), []);

  const replacement = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', themeArchive({ slug: 'safe-theme' }, 'replacement'), 'application/zip'));
  assert.equal(replacement.status, 409);
  assert.equal(fs.readFileSync(path.join(config.themesDir, 'safe-theme', 'style.css'), 'utf8'), 'body{}');
  assert.deepEqual(temporaryFiles(), []);
});

test('theme route rejects traversal before extraction', async () => {
  const zip = new AdmZip();
  zip.addFile('theme.json', Buffer.from(JSON.stringify({ slug: 'safe-theme' })));
  zip.addFile('xx/outside.txt', Buffer.from('escape'));
  const archive = zip.toBuffer();
  const safeName = Buffer.from('xx/outside.txt');
  const traversalName = Buffer.from('../outside.txt');
  for (let offset = archive.indexOf(safeName); offset !== -1; offset = archive.indexOf(safeName, offset + safeName.length)) {
    traversalName.copy(archive, offset);
  }
  assert.deepEqual(new AdmZip(archive).getEntries().map(entry => entry.entryName).sort(), ['../outside.txt', 'theme.json']);

  const result = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', archive, 'application/zip'));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /traversal/);
  assert.equal(fs.existsSync(path.join(sandbox, 'outside.txt')), false);
  assert.deepEqual(fs.readdirSync(config.themesDir), []);
  assert.deepEqual(temporaryFiles(), []);
});

test('theme route rejects executable or active web assets and serves the active CSS safely', async () => {
  const malicious = new AdmZip();
  malicious.addFile('theme.json', Buffer.from(JSON.stringify({ slug: 'active-theme' })));
  malicious.addFile('style.css', Buffer.from('body{color:red}'));
  malicious.addFile('payload.js', Buffer.from('alert(1)'));
  const rejected = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', malicious.toBuffer(), 'application/zip'));
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /may contain only/);
  assert.deepEqual(fs.readdirSync(config.themesDir), []);

  const installed = await postForm('/themes/upload-zip', uploadForm('theme_zip', 'theme.zip', themeArchive({ slug: 'active-theme' }, 'body{color:blue}'), 'application/zip'));
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  updateOption('active_theme', 'active-theme');
  const stylesheet = await fetch(`${baseUrl}/themes/active/style.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  assert.equal(await stylesheet.text(), 'body{color:blue}');
});

test('addon route returns 400 for invalid manifests and 409 without overwriting an installation', async () => {
  const invalid = new AdmZip();
  invalid.addFile('addon.json', Buffer.from('{bad json'));
  const rejected = await postForm('/addons/upload-zip', uploadForm('addon_zip', 'addon.zip', invalid.toBuffer(), 'application/zip'));
  assert.equal(rejected.status, 400);
  assert.deepEqual(temporaryFiles(), []);

  const installed = path.join(config.addonsDir, 'existing-addon');
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'addon.json'), '{"slug":"existing-addon","name":"Original"}');
  const replacement = new AdmZip();
  replacement.addFile('addon.json', Buffer.from('{"slug":"existing-addon","name":"Replacement"}'));
  const conflict = await postForm('/addons/upload-zip', uploadForm('addon_zip', 'addon.zip', replacement.toBuffer(), 'application/zip'));
  assert.equal(conflict.status, 409);
  assert.match(fs.readFileSync(path.join(installed, 'addon.json'), 'utf8'), /Original/);
  assert.deepEqual(temporaryFiles(), []);
});
