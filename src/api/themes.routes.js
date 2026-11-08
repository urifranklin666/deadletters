const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const multer = require('multer');
const config = require('../config');
const { getDb, getOption, updateOption } = require('../core/db');
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
const THEME_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const THEME_ASSET_EXTENSIONS = new Set([
  '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.woff', '.woff2', '.ttf', '.otf'
]);
const upload = multer({
  dest: path.join(config.dataDir, 'temp_uploads'),
  limits: { fileSize: ARCHIVE_UPLOAD_FILE_SIZE, files: 1, fields: 0, parts: 1 }
});

function validThemeSlug(slug) {
  return typeof slug === 'string' && THEME_SLUG_PATTERN.test(slug);
}

function ensureSafeThemeAssets(zipEntries) {
  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    const extension = path.posix.extname(entry.entryName.replace(/\\/g, '/')).toLowerCase();
    if (!THEME_ASSET_EXTENSIONS.has(extension)) {
      throw new ArchiveSecurityError(
        `theme packages may contain only CSS, JSON, raster images, and font assets; rejected "${entry.entryName}".`
      );
    }
  }
}

function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[Themes API] Unable to clean temporary upload:', error.message);
  }
}

function cleanupInstalledDirectory(directory) {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn('[Themes API] Unable to roll back incomplete installation:', error.message);
  }
}

function themeUploadMiddleware(req, res, next) {
  upload.single('theme_zip')(req, res, error => {
    if (!error) return next();
    cleanupUploadedFile(req.file?.path);
    res.status(400).json({ error: `Theme upload rejected: ${error.message}` });
  });
}

// GET /api/v1/themes
router.get('/', (req, res) => {
  const configuredSlug = getOption('active_theme', 'deadplug-editorial');
  const activeSlug = validThemeSlug(configuredSlug) ? configuredSlug : 'deadplug-editorial';
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
  const configuredSlug = getOption('active_theme', 'deadplug-editorial');
  const activeSlug = validThemeSlug(configuredSlug) ? configuredSlug : 'deadplug-editorial';
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

// GET /api/v1/themes/active/style.css
router.get('/active/style.css', (req, res) => {
  const activeSlug = getOption('active_theme', 'deadplug-editorial');
  if (!validThemeSlug(activeSlug)) {
    return res.status(404).type('text/plain').send('Active theme is invalid.');
  }

  const stylesheet = path.join(config.themesDir, activeSlug, 'style.css');
  if (!fs.existsSync(stylesheet)) {
    return res.status(404).type('text/plain').send('Active theme stylesheet not found.');
  }

  res.set('Cache-Control', 'no-cache');
  res.type('text/css').send(fs.readFileSync(stylesheet, 'utf8'));
});

// POST /api/v1/themes/activate
router.post('/activate', requireAuth, requireCapability(CAPABILITIES.THEMES_MANAGE), (req, res) => {
  const { slug } = req.body;
  if (!validThemeSlug(slug)) return res.status(400).json({ error: 'A valid theme slug is required.' });

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
  if (!validThemeSlug(req.params.themeSlug)) return res.status(400).json({ error: 'Invalid theme slug.' });
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
router.post('/tokens/:themeSlug', requireAuth, requireCapability(CAPABILITIES.THEMES_MANAGE), (req, res) => {
  const db = getDb();
  const slug = req.params.themeSlug;
  if (!validThemeSlug(slug)) return res.status(400).json({ error: 'Invalid theme slug.' });
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
router.post('/upload-zip', requireAuth, requireCapability(CAPABILITIES.THEMES_MANAGE), themeUploadMiddleware, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No theme zip file provided.' });
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
    ensureSafeThemeAssets(zipEntries);
    const themeMeta = readArchiveManifest(zipEntries, 'theme.json');
    const slug = themeMeta.slug;
    if (!validThemeSlug(slug)) throw new ArchiveSecurityError('theme.json has an invalid slug.');
    destDir = resolveInstallDestination(config.themesDir, slug);

    for (const entry of zipEntries) {
      resolveContainedPath(destDir, entry.entryName);
    }

    if (fs.existsSync(destDir)) {
      return res.status(409).json({ error: `Theme "${slug}" is already installed.` });
    }
    if (!zip.test()) {
      throw new ArchiveSecurityError('archive contents are corrupt, encrypted, or unsupported.');
    }

    try {
      fs.mkdirSync(destDir, { recursive: false });
      createdDestination = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return res.status(409).json({ error: `Theme "${slug}" is already installed.` });
      }
      throw error;
    }

    zip.extractAllTo(destDir, false, false);

    res.status(201).json({
      message: `Theme "${typeof themeMeta.name === 'string' && themeMeta.name ? themeMeta.name : slug}" successfully installed into atelier.`,
      slug
    });
  } catch (err) {
    if (createdDestination) cleanupInstalledDirectory(destDir);
    if (err instanceof ArchiveSecurityError) {
      return res.status(400).json({ error: 'Invalid theme bundle: ' + err.message });
    }
    res.status(500).json({ error: 'Failed to extract theme zip: ' + err.message });
  } finally {
    cleanupUploadedFile(temporaryPath);
  }
});

module.exports = router;
