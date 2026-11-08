const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.DEADLETTERS_DATA_DIR || path.join(__dirname, 'content', 'data'));
const UPLOADS_DIR = path.resolve(process.env.DEADLETTERS_UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads'));
const THEMES_DIR = path.resolve(process.env.DEADLETTERS_THEMES_DIR || path.join(__dirname, 'themes'));
const ADDONS_DIR = path.resolve(process.env.DEADLETTERS_ADDONS_DIR || path.join(__dirname, 'addons'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const directory of [DATA_DIR, UPLOADS_DIR, THEMES_DIR, ADDONS_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function loadConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    throw new Error(`Failed to parse ${CONFIG_FILE}: ${error.message}`);
  }
}

function saveConfigFile(values) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  const serialized = JSON.stringify(values, null, 2) + '\n';

  try {
    fs.writeFileSync(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, CONFIG_FILE);
    fs.chmodSync(CONFIG_FILE, 0o600);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }

  return values;
}

const fileConfig = loadConfigFile() || {};
const generatedSecret = crypto.randomBytes(48).toString('base64url');
const jwtSecret = process.env.JWT_SECRET || fileConfig.jwtSecret || generatedSecret;
const provenanceSecret = process.env.DEADLETTERS_PROVENANCE_SECRET || fileConfig.provenanceSecret ||
  crypto.createHmac('sha256', jwtSecret).update('deadletters-local-provenance-v1').digest('hex');
const corsOrigins = String(process.env.DEADLETTERS_CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || fileConfig.port || '3000', 10),
  host: process.env.HOST || fileConfig.host || '127.0.0.1',
  jwtSecret,
  provenanceSecret,
  tokenTtl: process.env.DEADLETTERS_TOKEN_TTL || '12h',
  setupToken: process.env.DEADLETTERS_SETUP_TOKEN || '',
  corsOrigins,
  dbPath: path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'deadletters.db')),
  dataDir: DATA_DIR,
  uploadsDir: UPLOADS_DIR,
  themesDir: THEMES_DIR,
  addonsDir: ADDONS_DIR,
  configFile: CONFIG_FILE,
  isInstalled: () => loadConfigFile()?.installed === true && fs.existsSync(config.dbPath),
  loadConfigFile,
  saveConfigFile,
  meta: {
    engine: 'deadletters',
    version: require('../package.json').version,
    creator: 'deadplug.digital',
    tagline: 'the plug is dead. stay wired.',
    repo: 'https://github.com/urifranklin666/deadletters'
  }
};

module.exports = config;
