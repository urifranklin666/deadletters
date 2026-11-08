'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const projectRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'backup.sh');
const bashPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-backup-test-'));

const dataDir = path.join(sandbox, 'runtime', 'data');
const uploadsDir = path.join(sandbox, 'runtime', 'uploads');
const themesDir = path.join(sandbox, 'runtime', 'themes');
const addonsDir = path.join(sandbox, 'runtime', 'addons');
const backupDir = path.join(sandbox, 'backups');
const dbPath = path.join(dataDir, 'deadletters.db');
const testJwtSecret = 'backup-test-jwt-secret-must-not-be-printed';
const testProvenanceSecret = 'backup-test-provenance-secret-must-not-be-printed';

const baseEnvironment = { ...process.env };
for (const name of Object.keys(baseEnvironment)) {
  if (name.startsWith('DEADLETTERS_') || name === 'DB_PATH') delete baseEnvironment[name];
}
Object.assign(baseEnvironment, {
  NODE_ENV: 'test',
  DEADLETTERS_DATA_DIR: dataDir,
  DEADLETTERS_UPLOADS_DIR: uploadsDir,
  DEADLETTERS_THEMES_DIR: themesDir,
  DEADLETTERS_ADDONS_DIR: addonsDir,
  DEADLETTERS_BACKUP_DIR: backupDir,
  DB_PATH: dbPath
});

function runBackup(overrides = {}) {
  return spawnSync(bashPath, [scriptPath], {
    cwd: projectRoot,
    env: { ...baseEnvironment, ...overrides },
    encoding: 'utf8',
    timeout: 120000
  });
}

function commandPath(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeSampleFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function setOldTimestamp(filePath, daysOld) {
  const timestamp = (Date.now() - daysOld * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(filePath, timestamp, timestamp);
}

function archiveNames() {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(name => /^deadletters-site-snapshot-.*\.zip(?:\.age)?$/.test(name))
    .sort();
}

test.before(() => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(themesDir, { recursive: true });
  fs.mkdirSync(addonsDir, { recursive: true });

  const initialized = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(path.join(projectRoot, 'src', 'config.js'))});
    const { initDb, updateOption, closeDb } = require(${JSON.stringify(path.join(projectRoot, 'src', 'core', 'db.js'))});
    initDb();
    updateOption('site_title', 'Backup integration test');
    config.saveConfigFile({
      installed: true,
      jwtSecret: ${JSON.stringify(testJwtSecret)},
      provenanceSecret: ${JSON.stringify(testProvenanceSecret)}
    });
    closeDb();
  `], {
    cwd: projectRoot,
    env: baseEnvironment,
    encoding: 'utf8'
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  writeSampleFile(path.join(uploadsDir, 'camera.jpg'), 'sample image bytes');
  writeSampleFile(path.join(uploadsDir, 'old-upload.zip'), 'must not be snapshotted');
  writeSampleFile(path.join(uploadsDir, 'discard.tmp'), 'must not be snapshotted');
  writeSampleFile(path.join(themesDir, 'backup-theme', 'theme.json'), '{"slug":"backup-theme"}');
  writeSampleFile(path.join(addonsDir, 'backup-addon', 'addon.json'), '{"slug":"backup-addon"}');
  writeSampleFile(path.join(dataDir, 'old-snapshot.zip'), 'must not be snapshotted');
  writeSampleFile(path.join(dataDir, 'temp_uploads', 'discard.tmp'), 'must not be snapshotted');
});

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('backup script passes bash syntax validation', () => {
  const result = spawnSync(bashPath, ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('backup creates an owner-only consistent snapshot and never prints secrets', () => {
  const result = runBackup();
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.equal(combinedOutput.includes(testJwtSecret), false, 'JWT secret leaked to backup output');
  assert.equal(combinedOutput.includes(testProvenanceSecret), false, 'provenance secret leaked to backup output');

  const archives = archiveNames();
  assert.equal(archives.length, 1, archives.join('\n'));
  assert.equal(archives[0].endsWith('.zip'), true);

  const archivePath = path.join(backupDir, archives[0]);
  assert.equal(fs.existsSync(archivePath), true);
  assert.ok(fs.statSync(archivePath).size > 0, 'snapshot archive must not be empty');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(archivePath).mode & 0o077, 0, 'snapshot archive must be owner-only');
    assert.equal(fs.statSync(backupDir).mode & 0o077, 0, 'backup directory must be owner-only');
  }

  const zip = new AdmZip(archivePath);
  const names = zip.getEntries().map(entry => entry.entryName);
  for (const required of [
    'data/deadletters.db',
    'data/config.json',
    'uploads/camera.jpg',
    'themes/backup-theme/theme.json',
    'addons/backup-addon/addon.json'
  ]) {
    assert.equal(names.includes(required), true, `missing ${required}`);
  }
  assert.equal(names.some(name => (
    /\.zip$/i.test(name) ||
    /\.(?:tmp|temp|part|partial)$/i.test(name) ||
    /(?:^|\/)(?:temp|tmp|temp_uploads)(?:\/|$)/i.test(name) ||
    /(?:-wal|-shm|\.wal$|\.shm$)/i.test(name)
  )), false, names.join('\n'));
  assert.ok(zip.getEntry('data/deadletters.db').getData().length > 0);
});

test('retention prunes only matching old backups and leaves prefix/nested files alone', () => {
  const oldMatchingZip = path.join(backupDir, 'deadletters-site-snapshot-20000101T000000Z.zip');
  const oldMatchingAge = path.join(backupDir, 'deadletters-site-snapshot-20000101T000000Z.zip.age');
  const prefixedZip = path.join(backupDir, 'important-deadletters-site-snapshot-20000101T000000Z.zip');
  const suffixedZip = path.join(backupDir, 'deadletters-site-snapshot-20000101T000000Z.zip.keep');
  const otherArchive = path.join(backupDir, 'unrelated.zip');
  const nestedArchive = path.join(backupDir, 'nested', 'deadletters-site-snapshot-20000101T000000Z.zip');

  for (const filePath of [oldMatchingZip, oldMatchingAge, prefixedZip, suffixedZip, otherArchive, nestedArchive]) {
    writeSampleFile(filePath, 'old backup');
    setOldTimestamp(filePath, 30);
  }
  const before = new Set(archiveNames());

  const result = runBackup({ DEADLETTERS_BACKUP_RETENTION_DAYS: '7' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.equal(fs.existsSync(oldMatchingZip), false, 'old matching ZIP should be pruned');
  assert.equal(fs.existsSync(oldMatchingAge), false, 'old matching encrypted ZIP should be pruned');
  assert.equal(fs.existsSync(prefixedZip), true, 'similarly prefixed file must not be pruned');
  assert.equal(fs.existsSync(suffixedZip), true, 'nonmatching suffix must not be pruned');
  assert.equal(fs.existsSync(otherArchive), true, 'unrelated archive must not be pruned');
  assert.equal(fs.existsSync(nestedArchive), true, 'nested archive must not be pruned');

  const after = archiveNames();
  assert.ok(after.some(name => !before.has(name)), 'a new snapshot should have been created');
  assert.ok(after.some(name => /\.zip$/.test(name) && !name.includes('important-')),
    'a current matching snapshot should remain');
});

test('retention values are validated before any snapshot is created', () => {
  const before = archiveNames();
  for (const invalid of ['0', '-1', '*', '../7', '7;touch /tmp/deadletters-backup-test', '999999']) {
    const result = runBackup({ DEADLETTERS_BACKUP_RETENTION_DAYS: invalid });
    assert.notEqual(result.status, 0, `retention value should be rejected: ${invalid}`);
    assert.match(result.stderr, /DEADLETTERS_BACKUP_RETENTION_DAYS/, result.stderr);
  }
  assert.deepEqual(archiveNames(), before, 'invalid retention must not create a backup');
});

test('requested age encryption fails clearly when age is unavailable', () => {
  const fakeBin = path.join(sandbox, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const dirnamePath = commandPath('dirname');
  assert.ok(dirnamePath, 'dirname must be available for this test');
  fs.symlinkSync(dirnamePath, path.join(fakeBin, 'dirname'));

  const unavailableBackupDir = path.join(sandbox, 'unavailable-age-backups');
  const result = runBackup({
    PATH: fakeBin,
    DEADLETTERS_BACKUP_DIR: unavailableBackupDir,
    DEADLETTERS_BACKUP_AGE_RECIPIENT: 'age1example-recipient'
  });

  assert.notEqual(result.status, 0, 'backup must fail when requested encryption is unavailable');
  assert.match(result.stderr, /age.*not available|not available.*age/i);
  assert.equal(fs.existsSync(unavailableBackupDir), false,
    'backup must fail before creating an unencrypted archive');
});

const agePath = commandPath('age');
const ageKeygenPath = commandPath('age-keygen');

test('age encryption removes plaintext and produces a decryptable encrypted snapshot', {
  skip: !agePath || !ageKeygenPath ? 'age and age-keygen are not installed' : false
}, () => {
  const keyFile = path.join(sandbox, 'age-identity.txt');
  const keygen = spawnSync(ageKeygenPath, ['-o', keyFile], { encoding: 'utf8' });
  assert.equal(keygen.status, 0, keygen.stderr);
  const publicKey = `${keygen.stdout}\n${keygen.stderr}`.match(/Public key:\s*(age1[0-9a-z]+)/i);
  assert.ok(publicKey, 'age-keygen must print the public recipient');

  const encryptedBackupDir = path.join(sandbox, 'encrypted-backups');
  const result = runBackup({
    DEADLETTERS_BACKUP_DIR: encryptedBackupDir,
    DEADLETTERS_BACKUP_AGE_RECIPIENT: publicKey[1]
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.includes(publicKey[1]), false, 'recipient should not be printed as a secret');

  const encryptedNames = fs.readdirSync(encryptedBackupDir);
  const encryptedArchive = encryptedNames.find(name => name.endsWith('.zip.age'));
  assert.ok(encryptedArchive, encryptedNames.join('\n'));
  assert.equal(encryptedNames.some(name => name.endsWith('.zip')), false,
    'plaintext snapshot must be removed after encryption');
  const encryptedPath = path.join(encryptedBackupDir, encryptedArchive);
  assert.ok(fs.statSync(encryptedPath).size > 0);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(encryptedPath).mode & 0o077, 0, 'encrypted archive must be owner-only');
  }

  const decryptedPath = path.join(sandbox, 'decrypted-snapshot.zip');
  const decrypted = spawnSync(agePath, [
    '--decrypt', '--identity', keyFile, '--output', decryptedPath, encryptedPath
  ], { encoding: 'utf8' });
  assert.equal(decrypted.status, 0, decrypted.stderr);

  const zip = new AdmZip(decryptedPath);
  const names = zip.getEntries().map(entry => entry.entryName);
  assert.equal(names.includes('data/deadletters.db'), true);
  assert.equal(names.includes('uploads/camera.jpg'), true);
});
