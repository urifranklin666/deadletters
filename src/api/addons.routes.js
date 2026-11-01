const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const multer = require('multer');
const config = require('../config');
const { getDb } = require('../core/db');
const { requireAuth } = require('../core/auth');
const hooks = require('../core/hooks');

const router = express.Router();
const upload = multer({ dest: path.join(config.dataDir, 'temp_uploads') });

// Load Addon Modules into runtime
function loadAddonsIntoRuntime() {
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
            console.log(`[Addons Engine] Activated "${meta.name}" (${slug})`);
          }
        }
      }
    } catch (err) {
      console.error(`[Addons Engine] Failed to load addon "${slug}":`, err.message);
    }
  });
}

// GET /api/v1/addons
router.get('/', (req, res) => {
  const db = getDb();
  const addons = [];

  if (fs.existsSync(config.addonsDir)) {
    const dirs = fs.readdirSync(config.addonsDir);
    dirs.forEach(slug => {
      const jsonPath = path.join(config.addonsDir, slug, 'addon.json');
      if (fs.existsSync(jsonPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          const dbRow = db.prepare('SELECT is_active, settings FROM dl_addons WHERE slug = ?').get(slug);
          addons.push({
            ...meta,
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
router.post('/:slug/toggle', requireAuth, (req, res) => {
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
router.get('/hooks', requireAuth, (req, res) => {
  res.json(hooks.getIntrospection());
});

// POST /api/v1/addons/upload-zip
router.post('/upload-zip', requireAuth, upload.single('addon_zip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No addon zip package supplied.' });
  }

  try {
    const zip = new AdmZip(req.file.path);
    const zipEntries = zip.getEntries();
    const manifestEntry = zipEntries.find(e => e.entryName.endsWith('addon.json'));

    if (!manifestEntry) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid addon package: missing addon.json manifest.' });
    }

    const meta = JSON.parse(manifestEntry.getData().toString('utf8'));
    const slug = meta.slug || path.basename(req.file.originalname, '.zip').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const destDir = path.join(config.addonsDir, slug);

    zip.extractAllTo(destDir, true);
    fs.unlinkSync(req.file.path);

    loadAddonsIntoRuntime();

    res.status(201).json({
      message: `Addon "${meta.name || slug}" successfully installed and hotloaded into runtime.`,
      slug
    });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to extract addon zip: ' + err.message });
  }
});

module.exports = {
  router,
  loadAddonsIntoRuntime
};
