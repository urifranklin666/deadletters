'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

// Each child gets an isolated runtime so these tests never open, create, or
// modify the repository's real data/database/uploads directories.
const childSource = `
'use strict';
const config = require('./src/config');
const db = require('./src/core/db');
const { app, startServer, shutdown } = require('./src/server');
const mode = process.env.DL_OPERATIONS_MODE;

async function main() {
  if (mode === 'installed') {
    db.getDb();
    config.saveConfigFile({ installed: true, installedAt: new Date().toISOString() });
  }

  const server = mode === 'app-only' ? app.listen(0, '127.0.0.1') : startServer(0);

  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });

  process.send({
    type: 'ready',
    port: server.address().port,
    installed: config.isInstalled(),
    signalHandlers: {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT')
    }
  });

  process.on('message', async message => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'close') {
      server.close(() => {
        db.closeDb();
        process.exit(0);
      });
      return;
    }

    if (message.type !== 'shutdown') return;

    try {
      const timeoutMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : 5000;
      const first = await shutdown({ timeoutMs });
      let secondError = null;
      try {
        await shutdown();
      } catch (error) {
        secondError = error && error.message ? error.message : String(error);
      }
      process.send({
        type: 'shutdown-result',
        first,
        secondError,
        listening: Boolean(server.listening)
      }, () => process.exit(0));
    } catch (error) {
      process.send({
        type: 'shutdown-error',
        message: error && error.message ? error.message : String(error)
      }, () => process.exit(1));
    }
  });
}

main().catch(error => {
  const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  if (process.send) process.send({ type: 'error', message }, () => process.exit(1));
  else {
    console.error(message);
    process.exit(1);
  }
});
`;

function startOperationsNode(mode, extraEnv = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-operations-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DEADLETTERS_DATA_DIR: path.join(runtimeDir, 'data'),
    DEADLETTERS_UPLOADS_DIR: path.join(runtimeDir, 'uploads'),
    DEADLETTERS_THEMES_DIR: path.join(runtimeDir, 'themes'),
    DEADLETTERS_ADDONS_DIR: path.join(runtimeDir, 'addons'),
    DB_PATH: path.join(runtimeDir, 'data', 'deadletters.db'),
    JWT_SECRET: 'operations-test-secret-that-is-not-used-in-production',
    DEADLETTERS_LOG_REQUESTS: '0',
    ...extraEnv,
    DL_OPERATIONS_MODE: mode
  };

  const child = spawn(process.execPath, ['-e', childSource], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for operations child. stderr: ${stderr}`));
    }, 10000);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }

    function onMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'error') {
        cleanup();
        reject(new Error(message.message));
        return;
      }
      if (message.type !== 'ready') return;
      cleanup();
      resolve({
        ...message,
        baseUrl: `http://127.0.0.1:${message.port}`
      });
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Operations child exited early (code ${code}, signal ${signal}). stderr: ${stderr}`));
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
  });

  return {
    child,
    runtimeDir,
    ready,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function waitForMessage(child, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message: ${type}`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }

    function onMessage(message) {
      if (!message || message.type !== type) return;
      cleanup();
      resolve(message);
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Child exited before ${type} (code ${code}, signal ${signal}).`));
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function sendMessage(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, error => error ? reject(error) : resolve());
  });
}

async function closeOperationsNode(node) {
  if (node.child.exitCode === null && node.child.signalCode === null) {
    node.child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { node.child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
      node.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  fs.rmSync(node.runtimeDir, { recursive: true, force: true });
}

async function getJson(baseUrl, endpoint, options = {}) {
  const response = await fetch(baseUrl + endpoint, options);
  const body = await response.json();
  return { response, body };
}

function rawRequest(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('health is live before installation and readiness fails safely', async () => {
  const node = startOperationsNode('app-only');

  try {
    const ready = await node.ready;
    assert.equal(ready.installed, false);
    assert.equal(ready.signalHandlers.sigterm, 0, 'importing the app must not install signal handlers');
    assert.equal(ready.signalHandlers.sigint, 0, 'importing the app must not install signal handlers');

    const health = await getJson(ready.baseUrl, '/healthz');
    assert.equal(health.response.status, 200);
    assert.match(health.response.headers.get('content-type') || '', /application\/json/);
    assert.equal(health.response.headers.get('cache-control'), 'no-store');
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.version, '1.0.0');
    assert.equal(typeof health.body.uptime, 'number');
    assert.ok(health.body.uptime >= 0);

    assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.response.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(health.response.headers.get('permissions-policy') || '', /camera=\(\)/);
    assert.equal(health.response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(health.response.headers.get('strict-transport-security'), null);

    const csp = health.response.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /style-src[^;]*'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src[^;]*https:/);
    assert.match(csp, /frame-ancestors 'none'/);

    const readiness = await getJson(ready.baseUrl, '/readyz');
    assert.equal(readiness.response.status, 503);
    assert.equal(readiness.response.headers.get('cache-control'), 'no-store');
    assert.equal(readiness.body.status, 'not_ready');
    assert.equal(readiness.body.components.installed, false);
    assert.equal(readiness.body.components.database, false);
    assert.equal(typeof readiness.body.components.dataDirectory, 'boolean');
    assert.equal(typeof readiness.body.components.uploadsDirectory, 'boolean');

    const serializedReadiness = JSON.stringify(readiness.body);
    assert.doesNotMatch(serializedReadiness, /stack|config\.json|deadletters\.db/i);
    assert.ok(!serializedReadiness.includes(node.runtimeDir), 'readiness must not expose runtime paths');

    const serializedHealth = JSON.stringify(health.body);
    assert.doesNotMatch(serializedHealth, /secret|stack|config\.json|deadletters\.db/i);
    assert.ok(!serializedHealth.includes(node.runtimeDir), 'liveness must not expose runtime paths');
  } finally {
    await closeOperationsNode(node);
  }
});

test('installed node is ready and programmatic shutdown is idempotent', async () => {
  const node = startOperationsNode('installed');

  try {
    const ready = await node.ready;
    assert.equal(ready.installed, true);
    assert.ok(ready.signalHandlers.sigterm >= 1, 'startServer must register SIGTERM handling');
    assert.ok(ready.signalHandlers.sigint >= 1, 'startServer must register SIGINT handling');

    const readiness = await getJson(ready.baseUrl, '/readyz');
    assert.equal(readiness.response.status, 200, JSON.stringify(readiness.body));
    assert.equal(readiness.response.headers.get('cache-control'), 'no-store');
    assert.equal(readiness.body.status, 'ready');
    assert.deepEqual(readiness.body.components, {
      installed: true,
      database: true,
      dataDirectory: true,
      uploadsDirectory: true
    });
    assert.equal(readiness.response.headers.get('strict-transport-security'), null);

    const shutdownResult = waitForMessage(node.child, 'shutdown-result');
    await sendMessage(node.child, { type: 'shutdown', timeoutMs: 2000 });
    const result = await shutdownResult;

    assert.equal(result.first.closed, true);
    assert.equal(result.first.timedOut, false);
    assert.equal(result.first.databaseClosed, true);
    assert.equal(result.secondError, null, 'a second shutdown call must not throw');
    assert.equal(result.listening, false, 'the HTTP server must stop listening');

    await new Promise(resolve => {
      if (node.child.exitCode !== null || node.child.signalCode !== null) return resolve();
      node.child.once('exit', resolve);
    });
  } finally {
    await closeOperationsNode(node);
  }
});

test('HSTS is emitted for non-local production requests but not plain localhost', async () => {
  const node = startOperationsNode('app-only', { NODE_ENV: 'production' });

  try {
    const ready = await node.ready;

    const local = await rawRequest(ready.port, '/healthz', { Host: 'localhost' });
    assert.equal(local.statusCode, 200);
    assert.equal(local.headers['strict-transport-security'], undefined);

    const production = await rawRequest(ready.port, '/healthz', { Host: 'letters.example' });
    assert.equal(production.statusCode, 200);
    assert.match(production.headers['strict-transport-security'] || '', /^max-age=\d+$/);

    const proxied = await rawRequest(ready.port, '/healthz', {
      Host: 'letters.example',
      'X-Forwarded-Proto': 'https'
    });
    assert.equal(proxied.statusCode, 200);
    assert.match(proxied.headers['strict-transport-security'] || '', /^max-age=\d+$/);
  } finally {
    await closeOperationsNode(node);
  }
});

test('opt-in request logging is structured and excludes query strings and auth headers', async () => {
  const node = startOperationsNode('app-only', { DEADLETTERS_LOG_REQUESTS: '1' });

  try {
    const ready = await node.ready;

    const response = await fetch(
      `${ready.baseUrl}/healthz?token=query-secret-token&access_token=another-secret`,
      { headers: { Authorization: 'Bearer header-secret-token' } }
    );
    assert.equal(response.status, 200);
    await response.text();

    const deadline = Date.now() + 2000;
    let record = null;
    while (Date.now() < deadline && !record) {
      for (const line of node.stdout().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && parsed.event === 'request' && parsed.path === '/healthz') {
            record = parsed;
            break;
          }
        } catch {}
      }
      if (!record) await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.ok(record, `expected a JSON request log line. stdout: ${node.stdout()}`);
    assert.equal(record.method, 'GET');
    assert.equal(record.path, '/healthz');
    assert.equal(record.status, 200);
    assert.equal(typeof record.duration_ms, 'number');
    assert.ok(record.duration_ms >= 0);

    const output = node.stdout();
    assert.ok(!output.includes('query-secret-token'));
    assert.ok(!output.includes('another-secret'));
    assert.ok(!output.includes('header-secret-token'));
    assert.ok(!output.includes('access_token'));
  } finally {
    await closeOperationsNode(node);
  }
});
