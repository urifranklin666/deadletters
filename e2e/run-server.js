#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = path.resolve(process.env.E2E_RUNTIME_DIR || path.join(root, 'e2e-runtime'));
const port = Number.parseInt(process.env.E2E_PORT || '3210', 10);

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(port);
process.env.DEADLETTERS_DATA_DIR = path.join(runtime, 'data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(runtime, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(runtime, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(runtime, 'addons');
process.env.DB_PATH = path.join(runtime, 'data', 'deadletters.db');
process.env.JWT_SECRET = 'e2e-playwright-secret-not-for-production';
process.env.DEADLETTERS_PROVENANCE_SECRET = 'e2e-playwright-provenance-secret-not-for-production';
process.env.DEADLETTERS_SETUP_TOKEN = '';

const { startServer } = require('../src/server');

startServer(port);
console.log(`E2E runtime ready on http://127.0.0.1:${port}`);
