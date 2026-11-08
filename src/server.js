const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('path');
const config = require('./config');
const wpCompat = require('./core/wp-compat');
const { generateRssFeed, generateJsonFeed } = require('./core/reshare-engine');
const { getDb, getOption, closeDb } = require('./core/db');
const { getDiscoveryDocument } = require('./core/provenance');
const federation = require('./core/federation');
const { renderAppShell } = require('./core/public-shell');
const { loadAddonsIntoRuntime, router: addonsRouter } = require('./api/addons.routes');

const app = express();
app.disable('x-powered-by');

const REQUEST_LOGGING_ENABLED = process.env.DEADLETTERS_LOG_REQUESTS === '1';
const HSTS_MAX_AGE_SECONDS = 15552000;
// The no-build frontend uses external Google Fonts and permits operator-supplied
// HTTPS image URLs, so those origins must remain available. Inline style
// attributes are used throughout the UI, but no inline executable script or
// inline event handler is used: script-src intentionally omits unsafe-inline.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https://fonts.googleapis.com"
].join('; ');

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' ||
    normalized === '::1' || normalized.endsWith('.localhost');
}

function shouldSendHsts(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0].trim().toLowerCase();
  // HSTS is meaningful only for non-local deployments. Production is assumed to
  // be the deployed shape; outside production an actual HTTPS request or a
  // reverse-proxy HTTPS marker is required. Plain HTTP localhost never receives
  // HSTS. The forwarded marker is used for this response header only.
  if (isLocalHostname(req.hostname)) return false;
  return config.env === 'production' || req.secure || forwardedProto === 'https';
}

function directoryIsWritable(directory) {
  try {
    if (!fs.statSync(directory).isDirectory()) return false;
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readinessComponents() {
  const installed = config.isInstalled();
  let database = false;

  if (installed) {
    try {
      const row = getDb().prepare('SELECT 1 AS ok').get();
      database = Boolean(row && row.ok === 1);
    } catch {
      database = false;
    }
  }

  return {
    installed,
    database,
    dataDirectory: directoryIsWritable(config.dataDir),
    uploadsDirectory: directoryIsWritable(config.uploadsDir)
  };
}

// Opt-in request logging prints one JSON line per request. Logging never
// includes query strings, authorization headers, cookies, or request bodies.
app.use((req, res, next) => {
  if (!REQUEST_LOGGING_ENABLED) return next();
  const startedAt = process.hrtime.bigint();
  let logged = false;
  const writeLog = () => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const record = {
      event: 'request',
      method: req.method,
      path: req.path || '/',
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 1000) / 1000
    };
    try {
      console.log(JSON.stringify(record));
    } catch {
      // Logging must never affect request handling.
    }
  };
  res.once('finish', writeLog);
  res.once('close', writeLog);
  next();
});

// Bearer authentication is same-origin by default. Cross-origin API access must
// be explicitly allowlisted; origins are never reflected with credentials.
app.use(cors({
  credentials: false,
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  if (shouldSendHsts(req)) {
    res.set('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
  }
  next();
});

// Liveness and readiness are deliberately registered before static assets, the
// SPA shell, and the API 404 handler so they remain stable in every runtime.
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: config.meta.version
  });
});

app.get('/readyz', (req, res) => {
  const components = readinessComponents();
  const ready = components.installed && components.database &&
    components.dataDirectory && components.uploadsDirectory;
  res.set('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    uptime: process.uptime(),
    version: config.meta.version,
    components
  });
});

const PUBLIC_UPLOAD_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg'
]);
const PUBLIC_THEME_EXTENSIONS = new Set([
  '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.woff', '.woff2', '.ttf', '.otf'
]);

function publicAssetExtensionGuard(allowedExtensions) {
  return (req, res, next) => {
    const extension = path.extname(req.path).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      return res.status(404).type('text/plain').send('Asset not found.');
    }
    return next();
  };
}

// Static Assets: extension guards prevent legacy or restored files from being
// served as same-origin executable HTML/JS/SVG even if they predate upload
// validation. The main app's own JS comes from the separate public/app root.
app.use('/uploads', publicAssetExtensionGuard(PUBLIC_UPLOAD_EXTENSIONS), express.static(config.uploadsDir));
app.use('/themes', publicAssetExtensionGuard(PUBLIC_THEME_EXTENSIONS), express.static(config.themesDir));
app.use(express.static(path.join(__dirname, '..', 'public', 'app'), { index: false }));

// WordPress REST API v2 Emulation Layer
app.use('/wp-json', wpCompat);

// Deadletters Native v1 API Routes
app.use('/api/v1/installer', require('./api/installer.routes'));
app.use('/api/v1/auth', require('./api/auth.routes'));
app.use('/api/v1/posts', require('./api/posts.routes'));
app.use('/api/v1/reshares', require('./api/reshares.routes'));
app.use('/api/v1/federation', require('./api/federation.routes'));
app.use('/api/v1/media', require('./api/media.routes'));
app.use('/api/v1/taxonomies', require('./api/taxonomies.routes'));
app.use('/api/v1/comments', require('./api/comments.routes'));
app.use('/api/v1/themes', require('./api/themes.routes'));
app.use('/api/v1/addons', addonsRouter);
app.use('/api/v1/settings', require('./api/settings.routes'));

// Ed25519 node identity discovery. This document is public and contains the
// signing public key only; private key material is never serialized here.
app.get('/.well-known/deadletters.json', (req, res) => {
  if (!config.isInstalled()) return res.status(404).json({ error: 'Node not installed.' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(getDiscoveryDocument());
});

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
  const siteUrl = getOption('site_url', `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const posts = db.prepare("SELECT post_name, post_modified, post_type FROM dl_posts WHERE post_status = 'publish' AND post_type IN ('post', 'page', 'reshare') ORDER BY post_modified DESC LIMIT 500").all();
  const escapeXml = value => String(value).replace(/[<>&'"]/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[character]);
  const entry = (location, changefreq, priority, lastmod = null) => `  <url>
    <loc>${escapeXml(location)}</loc>
    ${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>\n    ` : ''}<changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>
`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entry(`${siteUrl}/`, 'daily', '1.0')}${entry(`${siteUrl}/reshares`, 'hourly', '0.8')}`;
  posts.forEach(post => {
    const type = post.post_type === 'page' ? 'page' : 'letter';
    const location = `${siteUrl}/${type}/${encodeURIComponent(post.post_name)}`;
    const modified = new Date(post.post_modified);
    const lastmod = Number.isNaN(modified.getTime()) ? null : modified.toISOString().split('T')[0];
    xml += entry(location, 'weekly', '0.7', lastmod);
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

app.use(['/api', '/wp-json'], (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Catch-all SPA Handler (Express 5 compatible). Public/direct routes receive a
// cached shell with an initial hash route and, when published, per-letter metadata.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  try {
    const html = renderAppShell(req);
    if (html !== null) return res.type('html').send(html);
  } catch (error) {
    return next(error);
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Resource not found.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.name === 'MulterError' ? 400 : (error.status || error.statusCode || 500);
  if (status >= 500) console.error('[Deadletters]', error);
  res.status(status).json({
    error: status >= 500 && config.env === 'production'
      ? 'Internal server error.'
      : (error.message || 'Request failed.')
  });
});

// Boot and listen
let serverInstance = null;
let shutdownPromise = null;
let shutdownSignalsBound = false;

function closeHttpServer(server, timeoutMs) {
  if (!server) return Promise.resolve({ forced: false });

  return new Promise(resolve => {
    let settled = false;
    const finish = forced => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ forced });
    };
    const timer = setTimeout(() => {
      // A stalled keep-alive or partial request must not prevent shutdown.
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {}
      finish(true);
    }, Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();

    try {
      server.close(() => finish(false));
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } catch {
      finish(false);
    }
  });
}

function shutdown(options = {}) {
  if (shutdownPromise) return shutdownPromise;

  const shutdownOptions = typeof options === 'number' ? { timeoutMs: options } : (options || {});
  const requestedTimeout = Number(shutdownOptions.timeoutMs ?? shutdownOptions.timeout);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : 10000;
  const server = shutdownOptions.server || serverInstance;

  shutdownPromise = (async () => {
    let workerStopped = false;
    try {
      workerStopped = federation.stopFederationWorker() === true;
    } catch {}

    const httpResult = await closeHttpServer(server, timeoutMs);

    let databaseClosed = false;
    try {
      closeDb();
      databaseClosed = true;
    } catch {}

    if (serverInstance === server) serverInstance = null;

    return {
      closed: true,
      timedOut: Boolean(httpResult && httpResult.forced),
      workerStopped,
      databaseClosed
    };
  })().catch(() => ({
    closed: false,
    timedOut: false,
    workerStopped: false,
    databaseClosed: false
  }));

  return shutdownPromise;
}

function bindShutdownSignals() {
  if (shutdownSignalsBound) return;
  shutdownSignalsBound = true;

  const handleSignal = signal => {
    shutdown({ reason: signal }).then(result => {
      process.exit(result && result.timedOut ? 1 : 0);
    }, () => process.exit(1));
  };

  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('SIGINT', () => handleSignal('SIGINT'));
}

function startServer(port = config.port) {
  shutdownPromise = null;

  if (config.isInstalled()) {
    try {
      loadAddonsIntoRuntime();
      console.log('✓ Deadletters addons loaded into runtime.');
    } catch (e) {
      console.warn('! Notice during addons preload:', e.message);
    }
  }

  // The outbox worker is intentionally started only by the real server boot,
  // never by importing the app in tests. It is unref'd so it cannot hold the
  // process open, and it is stopped when the HTTP server closes.
  federation.registerPostResharedHook();
  bindShutdownSignals();

  serverInstance = app.listen(port, config.host, () => {
    if (config.isInstalled()) federation.startFederationWorker();
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

  serverInstance.once('close', () => {
    federation.stopFederationWorker();
  });
  return serverInstance;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, shutdown };
