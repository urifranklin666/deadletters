#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const config = require('../src/config');
const { initDb, updateOption, getDb } = require('../src/core/db');
const { hashPassword } = require('../src/core/auth');
const { packageEngineZip, packageSiteSnapshot } = require('../src/core/exporter');
const { startServer } = require('../src/server');

const [,, command, ...args] = process.argv;

function printBanner() {
  console.log(`
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ DEADLETTERS ENGINE // DEADPLUG.DIGITAL     █
  █ "the plug is dead. stay wired."            █
  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Version: ${config.meta.version}
  `);
}

async function cliInstall() {
  printBanner();
  console.log('--- CLI INTERACTIVE INSTALLER ---\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise(resolve => rl.question(query, resolve));

  const siteTitle = await question('Site Title [DEADLETTERS // DEADPLUG]: ') || 'DEADLETTERS // DEADPLUG';
  const siteTagline = await question('Tagline [the plug is dead. stay wired.]: ') || 'the plug is dead. stay wired.';
  const nodeHandle = await question('Node Handle [@deadplug/main-node]: ') || '@deadplug/main-node';
  const adminLogin = await question('Master Operator Username [clown]: ') || 'clown';
  const adminEmail = await question('Master Operator Email [clown@deadplug.digital]: ') || 'clown@deadplug.digital';
  const adminPass = await question('Master Password [minimum 6 chars]: ');

  rl.close();

  if (!adminPass || adminPass.length < 6) {
    console.error('Error: Password must be at least 6 characters.');
    process.exit(1);
  }

  console.log('\n[1/4] Initializing database schema...');
  const db = initDb();

  console.log('[2/4] Registering master operator...');
  db.prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_nicename, user_email, user_url, display_name, role, avatar_url, bio)
    VALUES (?, ?, ?, ?, ?, ?, 'superadmin', ?, ?)
  `).run(
    adminLogin,
    hashPassword(adminPass),
    adminLogin,
    adminEmail,
    'https://deadplug.digital',
    'Operator ' + adminLogin,
    '/uploads/deadplug_operator_avatar.jpg',
    'Lead Operator at deadplug.digital'
  );

  console.log('[3/4] Writing configuration options...');
  updateOption('site_title', siteTitle);
  updateOption('site_tagline', siteTagline);
  updateOption('site_node_handle', nodeHandle);
  updateOption('site_url', 'http://localhost:3000');
  updateOption('admin_email', adminEmail);
  updateOption('active_theme', 'deadplug-editorial');
  updateOption('engine_installed_at', new Date().toISOString());

  config.saveConfigFile({
    port: config.port,
    host: config.host,
    jwtSecret: config.jwtSecret,
    installed: true,
    installedAt: new Date().toISOString()
  });

  console.log('[4/4] Installation complete!');
  console.log(`\nBoot the engine with: npm start`);
}

function handleZipExport() {
  printBanner();
  console.log('Compiling Deadletters Standalone Engine Distribution ZIP...');
  const res = packageEngineZip();
  console.log(`✓ Package created successfully: ${res.filename} (${(res.sizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`Location: ${res.zipPath}`);
}

function printHelp() {
  printBanner();
  console.log(`
Usage: deadletters <command> [options]

Commands:
  start               Start the Deadletters HTTP server
  install             Run the CLI setup wizard
  export-zip          Package the engine into a clean installable .zip
  snapshot-zip        Export complete site snapshot (data + uploads + themes)
  help                Display this assistance manual

Environment Variables:
  PORT                Port to bind (default: 3000)
  HOST                Host address (default: 0.0.0.0)
  DEADLETTERS_DATA_DIR Override database directory
  `);
}

switch (command) {
  case 'start':
    startServer();
    break;
  case 'install':
    cliInstall();
    break;
  case 'export-zip':
    handleZipExport();
    break;
  case 'snapshot-zip':
    printBanner();
    const snap = packageSiteSnapshot();
    console.log(`✓ Site Snapshot created: ${snap.filename} (${(snap.sizeBytes / 1024).toFixed(1)} KB)`);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    if (!command) {
      startServer();
    } else {
      console.log(`Unknown command: ${command}`);
      printHelp();
    }
    break;
}
