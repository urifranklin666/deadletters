const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, getOption, updateOption } = require('../core/db');
const { optionalAuth, requireAuth } = require('../core/auth');
const { CAPABILITIES, hasCapability, requireCapability } = require('../core/capabilities');
const multer = require('multer');
const { packageEngineZip, packageSiteSnapshot } = require('../core/exporter');
const { exportWxr, importWxr, MAX_WXR_XML_BYTES } = require('../core/wxr');
const hooks = require('../core/hooks');

const router = express.Router();
const upload = multer({
  dest: path.join(config.dataDir, 'temp_uploads'),
  limits: { fileSize: MAX_WXR_XML_BYTES, files: 1, fields: 0, parts: 1 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.xml') {
      const error = new Error('WordPress imports must use an .xml file.');
      error.status = 400;
      return cb(error);
    }
    cb(null, true);
  }
});

function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[Settings API] Unable to clean temporary upload:', error.message);
  }
}

function wxrUploadMiddleware(req, res, next) {
  upload.single('wxr_file')(req, res, error => {
    if (!error) return next();
    cleanupUploadedFile(req.file?.path);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: `WordPress import rejected: ${error.message}` });
  });
}

const SETTINGS_DEFAULTS = Object.freeze({
  site_title: 'Deadletters // Deadplug Atelier',
  site_tagline: 'the plug is dead. stay wired.',
  site_node_handle: '@deadplug/main-node',
  site_url: 'http://localhost:3000',
  admin_email: 'clown@deadplug.digital',
  active_theme: 'deadplug-editorial',
  permalink_structure: '/letter/%postname%',
  default_comment_approved: '0',
  posts_per_page: '12',
  front_page_display: 'posts',
  page_on_front: 0,
  reshares_enabled: '1',
  deadplug_atelier_branding: '1'
});

// Fields the public reader genuinely needs. Administrative identity,
// moderation policy, and permalink internals stay private.
const PUBLIC_SETTING_KEYS = Object.freeze([
  'site_title',
  'site_tagline',
  'site_node_handle',
  'site_url',
  'active_theme',
  'posts_per_page',
  'front_page_display',
  'page_on_front',
  'reshares_enabled',
  'deadplug_atelier_branding'
]);

const MANAGED_SETTING_KEYS = Object.freeze([
  ...PUBLIC_SETTING_KEYS.slice(0, 4),
  'admin_email',
  'permalink_structure',
  'default_comment_approved',
  ...PUBLIC_SETTING_KEYS.slice(4)
]);

const STRING_SETTING_KEYS = new Set([
  'site_title',
  'site_tagline',
  'site_node_handle',
  'site_url',
  'admin_email',
  'active_theme',
  'permalink_structure',
  'default_comment_approved',
  'front_page_display',
  'reshares_enabled',
  'deadplug_atelier_branding'
]);
const NUMBER_SETTING_KEYS = new Set(['posts_per_page', 'page_on_front']);

function readSettings(keys) {
  const settings = {};
  for (const key of keys) {
    const value = getOption(key, SETTINGS_DEFAULTS[key]);
    if (STRING_SETTING_KEYS.has(key)) {
      settings[key] = value === null || value === undefined ? value : String(value);
    } else if (NUMBER_SETTING_KEYS.has(key)) {
      const parsed = Number(value);
      settings[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      settings[key] = value;
    }
  }
  settings.meta = config.meta;
  return settings;
}

function validationError(key, message) {
  return { error: `Invalid settings value for "${key}": ${message}` };
}

function boundedString(value, { key, min, max }) {
  if (typeof value !== 'string') return validationError(key, 'must be a string.');
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    return validationError(key, `must contain between ${min} and ${max} characters.`);
  }
  return { value: normalized };
}

function boundedInteger(value, { key, min, max }) {
  const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
  if (!/^-?\d+$/.test(text)) return validationError(key, 'must be an integer.');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return validationError(key, `must be an integer between ${min} and ${max}.`);
  }
  return { value: parsed };
}

function enumValue(value, { key, allowed }) {
  const normalized = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
  if (!allowed.includes(normalized)) {
    return validationError(key, `must be one of: ${allowed.join(', ')}.`);
  }
  return { value: normalized };
}

const SETTING_VALIDATORS = Object.freeze({
  site_title: value => boundedString(value, { key: 'site_title', min: 1, max: 200 }),
  site_tagline: value => boundedString(value, { key: 'site_tagline', min: 0, max: 500 }),
  site_node_handle: value => boundedString(value, { key: 'site_node_handle', min: 1, max: 100 }),
  site_url: value => {
    if (typeof value !== 'string' || !value.trim()) {
      return validationError('site_url', 'must be a valid HTTP(S) URL without credentials.');
    }
    try {
      const parsed = new URL(value.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return validationError('site_url', 'must be a valid HTTP(S) URL without credentials.');
      }
      return { value: parsed.href.replace(/\/$/, '') };
    } catch {
      return validationError('site_url', 'must be a valid HTTP(S) URL without credentials.');
    }
  },
  admin_email: value => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return validationError('admin_email', 'must be a valid email address.');
    }
    return { value: normalized };
  },
  permalink_structure: value => {
    if (typeof value !== 'string' || value.trim() !== '/letter/%postname%') {
      return validationError(
        'permalink_structure',
        'only the canonical "/letter/%postname%" structure is supported.'
      );
    }
    return { value: '/letter/%postname%' };
  },
  default_comment_approved: value => enumValue(value, { key: 'default_comment_approved', allowed: ['0', '1'] }),
  posts_per_page: value => boundedInteger(value, { key: 'posts_per_page', min: 1, max: 100 }),
  front_page_display: value => enumValue(value, { key: 'front_page_display', allowed: ['posts', 'page'] }),
  page_on_front: value => boundedInteger(value, { key: 'page_on_front', min: 0, max: 2147483647 }),
  reshares_enabled: value => enumValue(value, { key: 'reshares_enabled', allowed: ['0', '1'] }),
  deadplug_atelier_branding: value => enumValue(value, {
    key: 'deadplug_atelier_branding',
    allowed: ['0', '1']
  })
});

// GET /api/v1/settings
router.get('/', optionalAuth, (req, res) => {
  const canManageSettings = Boolean(req.user) &&
    hasCapability(req.user, CAPABILITIES.SETTINGS_MANAGE);

  res.json(readSettings(canManageSettings ? MANAGED_SETTING_KEYS : PUBLIC_SETTING_KEYS));
});

// PUT /api/v1/settings
router.put('/', requireAuth, requireCapability(CAPABILITIES.SETTINGS_MANAGE), (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Settings payload must be a JSON object.' });
  }

  const accepted = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)) continue;
    const result = SETTING_VALIDATORS[key](value);
    if (result.error) return res.status(400).json(result);
    accepted[key] = result.value;
  }

  const appliedKeys = Object.keys(accepted);
  const writeSettings = getDb().transaction(() => {
    for (const key of appliedKeys) {
      updateOption(key, accepted[key]);
    }
  });
  writeSettings();

  hooks.doAction('settings_updated', accepted);
  res.json({
    message: 'Engine settings successfully committed to node store.',
    appliedKeys,
    applied: appliedKeys
  });
});

// GET /api/v1/settings/telemetry
router.get('/telemetry', requireAuth, requireCapability(CAPABILITIES.SETTINGS_TELEMETRY), (req, res) => {
  const db = getDb();
  let dbSize = 0;
  if (fs.existsSync(config.dbPath)) {
    dbSize = fs.statSync(config.dbPath).size;
  }

  const postCount = db.prepare('SELECT COUNT(*) as c FROM dl_posts WHERE post_type = ?').get('post').c;
  const pageCount = db.prepare('SELECT COUNT(*) as c FROM dl_posts WHERE post_type = ?').get('page').c;
  const reshareCount = db.prepare('SELECT COUNT(*) as c FROM dl_reshares').get().c;
  const commentCount = db.prepare('SELECT COUNT(*) as c FROM dl_comments').get().c;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM dl_users').get().c;

  let baseTelemetry = {
    engine: config.meta.engine,
    version: config.meta.version,
    creator: config.meta.creator,
    node: process.env.COMPUTERNAME || 'B1GB0X',
    operator: req.user.display_name,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSeconds: Math.round(process.uptime()),
    databaseSizeBytes: dbSize,
    databaseSizeFormatted: `${(dbSize / 1024).toFixed(1)} KB`,
    stats: {
      posts: postCount,
      pages: pageCount,
      reshares: reshareCount,
      comments: commentCount,
      users: userCount
    }
  };

  const finalTelemetry = hooks.applyFilters('system_telemetry', baseTelemetry);
  res.json(finalTelemetry);
});

// POST /api/v1/settings/export-engine-zip
router.post('/export-engine-zip', requireAuth, requireCapability(CAPABILITIES.SETTINGS_EXPORT), (req, res) => {
  try {
    const result = packageEngineZip();
    res.json({
      success: true,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      downloadUrl: `/api/v1/settings/download-zip/${result.filename}`,
      message: 'Deadletters Standalone Engine Distribution package compiled.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to package engine zip: ' + err.message });
  }
});

// POST /api/v1/settings/export-snapshot-zip
router.post('/export-snapshot-zip', requireAuth, requireCapability(CAPABILITIES.SETTINGS_EXPORT), async (req, res) => {
  try {
    const result = await packageSiteSnapshot();
    res.json({
      success: true,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      downloadUrl: `/api/v1/settings/download-zip/${result.filename}`,
      message: 'Complete Site Snapshot Archive package compiled. It contains sensitive configuration; store it securely.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to package site snapshot zip: ' + err.message });
  }
});

// GET /api/v1/settings/download-zip/:filename
router.get('/download-zip/:filename', requireAuth, requireCapability(CAPABILITIES.SETTINGS_EXPORT), (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const targetPath = path.join(config.dataDir, safeFilename);

  if (fs.existsSync(targetPath)) {
    res.download(targetPath, safeFilename);
  } else {
    res.status(404).json({ error: 'Distribution file not found.' });
  }
});

// GET /api/v1/settings/export-wxr (WordPress XML Export)
router.get('/export-wxr', requireAuth, requireCapability(CAPABILITIES.SETTINGS_EXPORT), (req, res) => {
  const xml = exportWxr(`${req.protocol}://${req.get('host')}`);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="deadletters-export.xml"');
  res.send(xml);
});

// POST /api/v1/settings/import-wxr (WordPress XML Import)
router.post('/import-wxr', requireAuth, requireCapability(CAPABILITIES.SETTINGS_MANAGE), wxrUploadMiddleware, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No WordPress XML export file uploaded.' });
  }

  try {
    const xmlContent = fs.readFileSync(req.file.path, 'utf8');
    const result = importWxr(xmlContent, req.user.ID);
    res.json({
      success: true,
      message: `WordPress migration completed! Imported ${result.importedPosts} post(s), ${result.importedPages} page(s), and ${result.importedComments} comment(s); skipped ${result.skippedItems} unsupported item(s).`,
      stats: result
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to import WordPress XML: ' + err.message });
  } finally {
    cleanupUploadedFile(req.file.path);
  }
});

module.exports = router;
