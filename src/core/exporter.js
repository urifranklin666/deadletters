const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/**
 * Deadletters Distributable Engine & Site Packager
 * Exports enterprise-ready zip archives for deployment or resale.
 */

function packageEngineZip(outputPath = null) {
  const rootDir = path.resolve(__dirname, '..', '..');
  const targetZipPath = outputPath || path.join(config.dataDir, `deadletters-engine-v${config.meta.version}.zip`);
  const zip = new AdmZip();

  const entriesToInclude = [
    'bin',
    'src',
    'public',
    'package.json',
    'README.md'
  ];

  entriesToInclude.forEach(entry => {
    const fullPath = path.join(rootDir, entry);
    if (!fs.existsSync(fullPath)) return;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      zip.addLocalFolder(fullPath, entry, (filePath) => {
        // Exclude database files, large uploads or temp files from clean engine distribution
        if (filePath.includes('deadletters.db') || filePath.includes('.system_generated')) {
          return false;
        }
        return true;
      });
    } else {
      zip.addLocalFile(fullPath);
    }
  });

  // Include an automated installer runner script inside the zip
  const bootstrapInstaller = `#!/usr/bin/env node
/**
 * DEADLETTERS ENGINE // DEADPLUG.DIGITAL
 * Automated Installer Bootstrapper
 */
console.log("==========================================");
console.log("  DEADLETTERS ENGINE // DEADPLUG.DIGITAL  ");
console.log("  'the plug is dead. stay wired.'        ");
console.log("==========================================\\n");

const { execSync } = require('child_process');
console.log("[1/3] Checking dependencies...");
try {
  execSync('npm install --production', { stdio: 'inherit' });
} catch (e) {
  console.log("Note: Running with bundled packages or please run npm install.");
}

console.log("[2/3] Initializing Deadletters engine...");
const server = require('./src/server.js');
console.log("[3/3] Ready! Access your node at http://localhost:3000/installer");
`;
  zip.addFile('install.js', Buffer.from(bootstrapInstaller, 'utf-8'));

  zip.writeZip(targetZipPath);
  return {
    success: true,
    zipPath: targetZipPath,
    filename: path.basename(targetZipPath),
    sizeBytes: fs.statSync(targetZipPath).size
  };
}

/**
 * Package complete site snapshot (Content + DB + Uploads)
 */
function packageSiteSnapshot(outputPath = null) {
  const rootDir = path.resolve(__dirname, '..', '..');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetZipPath = outputPath || path.join(config.dataDir, `deadletters-site-snapshot-${timestamp}.zip`);
  const zip = new AdmZip();

  if (fs.existsSync(config.dataDir)) {
    zip.addLocalFolder(config.dataDir, 'data');
  }
  if (fs.existsSync(config.uploadsDir)) {
    zip.addLocalFolder(config.uploadsDir, 'uploads');
  }
  if (fs.existsSync(config.themesDir)) {
    zip.addLocalFolder(config.themesDir, 'themes');
  }
  if (fs.existsSync(config.addonsDir)) {
    zip.addLocalFolder(config.addonsDir, 'addons');
  }

  zip.writeZip(targetZipPath);
  return {
    success: true,
    zipPath: targetZipPath,
    filename: path.basename(targetZipPath),
    sizeBytes: fs.statSync(targetZipPath).size
  };
}

module.exports = {
  packageEngineZip,
  packageSiteSnapshot
};
