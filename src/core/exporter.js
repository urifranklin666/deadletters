'use strict';

const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');
const { getDb } = require('./db');
const {
  ArchiveSecurityError,
  resolveContainedPath,
  validateArchiveEntries,
  validateArchiveEntryName
} = require('./archive-security');

// Engine archives are source distributions, not recursive copies of a working
// checkout. Add new runtime source files here deliberately when they are added.
const ENGINE_SOURCE_FILES = Object.freeze([
  'bin/deadletters.js',
  'package.json',
  'package-lock.json',
  'README.md',
  'scripts/check-syntax.js',
  'src/server.js',
  'src/config.js',
  'src/api/addons.routes.js',
  'src/api/auth.routes.js',
  'src/api/comments.routes.js',
  'src/api/federation.routes.js',
  'src/api/installer.routes.js',
  'src/api/media.routes.js',
  'src/api/posts.routes.js',
  'src/api/reshares.routes.js',
  'src/api/settings.routes.js',
  'src/api/taxonomies.routes.js',
  'src/api/themes.routes.js',
  'src/core/archive-security.js',
  'src/core/auth.js',
  'src/core/capabilities.js',
  'src/core/content-renderer.js',
  'src/core/db.js',
  'src/core/exporter.js',
  'src/core/external-metadata.js',
  'src/core/federation.js',
  'src/core/file-validation.js',
  'src/core/hooks.js',
  'src/core/migrations.js',
  'src/core/provenance.js',
  'src/core/public-shell.js',
  'src/core/rate-limit.js',
  'src/core/reshare-engine.js',
  'src/core/schema.js',
  'src/core/wp-compat.js',
  'src/core/wxr.js',
  'src/addons/brutalist-markdown/addon.json',
  'src/addons/brutalist-markdown/index.js',
  'src/addons/deadletter-mesh/addon.json',
  'src/addons/deadletter-mesh/index.js',
  'src/addons/seo-guardian/addon.json',
  'src/addons/seo-guardian/index.js',
  'src/addons/telemetry-vault/addon.json',
  'src/addons/telemetry-vault/index.js',
  'src/themes/deadplug-editorial/style.css',
  'src/themes/deadplug-editorial/theme.json',
  'src/themes/monolith-cyberpunk/style.css',
  'src/themes/monolith-cyberpunk/theme.json',
  'src/themes/suisse-minimal/style.css',
  'src/themes/suisse-minimal/theme.json',
  'public/app/css/admin.css',
  'public/app/css/deadletters.css',
  'public/app/index.html',
  'public/app/js/addons-view.js',
  'public/app/js/api.js',
  'public/app/js/app.js',
  'public/app/js/blog-reader.js',
  'public/app/js/comments-view.js',
  'public/app/js/dashboard.js',
  'public/app/js/federation-view.js',
  'public/app/js/editor.js',
  'public/app/js/installer.js',
  'public/app/js/media-vault.js',
  'public/app/js/pages-view.js',
  'public/app/js/reshare-hub.js',
  'public/app/js/settings-view.js',
  'public/app/js/theme-studio.js',
  'public/app/js/users-view.js'
]);

// These are the only files packaged from the default public upload directory.
// Any other file there is treated as user content and stays out of the engine.
const ENGINE_DEMO_IMAGES = Object.freeze([
  'public/uploads/deadplug_editorial_cover.jpg',
  'public/uploads/deadplug_monolith_architecture.jpg',
  'public/uploads/deadplug_operator_avatar.jpg'
]);

const SNAPSHOT_ROOTS = Object.freeze(['data', 'uploads', 'themes', 'addons']);
const SNAPSHOT_ASSET_ROOTS = new Set(['uploads', 'themes', 'addons']);
const DEADLETTERS_TABLES = Object.freeze(['dl_options', 'dl_posts', 'dl_users']);

function resolveOutputPath(outputPath, fallbackPath) {
  const targetPath = path.resolve(outputPath || fallbackPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return targetPath;
}

function addAllowlistedFile(zip, rootDir, relativePath, optional = false) {
  const sourcePath = path.join(rootDir, ...relativePath.split('/'));
  if (!fs.existsSync(sourcePath)) {
    if (optional) return;
    throw new Error(`Required engine source file is missing: ${relativePath}`);
  }

  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Engine source allowlist entry is not a regular file: ${relativePath}`);
  }
  zip.addLocalFile(sourcePath, path.posix.dirname(relativePath), path.posix.basename(relativePath));
}

function createBootstrapInstaller() {
  return `#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

console.log('==========================================');
console.log('  DEADLETTERS ENGINE // DEADPLUG.DIGITAL');
console.log('  The plug is dead. Stay wired.');
console.log('==========================================');

console.log('[1/2] Installing locked production dependencies with npm ci --omit=dev...');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installation = spawnSync(npmCommand, ['ci', '--omit=dev'], { stdio: 'inherit' });
if (installation.error) {
  console.error('Deadletters installation failed: unable to run npm ci --omit=dev: ' + installation.error.message);
  process.exit(1);
}
if (installation.status !== 0) {
  console.error('Deadletters installation failed: npm ci --omit=dev exited with status ' + installation.status + '.');
  process.exit(installation.status || 1);
}

console.log('[2/2] Starting Deadletters...');
const { startServer } = require('./src/server.js');
startServer();
`;
}

/**
 * Package a clean, installable engine without runtime content or credentials.
 */
function packageEngineZip(outputPath = null) {
  const rootDir = path.resolve(__dirname, '..', '..');
  const targetZipPath = resolveOutputPath(
    outputPath,
    path.join(config.dataDir, `deadletters-engine-v${config.meta.version}.zip`)
  );
  const zip = new AdmZip();

  for (const relativePath of ENGINE_SOURCE_FILES) {
    addAllowlistedFile(zip, rootDir, relativePath);
  }
  for (const relativePath of ENGINE_DEMO_IMAGES) {
    addAllowlistedFile(zip, rootDir, relativePath, true);
  }

  zip.addFile('install.js', Buffer.from(createBootstrapInstaller(), 'utf8'));
  zip.writeZip(targetZipPath);

  return {
    success: true,
    zipPath: targetZipPath,
    filename: path.basename(targetZipPath),
    sizeBytes: fs.statSync(targetZipPath).size
  };
}

function isExcludedSnapshotPath(relativePath) {
  const segments = relativePath.split('/');
  const lowerSegments = segments.map(segment => segment.toLowerCase());
  const filename = lowerSegments[lowerSegments.length - 1];

  if (lowerSegments.some(segment => (
    segment === '.git' ||
    segment === 'node_modules' ||
    segment === 'temp' ||
    segment === 'tmp' ||
    segment === 'temp_uploads'
  ))) return true;

  return filename.endsWith('.zip') ||
    filename.endsWith('.tmp') ||
    filename.endsWith('.temp') ||
    filename.endsWith('.swp') ||
    filename.endsWith('.part') ||
    filename.endsWith('.partial') ||
    filename.endsWith('~') ||
    filename.endsWith('-wal') ||
    filename.endsWith('-shm') ||
    filename.endsWith('.wal') ||
    filename.endsWith('.shm') ||
    /\.(?:db|sqlite|sqlite3)$/.test(filename);
}

function addSnapshotTree(zip, sourceDirectory, archiveRoot) {
  zip.addFile(`${archiveRoot}/`, Buffer.alloc(0));
  if (!fs.existsSync(sourceDirectory)) return;

  const sourceStat = fs.lstatSync(sourceDirectory);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Snapshot source is not a regular directory: ${sourceDirectory}`);
  }

  function visit(directory, relativeDirectory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (isExcludedSnapshotPath(relativePath)) continue;

      validateArchiveEntryName(`${archiveRoot}/${relativePath}`);
      const sourcePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        const archivePath = `${archiveRoot}/${relativePath}`;
        zip.addFile(`${archivePath}/`, Buffer.alloc(0));
        visit(sourcePath, relativePath);
      } else if (stat.isFile()) {
        const parent = path.posix.dirname(relativePath);
        zip.addLocalFile(
          sourcePath,
          parent === '.' ? archiveRoot : `${archiveRoot}/${parent}`,
          path.posix.basename(relativePath)
        );
      }
    }
  }

  visit(sourceDirectory, '');
}

/**
 * Package a transactionally consistent SQLite backup plus site assets.
 * config.json is intentionally included when present and contains secrets.
 */
async function packageSiteSnapshot(outputPath = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetZipPath = resolveOutputPath(
    outputPath,
    path.join(config.dataDir, `deadletters-site-snapshot-${timestamp}.zip`)
  );
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-snapshot-'));
  const backupPath = path.join(temporaryDirectory, 'deadletters.db');

  try {
    // better-sqlite3 coordinates this backup with the live connection, including
    // commits still represented by WAL. Never copy db/WAL/SHM files directly.
    await getDb().backup(backupPath);

    const zip = new AdmZip();
    zip.addLocalFile(backupPath, 'data', 'deadletters.db');
    if (fs.existsSync(config.configFile)) {
      const configStat = fs.lstatSync(config.configFile);
      if (!configStat.isFile() || configStat.isSymbolicLink()) {
        throw new Error(`Snapshot configuration is not a regular file: ${config.configFile}`);
      }
      zip.addLocalFile(config.configFile, 'data', 'config.json');
    }

    addSnapshotTree(zip, config.uploadsDir, 'uploads');
    addSnapshotTree(zip, config.themesDir, 'themes');
    addSnapshotTree(zip, config.addonsDir, 'addons');

    zip.writeZip(targetZipPath);
    // Snapshots can contain saved JWT/provenance secrets. Do not leave a new
    // archive world-readable on systems with a permissive umask.
    fs.chmodSync(targetZipPath, 0o600);
    return {
      success: true,
      zipPath: targetZipPath,
      filename: path.basename(targetZipPath),
      sizeBytes: fs.statSync(targetZipPath).size
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function snapshotEntryParts(entry) {
  const isDirectory = entry.isDirectory || entry.entryName.endsWith('/');
  const withoutTrailingSlash = entry.entryName.replace(/\/+$/, '');
  const parts = withoutTrailingSlash.split('/');

  if (!withoutTrailingSlash || parts.some(part => !part || part === '.' || part === '..')) {
    throw new ArchiveSecurityError(`snapshot contains an invalid entry path "${entry.entryName}".`);
  }
  if (!SNAPSHOT_ROOTS.includes(parts[0])) {
    throw new ArchiveSecurityError(`snapshot contains unexpected top-level path "${parts[0]}".`);
  }

  return { isDirectory, parts, canonicalName: parts.join('/') };
}

function validateSnapshotEntries(entries) {
  const entryKinds = new Map();
  let databaseEntries = 0;

  for (const entry of entries) {
    const { isDirectory, parts, canonicalName } = snapshotEntryParts(entry);
    if (entryKinds.has(canonicalName)) {
      throw new ArchiveSecurityError(`snapshot contains duplicate path "${canonicalName}".`);
    }
    entryKinds.set(canonicalName, isDirectory ? 'directory' : 'file');

    const root = parts[0];
    if (root === 'data') {
      if (isDirectory && parts.length !== 1) {
        throw new ArchiveSecurityError('snapshot data/ may only contain deadletters.db and config.json.');
      }
      if (!isDirectory && canonicalName === 'data/deadletters.db') {
        databaseEntries += 1;
      } else if (!isDirectory && canonicalName !== 'data/config.json') {
        throw new ArchiveSecurityError(`snapshot contains unexpected data path "${canonicalName}".`);
      } else if (isDirectory && parts.length === 1) {
        continue;
      }
    } else if (!SNAPSHOT_ASSET_ROOTS.has(root)) {
      throw new ArchiveSecurityError(`snapshot contains unexpected top-level path "${root}".`);
    } else if (!isDirectory && parts.length === 1) {
      throw new ArchiveSecurityError(`snapshot asset root "${canonicalName}" must be a directory.`);
    }
  }

  if (databaseEntries !== 1) {
    throw new ArchiveSecurityError('snapshot must contain exactly one data/deadletters.db file.');
  }

  // A file used as another entry's parent would make extraction order unsafe.
  for (const canonicalName of entryKinds.keys()) {
    const parts = canonicalName.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (entryKinds.get(parent) === 'file') {
        throw new ArchiveSecurityError(`snapshot path "${canonicalName}" has a file as its parent directory.`);
      }
    }
  }
}

function inspectRestoreTarget(targetDirectory) {
  try {
    const stat = fs.lstatSync(targetDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('snapshot restore target must be a new or empty directory, not a file or symlink.');
    }
    if (fs.readdirSync(targetDirectory).length !== 0) {
      throw new Error('snapshot restore target must be empty; refusing to overwrite an existing installation.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateSnapshotDatabase(databasePath) {
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const checks = database.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
      throw new ArchiveSecurityError('snapshot database failed SQLite quick_check.');
    }

    const tableNames = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)"
    ).all(...DEADLETTERS_TABLES).map(row => row.name));
    const missingTables = DEADLETTERS_TABLES.filter(table => !tableNames.has(table));
    if (missingTables.length !== 0) {
      throw new ArchiveSecurityError(
        `snapshot database is not a Deadletters database; missing ${missingTables.join(', ')}.`
      );
    }
  } catch (error) {
    if (error instanceof ArchiveSecurityError) throw error;
    throw new ArchiveSecurityError(`snapshot database is not valid SQLite: ${error.message}`);
  } finally {
    if (database) database.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function restoreStartCommand(paths) {
  const environment = {
    DEADLETTERS_DATA_DIR: paths.dataDir,
    DEADLETTERS_UPLOADS_DIR: paths.uploadsDir,
    DEADLETTERS_THEMES_DIR: paths.themesDir,
    DEADLETTERS_ADDONS_DIR: paths.addonsDir,
    DB_PATH: paths.dbPath
  };
  const assignments = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(' ');
  return { environment, startCommand: `env ${assignments} npm start` };
}

/**
 * Validate and restore a snapshot without overwriting an existing installation.
 * The target may be absent or an existing empty directory.
 */
async function restoreSiteSnapshot(archivePath, targetDirectory, options = {}) {
  if (typeof archivePath !== 'string' || !archivePath) {
    throw new TypeError('snapshot archive path is required.');
  }
  if (typeof targetDirectory !== 'string' || !targetDirectory) {
    throw new TypeError('snapshot restore target directory is required.');
  }

  const sourceArchive = path.resolve(archivePath);
  const resolvedTarget = path.resolve(targetDirectory);
  inspectRestoreTarget(resolvedTarget);

  let zip;
  try {
    zip = new AdmZip(sourceArchive);
  } catch (error) {
    throw new ArchiveSecurityError(`unable to read snapshot archive: ${error.message}`);
  }

  const entries = zip.getEntries();
  validateArchiveEntries(entries, {
    destinationRoot: resolvedTarget,
    ...(options.archiveLimits || {})
  });
  validateSnapshotEntries(entries);

  const targetExisted = inspectRestoreTarget(resolvedTarget);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-restore-'));
  const validationDatabasePath = path.join(temporaryDirectory, 'deadletters.db');

  try {
    const databaseEntry = entries.find(entry => entry.entryName === 'data/deadletters.db' && !entry.isDirectory);
    fs.writeFileSync(validationDatabasePath, databaseEntry.getData(), { flag: 'wx' });
    validateSnapshotDatabase(validationDatabasePath);

    // Re-check immediately before creating anything in case the target changed
    // while the archive was being read and its database was being validated.
    if (inspectRestoreTarget(resolvedTarget) !== targetExisted) {
      throw new Error('snapshot restore target changed during validation; refusing to continue.');
    }
    if (!targetExisted) fs.mkdirSync(resolvedTarget, { recursive: true });

    try {
      for (const entry of entries) {
        const destination = resolveContainedPath(resolvedTarget, entry.entryName);
        if (entry.isDirectory || entry.entryName.endsWith('/')) {
          fs.mkdirSync(destination, { recursive: true });
          continue;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const mode = entry.entryName === 'data/config.json' || entry.entryName === 'data/deadletters.db'
          ? 0o600
          : 0o644;
        fs.writeFileSync(destination, entry.getData(), { flag: 'wx', mode });
      }
    } catch (error) {
      // The target was empty before extraction. Remove only the four snapshot
      // roots on failure, and remove the target itself only if we created it.
      for (const root of SNAPSHOT_ROOTS) {
        fs.rmSync(path.join(resolvedTarget, root), { recursive: true, force: true });
      }
      if (!targetExisted) fs.rmSync(resolvedTarget, { recursive: true, force: true });
      throw error;
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const paths = {
    dataDir: path.join(resolvedTarget, 'data'),
    dbPath: path.join(resolvedTarget, 'data', 'deadletters.db'),
    uploadsDir: path.join(resolvedTarget, 'uploads'),
    themesDir: path.join(resolvedTarget, 'themes'),
    addonsDir: path.join(resolvedTarget, 'addons')
  };

  return {
    success: true,
    targetDirectory: resolvedTarget,
    paths,
    ...restoreStartCommand(paths)
  };
}

module.exports = {
  packageEngineZip,
  packageSiteSnapshot,
  restoreSiteSnapshot
};
