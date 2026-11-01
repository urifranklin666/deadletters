const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, getOption, updateOption } = require('../core/db');
const { requireAuth, requireRole } = require('../core/auth');
const multer = require('multer');
const { packageEngineZip, packageSiteSnapshot } = require('../core/exporter');
const { exportWxr, importWxr } = require('../core/wxr');
const hooks = require('../core/hooks');

const router = express.Router();
const upload = multer({ dest: path.join(config.dataDir, 'temp_uploads') });

// GET /api/v1/settings
router.get('/', (req, res) => {
  res.json({
    site_title: getOption('site_title', 'Deadletters // Deadplug Atelier'),
    site_tagline: getOption('site_tagline', 'the plug is dead. stay wired.'),
    site_node_handle: getOption('site_node_handle', '@deadplug/main-node'),
    site_url: getOption('site_url', 'http://localhost:3000'),
    admin_email: getOption('admin_email', 'clown@deadplug.digital'),
    active_theme: getOption('active_theme', 'deadplug-editorial'),
    permalink_structure: getOption('permalink_structure', '/letter/%postname%'),
    default_comment_approved: getOption('default_comment_approved', '1'),
    posts_per_page: getOption('posts_per_page', '12'),
    front_page_display: getOption('front_page_display', 'posts'),
    page_on_front: getOption('page_on_front', 0),
    reshares_enabled: getOption('reshares_enabled', '1'),
    deadplug_atelier_branding: getOption('deadplug_atelier_branding', '1'),
    meta: config.meta
  });
});

// PUT /api/v1/settings
router.put('/', requireAuth, requireRole('superadmin'), (req, res) => {
  const allowedKeys = [
    'site_title',
    'site_tagline',
    'site_node_handle',
    'site_url',
    'admin_email',
    'permalink_structure',
    'default_comment_approved',
    'posts_per_page',
    'front_page_display',
    'page_on_front',
    'reshares_enabled',
    'deadplug_atelier_branding'
  ];

  allowedKeys.forEach(key => {
    if (req.body[key] !== undefined) {
      updateOption(key, req.body[key]);
    }
  });

  hooks.doAction('settings_updated', req.body);
  res.json({ message: 'Engine settings successfully committed to node store.' });
});

// GET /api/v1/settings/telemetry
router.get('/telemetry', requireAuth, (req, res) => {
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
router.post('/export-engine-zip', requireAuth, requireRole('superadmin'), (req, res) => {
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
router.post('/export-snapshot-zip', requireAuth, requireRole('superadmin'), (req, res) => {
  try {
    const result = packageSiteSnapshot();
    res.json({
      success: true,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      downloadUrl: `/api/v1/settings/download-zip/${result.filename}`,
      message: 'Complete Site Snapshot Archive package compiled.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to package site snapshot zip: ' + err.message });
  }
});

// GET /api/v1/settings/download-zip/:filename
router.get('/download-zip/:filename', requireAuth, requireRole('superadmin'), (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const targetPath = path.join(config.dataDir, safeFilename);

  if (fs.existsSync(targetPath)) {
    res.download(targetPath, safeFilename);
  } else {
    res.status(404).json({ error: 'Distribution file not found.' });
  }
});

// GET /api/v1/settings/export-wxr (WordPress XML Export)
router.get('/export-wxr', requireAuth, requireRole('superadmin'), (req, res) => {
  const xml = exportWxr(`${req.protocol}://${req.get('host')}`);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="deadletters-export.xml"');
  res.send(xml);
});

// POST /api/v1/settings/import-wxr (WordPress XML Import)
router.post('/import-wxr', requireAuth, requireRole('superadmin'), upload.single('wxr_file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No WordPress XML export file uploaded.' });
  }

  try {
    const xmlContent = fs.readFileSync(req.file.path, 'utf-8');
    const result = importWxr(xmlContent, req.user.ID);
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `WordPress migration completed! Imported ${result.importedPosts} post(s) and ${result.importedPages} page(s).`,
      stats: result
    });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to parse WordPress XML: ' + err.message });
  }
});

module.exports = router;
