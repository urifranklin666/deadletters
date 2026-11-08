'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-exporter-test-'));
process.env.DEADLETTERS_DATA_DIR = path.join(sandbox, 'live-data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(sandbox, 'live-uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(sandbox, 'live-themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(sandbox, 'live-addons');
process.env.DB_PATH = path.join(sandbox, 'live-data', 'custom-live.db');

const config = require('../src/config');
const { closeDb, getDb, updateOption } = require('../src/core/db');
const {
  packageEngineZip,
  packageSiteSnapshot,
  restoreSiteSnapshot
} = require('../src/core/exporter');

let engineZip;

test.before(() => {
  const result = packageEngineZip(path.join(sandbox, 'engine.zip'));
  engineZip = new AdmZip(result.zipPath);
});

test.after(() => {
  closeDb();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function entryData(zip, name) {
  const entry = zip.getEntry(name);
  assert.ok(entry, `missing archive entry ${name}`);
  return entry.getData();
}

test('engine ZIP contains locked startup sources and no runtime content, secrets, or checkout cruft', () => {
  const names = engineZip.getEntries().map(entry => entry.entryName);
  const nameSet = new Set(names);

  for (const required of [
    'package.json',
    'package-lock.json',
    'install.js',
    'bin/deadletters.js',
    'src/server.js',
    'src/config.js',
    'src/core/db.js',
    'src/core/schema.js',
    'public/app/index.html'
  ]) {
    assert.equal(nameSet.has(required), true, required);
  }

  assert.equal(new Set(names).size, names.length, 'engine paths must be unique');
  assert.equal(names.some(name => (
    name.startsWith('src/content/') ||
    name.startsWith('test/') ||
    name.startsWith('tests/') ||
    name.startsWith('node_modules/') ||
    name.startsWith('.git/') ||
    name === '.env' ||
    /(?:^|\/)config\.json$/.test(name) ||
    /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(name) ||
    /\.zip$/.test(name) ||
    /(?:^|\/)(?:temp|tmp|temp_uploads)(?:\/|$)/.test(name)
  )), false, names.join('\n'));

  const installer = entryData(engineZip, 'install.js').toString('utf8');
  assert.match(installer, /\['ci', '--omit=dev'\]/);
  assert.match(installer, /const \{ startServer \} = require\('\.\/src\/server\.js'\)/);
  assert.match(installer, /startServer\(\);/);
  assert.match(installer, /installation failed/i);
  assert.doesNotMatch(installer, /npm install/);
});

test('generated engine bootstrap runs npm ci and fails clearly without starting on installation failure', {
  skip: process.platform === 'win32'
}, () => {
  const bootstrapSandbox = path.join(sandbox, 'bootstrap');
  const fakeBin = path.join(bootstrapSandbox, 'bin');
  fs.mkdirSync(path.join(bootstrapSandbox, 'src'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(bootstrapSandbox, 'install.js'), entryData(engineZip, 'install.js'));
  // Only the function call writes the marker, so a bare require cannot pass.
  fs.writeFileSync(path.join(bootstrapSandbox, 'src', 'server.js'),
    "exports.startServer = () => require('node:fs').writeFileSync(process.env.DEADLETTERS_TEST_START_MARKER, 'started');\n");

  const fakeNpm = path.join(fakeBin, 'npm');
  fs.writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\\n' "$@" > "$DEADLETTERS_TEST_NPM_ARGS"
exit "$DEADLETTERS_TEST_NPM_STATUS"
`, { mode: 0o755 });

  const baseEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    DEADLETTERS_TEST_NPM_ARGS: path.join(bootstrapSandbox, 'npm-args.txt'),
    DEADLETTERS_TEST_START_MARKER: path.join(bootstrapSandbox, 'started.txt'),
    DEADLETTERS_TEST_NPM_STATUS: '0'
  };
  const installed = spawnSync(process.execPath, ['install.js'], {
    cwd: bootstrapSandbox,
    env: baseEnvironment,
    encoding: 'utf8'
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.readFileSync(baseEnvironment.DEADLETTERS_TEST_NPM_ARGS, 'utf8'), 'ci\n--omit=dev\n');
  assert.equal(fs.readFileSync(baseEnvironment.DEADLETTERS_TEST_START_MARKER, 'utf8'), 'started');

  fs.rmSync(baseEnvironment.DEADLETTERS_TEST_START_MARKER);
  const failed = spawnSync(process.execPath, ['install.js'], {
    cwd: bootstrapSandbox,
    env: { ...baseEnvironment, DEADLETTERS_TEST_NPM_STATUS: '9' },
    encoding: 'utf8'
  });
  assert.equal(failed.status, 9);
  assert.match(failed.stderr, /installation failed: npm ci --omit=dev exited with status 9/i);
  assert.equal(fs.existsSync(baseEnvironment.DEADLETTERS_TEST_START_MARKER), false);
});

test('snapshot uses a restorable SQLite backup and excludes WAL, SHM, temporary files, and old archives', async () => {
  updateOption('site_title', 'Restored snapshot title');
  getDb().prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES (?, ?, ?, ?, ?)
  `).run('snapshot-admin', 'test-only-hash', 'snapshot@example.test', 'Snapshot Admin', 'superadmin');
  config.saveConfigFile({
    installed: true,
    jwtSecret: 'snapshot-test-secret',
    provenanceSecret: 'snapshot-provenance-secret'
  });

  fs.writeFileSync(path.join(config.dataDir, 'old-snapshot.zip'), 'old archive');
  fs.writeFileSync(path.join(config.dataDir, 'stale-copy.db-wal'), 'stale wal');
  fs.writeFileSync(path.join(config.dataDir, 'stale-copy.db-shm'), 'stale shm');
  fs.mkdirSync(path.join(config.dataDir, 'temp_uploads'), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'temp_uploads', 'secret.tmp'), 'temporary');

  fs.writeFileSync(path.join(config.uploadsDir, 'kept.jpg'), 'image');
  fs.writeFileSync(path.join(config.uploadsDir, 'old-upload.zip'), 'old archive');
  fs.writeFileSync(path.join(config.uploadsDir, 'discard.tmp'), 'temporary');
  fs.mkdirSync(path.join(config.themesDir, 'snapshot-theme'), { recursive: true });
  fs.writeFileSync(path.join(config.themesDir, 'snapshot-theme', 'theme.json'), '{"slug":"snapshot-theme"}');
  fs.mkdirSync(path.join(config.themesDir, 'temp_uploads'), { recursive: true });
  fs.writeFileSync(path.join(config.themesDir, 'temp_uploads', 'discard.txt'), 'temporary');
  fs.mkdirSync(path.join(config.addonsDir, 'snapshot-addon'), { recursive: true });
  fs.writeFileSync(path.join(config.addonsDir, 'snapshot-addon', 'addon.json'), '{"slug":"snapshot-addon"}');

  const snapshot = await packageSiteSnapshot(path.join(sandbox, 'site.zip'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(snapshot.zipPath).mode & 0o077, 0, 'snapshot archives must be owner-only');
  }
  const snapshotZip = new AdmZip(snapshot.zipPath);
  const names = snapshotZip.getEntries().map(entry => entry.entryName);

  for (const required of [
    'data/deadletters.db',
    'data/config.json',
    'uploads/',
    'uploads/kept.jpg',
    'themes/',
    'themes/snapshot-theme/theme.json',
    'addons/',
    'addons/snapshot-addon/addon.json'
  ]) {
    assert.equal(names.includes(required), true, required);
  }
  assert.equal(names.some(name => (
    /(?:-wal|-shm|\.wal$|\.shm$)/i.test(name) ||
    /\.zip$/i.test(name) ||
    /\.(?:tmp|temp|part|partial)$/i.test(name) ||
    /(?:^|\/)(?:temp|tmp|temp_uploads)(?:\/|$)/i.test(name)
  )), false, names.join('\n'));

  const restored = await restoreSiteSnapshot(snapshot.zipPath, path.join(sandbox, 'restored'));
  assert.equal(fs.readFileSync(path.join(restored.paths.uploadsDir, 'kept.jpg'), 'utf8'), 'image');
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored.paths.dataDir, 'config.json'), 'utf8')).jwtSecret,
    'snapshot-test-secret');
  assert.match(restored.startCommand, /DEADLETTERS_DATA_DIR=/);
  assert.match(restored.startCommand, /DEADLETTERS_UPLOADS_DIR=/);
  assert.match(restored.startCommand, /DEADLETTERS_THEMES_DIR=/);
  assert.match(restored.startCommand, /DEADLETTERS_ADDONS_DIR=/);
  assert.match(restored.startCommand, /DB_PATH=/);
  assert.match(restored.startCommand, /npm start$/);

  let restoredDb;
  try {
    restoredDb = new Database(restored.paths.dbPath, { readonly: true, fileMustExist: true });
    assert.deepEqual(restoredDb.prepare('PRAGMA quick_check').all(), [{ quick_check: 'ok' }]);
    assert.equal(restoredDb.prepare(
      "SELECT option_value FROM dl_options WHERE option_name = 'site_title'"
    ).get().option_value, 'Restored snapshot title');
    assert.equal(restoredDb.prepare(
      "SELECT user_email FROM dl_users WHERE user_login = 'snapshot-admin'"
    ).get().user_email, 'snapshot@example.test');
  } finally {
    if (restoredDb) restoredDb.close();
  }

  await assert.rejects(
    restoreSiteSnapshot(snapshot.zipPath, restored.targetDirectory),
    /empty|refusing to overwrite/
  );
  assert.equal(fs.readFileSync(path.join(restored.paths.uploadsDir, 'kept.jpg'), 'utf8'), 'image');
});

test('restore rejects traversal, unexpected paths, and invalid databases before creating the target', async () => {
  const traversal = new AdmZip();
  traversal.addFile('data/deadletters.db', Buffer.from('not sqlite'));
  traversal.addFile('xx/outside.txt', Buffer.from('escape'));
  const traversalBuffer = traversal.toBuffer();
  const safeName = Buffer.from('xx/outside.txt');
  const traversalName = Buffer.from('../outside.txt');
  for (let offset = traversalBuffer.indexOf(safeName); offset !== -1;
    offset = traversalBuffer.indexOf(safeName, offset + safeName.length)) {
    traversalName.copy(traversalBuffer, offset);
  }
  const traversalPath = path.join(sandbox, 'traversal.zip');
  fs.writeFileSync(traversalPath, traversalBuffer);
  const traversalTarget = path.join(sandbox, 'traversal-target');
  await assert.rejects(restoreSiteSnapshot(traversalPath, traversalTarget), /traversal/);
  assert.equal(fs.existsSync(traversalTarget), false);
  assert.equal(fs.existsSync(path.join(sandbox, 'outside.txt')), false);

  const unexpected = new AdmZip();
  unexpected.addFile('data/deadletters.db', Buffer.from('not sqlite'));
  unexpected.addFile('unexpected/secret.txt', Buffer.from('unexpected'));
  const unexpectedPath = path.join(sandbox, 'unexpected.zip');
  unexpected.writeZip(unexpectedPath);
  const unexpectedTarget = path.join(sandbox, 'unexpected-target');
  await assert.rejects(restoreSiteSnapshot(unexpectedPath, unexpectedTarget), /unexpected top-level path/);
  assert.equal(fs.existsSync(unexpectedTarget), false);

  const invalidDatabase = new AdmZip();
  invalidDatabase.addFile('data/deadletters.db', Buffer.from('not sqlite'));
  invalidDatabase.addFile('uploads/', Buffer.alloc(0));
  invalidDatabase.addFile('themes/', Buffer.alloc(0));
  invalidDatabase.addFile('addons/', Buffer.alloc(0));
  const invalidPath = path.join(sandbox, 'invalid.zip');
  invalidDatabase.writeZip(invalidPath);
  const invalidTarget = path.join(sandbox, 'invalid-target');
  await assert.rejects(restoreSiteSnapshot(invalidPath, invalidTarget), /valid SQLite|not valid SQLite/);
  assert.equal(fs.existsSync(invalidTarget), false);

  const genericDatabasePath = path.join(sandbox, 'generic.db');
  const genericDatabase = new Database(genericDatabasePath);
  genericDatabase.exec('CREATE TABLE unrelated (value TEXT)');
  genericDatabase.close();
  const wrongApplication = new AdmZip();
  wrongApplication.addLocalFile(genericDatabasePath, 'data', 'deadletters.db');
  const wrongApplicationPath = path.join(sandbox, 'wrong-application.zip');
  wrongApplication.writeZip(wrongApplicationPath);
  const wrongApplicationTarget = path.join(sandbox, 'wrong-application-target');
  await assert.rejects(restoreSiteSnapshot(wrongApplicationPath, wrongApplicationTarget), /not a Deadletters database/);
  assert.equal(fs.existsSync(wrongApplicationTarget), false);
});
