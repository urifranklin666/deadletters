const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DEADLETTERS_DATA_DIR || path.join(__dirname, 'content', 'data');
const UPLOADS_DIR = process.env.DEADLETTERS_UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
const THEMES_DIR = path.join(__dirname, 'themes');
const ADDONS_DIR = path.join(__dirname, 'addons');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THEMES_DIR)) fs.mkdirSync(THEMES_DIR, { recursive: true });
if (!fs.existsSync(ADDONS_DIR)) fs.mkdirSync(ADDONS_DIR, { recursive: true });

function loadConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      console.error('[Deadletters] Failed to parse config.json:', e.message);
    }
  }
  return null;
}

function saveConfigFile(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  return cfg;
}

const fileConfig = loadConfigFile() || {};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || fileConfig.port || '3000', 10),
  host: process.env.HOST || fileConfig.host || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || fileConfig.jwtSecret || 'deadplug-ultra-secret-mesh-key-998811',
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'deadletters.db'),
  dataDir: DATA_DIR,
  uploadsDir: UPLOADS_DIR,
  themesDir: THEMES_DIR,
  addonsDir: ADDONS_DIR,
  configFile: CONFIG_FILE,
  isInstalled: () => {
    return fs.existsSync(path.join(DATA_DIR, 'deadletters.db')) && fs.existsSync(CONFIG_FILE);
  },
  loadConfigFile,
  saveConfigFile,
  meta: {
    engine: 'deadletters',
    version: '1.0.0',
    creator: 'deadplug.digital',
    tagline: 'the plug is dead. stay wired.',
    repo: 'https://github.com/deadplug-digital/deadletters'
  }
};

module.exports = config;
