# DEADLETTERS // DEADPLUG.DIGITAL
> *"The plug is dead. Stay wired."*

An avant-garde, high-fashion editorial blogging and resharing mesh engine created by **deadplug.digital**. Engineered as a high-performance, design-first alternative to WordPress with **zero PHP**, zero database daemon dependencies, and built-in cryptographic provenance tracking.

---

## ⚡ CORE CAPABILITIES

- **Zero-PHP Modern Architecture**: Built on Node.js ESM and synchronous embedded SQLite (Write-Ahead-Logging). Cold-boots in < 40ms with zero Redis/MySQL requirements.
- **The Resharing Engine**: Native re-lettering system. Quote any local post or external URL with curator commentary, creating cryptographic provenance envelopes that link back to the original author and node.
- **WordPress REST API v2 Compatibility Bridge**: Full emulation at `/wp-json/wp/v2/posts`, `/pages`, `/categories`, `/tags`, `/users`, and `/comments`. Works out of the box with existing WordPress mobile apps, static site generators, and headless frontends.
- **Control Panel & Telemetry HUD**: Dark obsidian cyber-editorial control room featuring real-time node diagnostics, memory/uptime telemetry, post metrics, and mesh synchronization.
- **Dual-Mode Visual / Markdown Editor Studio**: Full markdown support with custom deadplug shortcodes:
  - `[pullquote author="..."]...[/pullquote]` (Oversized editorial quotes)
  - `[callout type="alert"]...[/callout]` (Brutalist callout notices)
  - `[glitch]...[/glitch]` (Animated holographic text spans)
  - `[dropcap]...[/dropcap]` (Stylized dropped capitals)
- **Theme Studio & Live Token Customizer**: Switch between three bespoke designer themes or tweak accent colors, border-radii, typography pairings, and custom CSS in real-time:
  1. `deadplug-editorial`: Flagship brutalist luxury zine (Syne + Instrument Serif + Acid Lime `#D6FF00`).
  2. `monolith-cyberpunk`: Obsidian monochrome terminal HUD with Electric Cyan matrix accents (`#00F0FF`).
  3. `suisse-minimal`: Pure Swiss modernist international grid with refined typography.
- **Addon & Hook Bus**: Complete drop-in architecture matching WordPress `add_action`, `add_filter`, `do_action`, and `apply_filters`. Includes built-in addons for P2P Mesh Federation, SEO Guardian, and Enterprise License Vault.
- **Installable via ZIP or Web Wizard**:
  - Web Installer at `/installer` runs environment doctor and initial node configuration.
  - One-click Engine Packager (`npm run export-zip`) compiles a standalone `.zip` distribution ready for resale or client handoff.

---

## 🚀 QUICK START

### 1. Start the Engine
```bash
npm start
```
Open **`http://localhost:3000`** in your browser. If this is a new installation, you will automatically be directed to the interactive 5-step installer wizard.

### 2. Command Line CLI
```bash
# Start server
node bin/deadletters.js start

# Interactive terminal setup
node bin/deadletters.js install

# Package clean distributable .zip for resale
node bin/deadletters.js export-zip

# Create full site snapshot (DB + Uploads + Themes)
node bin/deadletters.js snapshot-zip
```

---

## 📡 API REFERENCE

### Deadletters v1 Native REST Endpoints
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/posts` | Query published letter drops with taxonomy filters |
| `GET` | `/api/v1/posts/:slug` | Retrieve single letter with rendered shortcodes |
| `POST` | `/api/v1/posts` | Create new post (auth required) |
| `GET` | `/api/v1/reshares/stream` | Reshare feed with cryptographic provenance chains |
| `POST` | `/api/v1/reshares` | Create re-letter with curator commentary |
| `POST` | `/api/v1/reshares/import-external` | Scrape metadata from external URL for quoting |
| `GET` | `/api/v1/themes` | List installed themes |
| `POST` | `/api/v1/themes/activate` | Switch active theme |
| `POST` | `/api/v1/themes/tokens/:slug` | Commit live customizer design tokens |
| `GET` | `/api/v1/addons` | Addon registry and toggle states |
| `GET` | `/api/v1/addons/hooks` | Introspect active lifecycle filters and actions |
| `POST` | `/api/v1/settings/export-engine-zip` | Package standalone distributable `.zip` |

### WordPress Compatible Endpoints (`/wp-json`)
- `GET /wp-json` — WP Discovery index
- `GET /wp-json/wp/v2/posts` — Posts list
- `GET /wp-json/wp/v2/posts/:id` — Single post
- `GET /wp-json/wp/v2/pages` — Pages
- `GET /wp-json/wp/v2/categories` — Categories
- `GET /wp-json/wp/v2/tags` — Tags
- `GET /wp-json/wp/v2/comments` — Comments thread

### Syndication Feeds
- `GET /feed` or `GET /rss` — Standard XML RSS 2.0 with Deadletters drop codes
- `GET /feed/json` — JSON Feed 1.1 specification
- `GET /sitemap.xml` — Dynamic SEO sitemap
- `GET /robots.txt` — Standard crawler directives

---

## 🎨 ATELIER DESIGN PHILOSOPHY
WordPress is bloated legacy code with twenty years of PHP baggage. Deadletters is a fashion house operating as an open protocol: high-contrast obsidian tones, laser-sharp typography, tactile hover physics, and zero bloat.

Designed and engineered by **deadplug.digital**.
