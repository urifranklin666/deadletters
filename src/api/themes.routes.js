const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const multer = require('multer');
const config = require('../config');
const { getDb, getOption, updateOption } = require('../core/db');
const { requireAuth } = require('../core/auth');
const hooks = require('../core/hooks');

const router = express.Router();
const upload = multer({ dest: path.join(config.dataDir, 'temp_uploads') });

// GET /api/v1/themes
router.get('/', (req, res) => {
  const activeSlug = getOption('active_theme', 'deadplug-editorial');
  const themes = [];

  if (fs.existsSync(config.themesDir)) {
    const dirs = fs.readdirSync(config.themesDir);
    dirs.forEach(slug => {
      const jsonPath = path.join(config.themesDir, slug, 'theme.json');
      if (fs.existsSync(jsonPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          themes.push({
            ...meta,
            slug,
            isActive: slug === activeSlug
          });
        } catch (e) {
          console.error(`[Themes API] Error loading ${slug}:`, e.message);
        }
      }
    });
  }

  res.json({ themes, activeTheme: activeSlug });
});

// GET /api/v1/themes/active
router.get('/active', (req, res) => {
  const db = getDb();
  const activeSlug = getOption('active_theme', 'deadplug-editorial');
  const jsonPath = path.join(config.themesDir, activeSlug, 'theme.json');
  let meta = { slug: activeSlug, name: activeSlug, defaults: {} };

  if (fs.existsSync(jsonPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {}
  }

  // Check custom saved tokens
  const savedTokens = db.prepare('SELECT tokens_json, custom_css FROM dl_theme_tokens WHERE theme_slug = ?').get(activeSlug);
  let customTokens = {};
  let customCss = '';

  if (savedTokens) {
    try { customTokens = JSON.parse(savedTokens.tokens_json || '{}'); } catch {}
    customCss = savedTokens.custom_css || '';
  }

  res.json({
    activeTheme: {
      ...meta,
      slug: activeSlug,
      tokens: { ...meta.defaults, ...customTokens },
      customCss
    }
  });
});

// POST /api/v1/themes/activate
router.post('/activate', requireAuth, (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'Theme slug required.' });

  const themeDir = path.join(config.themesDir, slug);
  if (!fs.existsSync(themeDir)) {
    return res.status(404).json({ error: 'Theme package not installed on this node.' });
  }

  updateOption('active_theme', slug);
  hooks.doAction('theme_activated', slug);

  res.json({ message: `Theme switched to "${slug}". Atelier layout refactored.` });
});

// GET /api/v1/themes/tokens/:themeSlug
router.get('/tokens/:themeSlug', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT tokens_json, custom_css FROM dl_theme_tokens WHERE theme_slug = ?').get(req.params.themeSlug);
  if (!row) {
    return res.json({ tokens: {}, customCss: '' });
  }
  res.json({
    tokens: JSON.parse(row.tokens_json || '{}'),
    customCss: row.custom_css || ''
  });
});

// POST /api/v1/themes/tokens/:themeSlug (Save Theme Studio Customizer)
router.post('/tokens/:themeSlug', requireAuth, (req, res) => {
  const db = getDb();
  const slug = req.params.themeSlug;
  const { tokens, customCss = '' } = req.body;

  const tokensStr = JSON.stringify(tokens || {});
  const exists = db.prepare('SELECT id FROM dl_theme_tokens WHERE theme_slug = ?').get(slug);

  if (exists) {
    db.prepare('UPDATE dl_theme_tokens SET tokens_json = ?, custom_css = ?, updated_at = CURRENT_TIMESTAMP WHERE theme_slug = ?').run(tokensStr, customCss, slug);
  } else {
    db.prepare('INSERT INTO dl_theme_tokens (theme_slug, tokens_json, custom_css) VALUES (?, ?, ?)').run(slug, tokensStr, customCss);
  }

  res.json({ message: 'Theme design tokens synchronized with atelier live customizer.' });
});

// POST /api/v1/themes/upload-zip (Theme Installer)
router.post('/upload-zip', requireAuth, upload.single('theme_zip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No theme zip file provided.' });
  }

  try {
    const zip = new AdmZip(req.file.path);
    const zipEntries = zip.getEntries();
    let themeJsonEntry = zipEntries.find(e => e.entryName.endsWith('theme.json'));

    if (!themeJsonEntry) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid theme bundle: missing theme.json manifest.' });
    }

    const themeMeta = JSON.parse(themeJsonEntry.getData().toString('utf8'));
    const slug = themeMeta.slug || path.basename(req.file.originalname, '.zip').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const destDir = path.join(config.themesDir, slug);

    zip.extractAllTo(destDir, true);
    fs.unlinkSync(req.file.path);

    res.status(201).json({
      message: `Theme "${themeMeta.name || slug}" successfully installed into atelier.`,
      slug
    });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to extract theme zip: ' + err.message });
  }
});

module.exports = router;
