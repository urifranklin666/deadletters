'use strict';

/**
 * Isolated child node used by test/federation.test.js. It imports the real app
 * with a unique DEADLETTERS_DATA_DIR / uploads directory, listens on an
 * ephemeral loopback port, and writes a ready file the parent can poll.
 *
 * This intentionally calls app.listen() rather than startServer() so the
 * optional federation worker (a startServer-only feature) is not started.
 */

// Node's built-in test runner discovers every .js file under test/, including
// helpers. A real child always receives this variable; a discovery-only run
// must not start a server or keep the event loop alive.
if (!process.env.DEADLETTERS_TEST_READY_FILE) {
  process.exit(0);
}

const fs = require('node:fs');
const { app } = require('../../src/server');
const { closeDb } = require('../../src/core/db');

const readyFile = process.env.DEADLETTERS_TEST_READY_FILE;

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const info = { ready: true, port, baseUrl: `http://127.0.0.1:${port}`, pid: process.pid };
  process.stdout.write(`${JSON.stringify(info)}\n`);
  if (readyFile) {
    fs.writeFileSync(readyFile, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
  }
});

server.on('error', error => {
  process.stderr.write(`[federation-node] listen error: ${error.message}\n`);
  process.exit(1);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const forceExit = setTimeout(() => process.exit(0), 3000);
  if (typeof forceExit.unref === 'function') forceExit.unref();

  server.close(() => {
    try {
      closeDb();
    } catch (error) {
      process.stderr.write(`[federation-node] db close error: ${error.message}\n`);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', error => {
  process.stderr.write(`[federation-node] uncaught exception: ${error.stack || error.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', error => {
  process.stderr.write(`[federation-node] unhandled rejection: ${error && (error.stack || error.message)}\n`);
  process.exit(1);
});
