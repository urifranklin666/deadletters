const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const multer = require('multer');
const config = require('../config');
const { getDb } = require('../core/db');
const { requireAuth } = require('../core/auth');
const { CAPABILITIES, requireCapability } = require('../core/capabilities');
const hooks = require('../core/hooks');
const {
  ARCHIVE_UPLOAD_FILE_SIZE,
  ArchiveSecurityError,
  validateArchiveEntries,
  readArchiveManifest,
  resolveContainedPath,
  resolveInstallDestination
} = require('../core/archive-security');

const router = express.Router();
const loadedAddonSlugs = new Set();
const upload = multer({
  dest: path.join(config.dataDir, 'temp_uploads'),
  limits: { fileSize: ARCHIVE_UPLOAD_FILE_SIZE, files: 1, fields: 0, parts: 1 }
});

function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[Addons API] Unable to clean temporary upload:', error.message);
  }
}

function cleanupInstalledDirectory(directory) {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn('[Addons API] Unable to roll back incomplete installation:', error.message);
  }
}

function addonUploadMiddleware(req, res, next) {
  upload.single('addon_zip')(req, res, error => {
    if (!error) return next();
    cleanupUploadedFile(req.file?.path);
    res.status(400).json({ error: `Addon upload rejected: ${error.message}` });
  });
}

// Load Addon Modules into runtime
function loadAddonsIntoRuntime() {
  for (const slug of loadedAddonSlugs) hooks.removeAddon(slug);
  loadedAddonSlugs.clear();

  const db = getDb();
  if (!fs.existsSync(config.addonsDir)) return;

  const dirs = fs.readdirSync(config.addonsDir);
  dirs.forEach(slug => {
    const jsonPath = path.join(config.addonsDir, slug, 'addon.json');
    if (!fs.existsSync(jsonPath)) return;

    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      // Check db active status
      let row = db.prepare('SELECT is_active FROM dl_addons WHERE slug = ?').get(slug);
      if (!row) {
        db.prepare(`
          INSERT INTO dl_addons (slug, name, version, description, author, is_active, settings)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(slug, meta.name, meta.version, meta.description, meta.author, meta.is_active ? 1 : 0, JSON.stringify(meta.settings || {}));
        row = { is_active: meta.is_active ? 1 : 0 };
      }

      if (row.is_active === 1) {
        const entryFile = path.join(config.addonsDir, slug, meta.entry || 'index.js');
        if (fs.existsSync(entryFile)) {
          // Clear require cache for dynamic reload
          delete require.cache[require.resolve(entryFile)];
          const addonFn = require(entryFile);
          if (typeof addonFn === 'function') {
            const context = {
              getDb: () => db,
              getOption: (k, d) => require('../core/db').getOption(k, d),
              config
            };
            addonFn(hooks, context);
            loadedAddonSlugs.add(slug);
            console.log(`[Addons Engine] Activated "${meta.name}" (${slug})`);
          }
        }
      }
    } catch (err) {
      console.error(`[Addons Engine] Failed to load addon "${slug}":`, err.message);
    }
  });
}

function sanitizeAddonManifest(meta = {}) {
  const publicFields = ['name', 'version', 'description', 'author'];
  return Object.fromEntries(
    publicFields
      .filter(field => meta[field] !== undefined)
      .map(field => [field, meta[field]])
  );
}

// GET /api/v1/addons
router.get('/', requireAuth, requireCapability(CAPABILITIES.ADDONS_MANAGE), (req, res) => {
  const db = getDb();
  const addons = [];

  if (fs.existsSync(config.addonsDir)) {
    const dirs = fs.readdirSync(config.addonsDir);
    dirs.forEach(slug => {
      const jsonPath = path.join(config.addonsDir, slug, 'addon.json');
      if (fs.existsSync(jsonPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          const dbRow = db.prepare('SELECT is_active FROM dl_addons WHERE slug = ?').get(slug);
          addons.push({
            ...sanitizeAddonManifest(meta),
            slug,
            isActive: dbRow ? dbRow.is_active === 1 : (meta.is_active === 1)
          });
        } catch (e) {
          console.error(`[Addons API] Error reading ${slug}:`, e.message);
        }
      }
    });
  }

  res.json({ addons });
});

// POST /api/v1/addons/:slug/toggle
router.post('/:slug/toggle', requireAuth, requireCapability(CAPABILITIES.ADDONS_MANAGE), (req, res) => {
  const db = getDb();
  const slug = req.params.slug;
  const jsonPath = path.join(config.addonsDir, slug, 'addon.json');

  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: 'Addon not found on node filesystem.' });
  }

  const row = db.prepare('SELECT is_active FROM dl_addons WHERE slug = ?').get(slug);
  const currentStatus = row ? row.is_active : 0;
  const newStatus = currentStatus === 1 ? 0 : 1;

  if (row) {
    db.prepare('UPDATE dl_addons SET is_active = ? WHERE slug = ?').run(newStatus, slug);
  } else {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    db.prepare(`
      INSERT INTO dl_addons (slug, name, version, description, author, is_active, settings)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(slug, meta.name, meta.version, meta.description, meta.author, newStatus, JSON.stringify(meta.settings || {}));
  }

  // Reload hooks
  loadAddonsIntoRuntime();

  res.json({
    message: `Addon "${slug}" is now ${newStatus === 1 ? 'ACTIVE' : 'DEACTIVATED'}.`,
    isActive: newStatus === 1
  });
});

// GET /api/v1/addons/hooks (Introspection)
router.get('/hooks', requireAuth, requireCapability(CAPABILITIES.ADDONS_MANAGE), (req, res) => {
  res.json(hooks.getIntrospection());
});

// POST /api/v1/addons/upload-zip
router.post('/upload-zip', requireAuth, requireCapability(CAPABILITIES.ADDONS_MANAGE), addonUploadMiddleware, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No addon zip package supplied.' });
  }

  const temporaryPath = req.file.path;
  let destDir = null;
  let createdDestination = false;

  try {
    let zip;
    let zipEntries;
    try {
      zip = new AdmZip(temporaryPath);
      zipEntries = zip.getEntries();
    } catch {
      throw new ArchiveSecurityError('invalid or unsupported ZIP archive.');
    }

    validateArchiveEntries(zipEntries);
    const meta = readArchiveManifest(zipEntries, 'addon.json');
    const slug = meta.slug;
    destDir = resolveInstallDestination(config.addonsDir, slug);

    for (const entry of zipEntries) {
      resolveContainedPath(destDir, entry.entryName);
    }

    if (fs.existsSync(destDir)) {
      return res.status(409).json({ error: `Addon "${slug}" is already installed.` });
    }
    if (!zip.test()) {
      throw new ArchiveSecurityError('archive contents are corrupt, encrypted, or unsupported.');
    }

    try {
      fs.mkdirSync(destDir, { recursive: false });
      createdDestination = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return res.status(409).json({ error: `Addon "${slug}" is already installed.` });
      }
      throw error;
    }

    zip.extractAllTo(destDir, false, false);
    loadAddonsIntoRuntime();

    res.status(201).json({
      message: `Addon "${typeof meta.name === 'string' && meta.name ? meta.name : slug}" successfully installed and hotloaded into runtime.`,
      slug
    });
  } catch (err) {
    if (createdDestination) cleanupInstalledDirectory(destDir);
    if (err instanceof ArchiveSecurityError) {
      return res.status(400).json({ error: 'Invalid addon package: ' + err.message });
    }
    res.status(500).json({ error: 'Failed to extract addon zip: ' + err.message });
  } finally {
    cleanupUploadedFile(temporaryPath);
  }
});

module.exports = {
  router,
  loadAddonsIntoRuntime,
  sanitizeAddonManifest
};
