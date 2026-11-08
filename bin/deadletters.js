#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const config = require('../src/config');
const { initDb, updateOption, closeDb } = require('../src/core/db');
const { hashPassword } = require('../src/core/auth');
const { packageEngineZip, packageSiteSnapshot, restoreSiteSnapshot } = require('../src/core/exporter');
const { rotateNodeIdentity } = require('../src/core/provenance');
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
  const adminPass = await question('Master Password [minimum 12 chars]: ');

  rl.close();

  if (!adminPass || adminPass.length < 12) {
    console.error('Error: Password must be at least 12 characters.');
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
    provenanceSecret: config.provenanceSecret,
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

function parseSnapshotOutputPath(args) {
  if (args.length === 0) return null;
  if (args.length > 1) {
    throw new Error('Usage: deadletters snapshot-zip [output.zip]');
  }

  const outputPath = args[0];
  if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.startsWith('-')) {
    throw new Error('Usage: deadletters snapshot-zip [output.zip]');
  }
  return outputPath;
}

async function handleSnapshotExport(args) {
  const outputPath = parseSnapshotOutputPath(args);
  printBanner();
  console.log('Creating a consistent Deadletters site snapshot...');
  const snapshot = await packageSiteSnapshot(outputPath);
  console.log(`✓ Site Snapshot created: ${snapshot.filename} (${(snapshot.sizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`Location: ${snapshot.zipPath}`);
  console.log('Warning: data/config.json, when present, contains authentication secrets. Protect this archive.');
}

async function handleSnapshotRestore(args) {
  if (args.length !== 2) {
    throw new Error('Usage: deadletters snapshot-restore <archive> <target-directory>');
  }

  printBanner();
  const result = await restoreSiteSnapshot(args[0], args[1]);
  console.log(`✓ Snapshot restored to: ${result.targetDirectory}`);
  console.log('The target contains data/, uploads/, themes/, and addons/.');
  console.log('Start the restored site from the Deadletters engine directory with this exact command:');
  console.log(result.startCommand);
}

function parseRotationReason(args) {
  let reason = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--reason') {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
        throw new Error('Usage: deadletters rotate-node-key --reason "why this key is being retired"');
      }
      reason = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--reason=')) {
      reason = argument.slice('--reason='.length);
    } else {
      throw new Error(`Unknown rotate-node-key option: ${argument}`);
    }
  }

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('Usage: deadletters rotate-node-key --reason "why this key is being retired"');
  }
  return reason;
}

function handleRotateNodeKey(args) {
  printBanner();
  console.log('--- NODE IDENTITY ROTATION ---\n');
  console.log('WARNING: This command changes the node identity.');
  console.log('Peers must re-register this node with the new public key; old envelopes are not');
  console.log('automatically delivered under the new identity. Existing envelopes remain locally');
  console.log('verifiable through retained public-key history, but a compromised private key');
  console.log('cannot be made safe. Snapshots made before this rotation still contain the old');
  console.log('private key and remain sensitive. No private key material will be printed.\n');

  const reason = parseRotationReason(args);

  try {
    const result = rotateNodeIdentity({ reason });
    console.log('✓ Node identity rotated.');
    console.log(`  Handle:      ${result.current.handle}`);
    console.log(`  Previous key: ${result.retired.key_id}`);
    console.log(`  Current key:  ${result.current.key_id}`);
    console.log(`  Retired at:   ${result.retired.retired_at}`);
    console.log(`  Reason:       ${result.reason}`);
    console.log(`  Retired public keys retained locally: ${result.history.length}`);
    console.log('\nRe-register the new public key with each peer from /.well-known/deadletters.json.');
    console.log('Historical envelopes remain locally verifiable; they are not re-signed or re-delivered.');
  } finally {
    closeDb();
  }
}

function printHelp() {
  printBanner();
  console.log(`
Usage: deadletters <command> [options]

Commands:
  start               Start the Deadletters HTTP server
  install             Run the CLI setup wizard
  export-zip          Package the engine into a clean installable .zip
  snapshot-zip [output.zip]
                      Export a consistent site snapshot (data + uploads + themes + addons)
                      to the data directory or the given output path
  snapshot-restore <archive> <target-directory>
                      Restore into a new or empty directory without overwriting
  rotate-node-key --reason "..."
                      Retire the current Ed25519 node key and create a new one.
                      Changes node identity: peers must re-register the new public
                      key. Old envelopes stay only locally verifiable; snapshots
                      before rotation still contain the old private key and remain
                      sensitive. No private key is printed.
  help                Display this assistance manual

Environment Variables:
  PORT                Port to bind (default: 3000)
  HOST                Host address (default: 127.0.0.1)
  DEADLETTERS_DATA_DIR Override database directory
  DEADLETTERS_UPLOADS_DIR Override uploaded media directory
  DEADLETTERS_THEMES_DIR Override themes directory
  DEADLETTERS_ADDONS_DIR Override addons directory
  DB_PATH             Override SQLite database file
  `);
}

async function main() {
  switch (command) {
    case 'start':
      startServer();
      break;
    case 'install':
      await cliInstall();
      break;
    case 'export-zip':
      handleZipExport();
      break;
    case 'snapshot-zip':
      await handleSnapshotExport(args);
      break;
    case 'snapshot-restore':
      await handleSnapshotRestore(args);
      break;
    case 'rotate-node-key':
      handleRotateNodeKey(args);
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
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
