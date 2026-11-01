const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const wpCompat = require('./core/wp-compat');
const { generateRssFeed, generateJsonFeed } = require('./core/reshare-engine');
const { getDb, getOption } = require('./core/db');
const { loadAddonsIntoRuntime, router: addonsRouter } = require('./api/addons.routes');

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Simple cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) {
        req.cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
      }
    });
  }
  next();
});

// Static Assets
app.use('/uploads', express.static(config.uploadsDir));
app.use('/themes', express.static(config.themesDir));
app.use(express.static(path.join(__dirname, '..', 'public', 'app')));

// WordPress REST API v2 Emulation Layer
app.use('/wp-json', wpCompat);

// Deadletters Native v1 API Routes
app.use('/api/v1/installer', require('./api/installer.routes'));
app.use('/api/v1/auth', require('./api/auth.routes'));
app.use('/api/v1/posts', require('./api/posts.routes'));
app.use('/api/v1/reshares', require('./api/reshares.routes'));
app.use('/api/v1/media', require('./api/media.routes'));
app.use('/api/v1/taxonomies', require('./api/taxonomies.routes'));
app.use('/api/v1/comments', require('./api/comments.routes'));
app.use('/api/v1/themes', require('./api/themes.routes'));
app.use('/api/v1/addons', addonsRouter);
app.use('/api/v1/settings', require('./api/settings.routes'));

// XML RSS 2.0 Feed
app.get(['/feed', '/rss'], (req, res) => {
  if (!config.isInstalled()) return res.status(503).send('Node not initialized.');
  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(generateRssFeed());
});

// JSON Feed 1.1
app.get('/feed/json', (req, res) => {
  if (!config.isInstalled()) return res.status(503).json({ error: 'Node not initialized.' });
  res.set('Content-Type', 'application/feed+json; charset=utf-8');
  res.json(generateJsonFeed());
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  if (!config.isInstalled()) return res.status(503).send('Node not initialized.');
  const db = getDb();
  const siteUrl = getOption('site_url', `${req.protocol}://${req.get('host')}`);
  const posts = db.prepare("SELECT post_name, post_modified FROM dl_posts WHERE post_status = 'publish' ORDER BY post_modified DESC LIMIT 500").all();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/reshares</loc>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
`;
  posts.forEach(p => {
    xml += `  <url>
    <loc>${siteUrl}/letter/${p.post_name}</loc>
    <lastmod>${new Date(p.post_modified).toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
`;
  });
  xml += `</urlset>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  const siteUrl = getOption('site_url', `${req.protocol}://${req.get('host')}`);
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Sitemap: ${siteUrl}/sitemap.xml
`);
});

// Catch-all SPA Handler (Express 5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html'));
});

// Boot and listen
let serverInstance = null;

function startServer(port = config.port) {
  if (config.isInstalled()) {
    try {
      loadAddonsIntoRuntime();
      console.log('✓ Deadletters addons loaded into runtime.');
    } catch (e) {
      console.warn('! Notice during addons preload:', e.message);
    }
  }

  serverInstance = app.listen(port, config.host, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  DEADLETTERS ENGINE // DEADPLUG.DIGITAL                         ║
║  "the plug is dead. stay wired."                                 ║
╠══════════════════════════════════════════════════════════════════╣
║  • Node URL       : http://localhost:${port}                       ║
║  • Control Panel  : http://localhost:${port}/admin                  ║
║  • Installer      : http://localhost:${port}/installer              ║
║  • WP-JSON Bridge : http://localhost:${port}/wp-json/wp/v2/posts    ║
║  • RSS Feed       : http://localhost:${port}/feed                   ║
║  • Status         : ${config.isInstalled() ? 'OPERATIONAL (INSTALLED)' : 'AWAITING INITIAL INSTALLATION'} ║
╚══════════════════════════════════════════════════════════════════╝
    `);
  });
  return serverInstance;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
