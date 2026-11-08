# DEADLETTERS // DEADPLUG.DIGITAL

> *The plug is dead. Stay wired.*

Deadletters is a design-led editorial publishing and resharing application by **deadplug.digital**. It combines an Express server, embedded SQLite storage, a browser-based control panel, Markdown with editorial shortcodes, theme tokens, and native reshares in one CommonJS Node.js project.

This is an early, inspectable baseline—not a finished WordPress replacement or a general-purpose federated network. It includes a deliberately limited, delivery-only federation MVP. The implemented features and current limitations are listed below so a local evaluation reflects what the code actually does.

**Public repository:** [github.com/urifranklin666/deadletters](https://github.com/urifranklin666/deadletters)

## Requirements

- Node.js **22.12.0 or newer**; Node.js 24 is used in CI.
- npm and a platform supported by the pinned `better-sqlite3` dependency.
- No PHP, MySQL, Redis, or separate database daemon.

The Node.js server, CLI, addons, and repository scripts use **CommonJS** (`require` and `module.exports`), not ESM. The browser interface is plain JavaScript and CSS; there is no frontend build step.

## Setup

1. Clone the public repository and install the locked dependencies:

   ```bash
   git clone https://github.com/urifranklin666/deadletters.git
   cd deadletters
   npm ci
   ```

2. Optionally provide explicit secrets and start the server:

   ```bash
   JWT_SECRET='replace-with-a-long-random-secret' \
   DEADLETTERS_PROVENANCE_SECRET='replace-with-another-long-random-secret' \
   npm start
   ```

   When neither `JWT_SECRET` nor a saved `config.json` value exists, the engine generates a random secret at startup; the installer persists that generated value in `config.json`. This is not a fixed development fallback. Generated values are suitable for a single installation that keeps its data directory private, but explicit, backed-up secrets are safer for deployment and necessary if multiple processes must accept the same tokens. The legacy provenance HMAC secret is derived from the JWT secret if it is not provided explicitly; new re-letters use the Ed25519 node identity instead.

3. Open **http://localhost:3000/installer** on a new installation. Tokenless web installation is restricted to requests from localhost in non-production mode. Set `DEADLETTERS_SETUP_TOKEN` and supply it through the `x-deadletters-setup-token` header or the `setupToken` form field for a remote installation; production installation requires a valid setup token. The web installer has four steps:

   1. **Diagnostics** — check the Node.js version and data-directory writability.
   2. **Identity** — set the site title, tagline, node handle, and public site URL.
   3. **Operator** — create the initial administrator account.
   4. **Atelier** — select a theme, choose whether to seed demo content, and initialize the database.

4. Visit **http://localhost:3000/** for the publication and **http://localhost:3000/admin** for the control panel. Restart with the same environment when changing deployment settings.

An interactive CLI installer is also available with `npm run install-wizard`. `npm run dev` currently starts the same server as `npm start`; it does not add file watching or automatic restarts.

### Health, readiness, and graceful shutdown

Two unauthenticated operational endpoints are available before the SPA, static assets, and API 404 handler:

- `GET /healthz` is a liveness probe. It returns `200` with `{ "status": "ok", "uptime": <seconds>, "version": "1.0.0" }`, works before installation, and never exposes secrets or runtime paths. Responses use `Cache-Control: no-store`.
- `GET /readyz` is a readiness probe. It returns `200` only when the node is installed, SQLite answers `SELECT 1`, and the data and uploads directories are writable. Otherwise it returns `503` with `status: "not_ready"` and boolean `components` for `installed`, `database`, `dataDirectory`, and `uploadsDirectory`. It never includes stack traces, filesystem paths, or secrets, and also uses `Cache-Control: no-store`. An uninstalled node intentionally reports `503`, so do not use `/readyz` as a liveness probe.

`startServer()` registers `SIGTERM` and `SIGINT` handlers and exports an idempotent `shutdown({ timeoutMs })` function. Shutdown stops the federation worker, stops accepting new HTTP connections, closes idle connections, then closes SQLite through `closeDb()`. If a connection refuses to finish, the timeout (default 10 seconds) force-closes remaining connections before the process exits. Calling `shutdown()` again returns the same settled operation and does not throw. Merely requiring `src/server` does not register signal handlers, so tests and embedded callers can use the app without changing process signal behavior. The `npm start` and `node bin/deadletters.js start` paths use the same server boot and shutdown sequence.

Programmatic callers can manage their own process exit:

```js
const { startServer, shutdown } = require('./src/server');

startServer();
// ...
await shutdown({ timeoutMs: 5000 });
```

### Security headers and request logging

Responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and a Content Security Policy. The CSP allows same-origin scripts only (no inline executable scripts, `eval`, or inline event handlers), same-origin API connections, inline styles because the current no-build UI uses style attributes, external Google Fonts styles/fonts, and HTTPS images for operator-supplied media URLs. The server-injected `application/json` initial-route block is data, not executable script. HSTS is emitted for non-local production deployments and for requests delivered over trusted HTTPS (including an `X-Forwarded-Proto: https` reverse-proxy marker); plain HTTP localhost never receives HSTS.

Set `DEADLETTERS_LOG_REQUESTS=1` to emit one JSON line per request with `event`, `method`, `path`, `status`, and `duration_ms`. Logging excludes query strings, authorization headers, cookies, and request bodies, so tokens are not written to logs.

## Configuration

Configuration is read from environment variables and, where noted, the installer-written `config.json`. The project does not load `.env` files automatically; provide variables through your shell, service manager, or hosting environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Node environment label. |
| `PORT` | Saved config value, otherwise `3000` | HTTP port. |
| `HOST` | Saved config value, otherwise `127.0.0.1` | HTTP bind address. The default binds to loopback only. |
| `JWT_SECRET` | Saved config value, otherwise a random secret generated at startup | Secret used to sign authentication tokens. The installer persists the generated value in `config.json`. Set this explicitly for multi-process or deployed installations. |
| `DEADLETTERS_PROVENANCE_SECRET` | Saved config value, otherwise derived from `JWT_SECRET` | Legacy installation-local secret used only to verify pre-envelope HMAC provenance rows. New re-letters use Ed25519. It is not the node signing key. |
| `DEADLETTERS_TOKEN_TTL` | `12h` | JWT lifetime accepted by `jsonwebtoken` (for example `12h`, `7d`, or a seconds value). |
| `DEADLETTERS_SETUP_TOKEN` | Empty | Shared secret required for remote and production web installation. Compared in constant time. |
| `DEADLETTERS_CORS_ORIGINS` | Empty (same-origin only) | Comma-separated list of allowed cross-origin API origins. Credentials are not enabled for CORS. |
| `DEADLETTERS_LOG_REQUESTS` | Unset | Set to `1` to emit one structured JSON request-log line per request. Query strings and authentication headers are never logged. |
| `DB_PATH` | `<DEADLETTERS_DATA_DIR>/deadletters.db` | SQLite database file. |
| `DEADLETTERS_DATA_DIR` | `src/content/data` | Runtime database, generated configuration, temporary uploads, and ZIP output directory. |
| `DEADLETTERS_UPLOADS_DIR` | `public/uploads` | Uploaded media directory, served at `/uploads`. |
| `DEADLETTERS_THEMES_DIR` | `src/themes` | Installed themes directory. |
| `DEADLETTERS_ADDONS_DIR` | `src/addons` | Installed addons directory. |

The installer stores installation metadata, host, port, JWT secret, and legacy provenance secret in `<DEADLETTERS_DATA_DIR>/config.json`. Editorial settings and content are stored in SQLite. The SQLite database also contains the node's Ed25519 private key, and local database files are set to owner-only permissions where the platform supports them. Keep runtime data private and set `HOST`, `PORT`, and the saved public site URL deliberately when deploying behind a proxy or on a public interface. `config.json` and complete site snapshots therefore contain credentials and must be protected even though the engine ZIP does not include them. Authentication tokens use the configured bearer-only flow with `issuer` and `audience` validation; changing a user's password increments a token version and invalidates older tokens. There is no production deployment automation in this baseline.

### Settings visibility and supported values

`GET /api/v1/settings` is public because the reader needs branding and layout information. Anonymous callers receive only `site_title`, `site_tagline`, `site_node_handle`, `site_url`, `active_theme`, `posts_per_page`, `front_page_display`, `page_on_front`, `reshares_enabled`, `deadplug_atelier_branding`, and engine `meta`. `admin_email`, `default_comment_approved`, and `permalink_structure` are returned only to authenticated users with the `settings:manage` capability. Other authenticated roles receive the public projection.

`PUT /api/v1/settings` requires `settings:manage`, validates every accepted value before writing, ignores unknown keys, and returns the applied key names. Titles, taglines, and handles are length-bounded; `site_url` must be an HTTP(S) URL without embedded credentials; `admin_email` must be a valid address; `posts_per_page` is an integer from 1 through 100; `page_on_front` is a nonnegative integer; and `front_page_display`, `reshares_enabled`, `default_comment_approved`, and `deadplug_atelier_branding` use bounded enums. The only implemented permalink structure is `/letter/%postname%`; other structures are rejected, and the control panel presents the implemented route as read-only.

When a setting has never been stored, the existing defaults remain unchanged: site title `Deadletters // Deadplug Atelier`, tagline `the plug is dead. stay wired.`, node handle `@deadplug/main-node`, site URL `http://localhost:3000`, theme `deadplug-editorial`, 12 posts per page, `posts` front page, page ID `0`, reshares enabled, and branding enabled. The absent-value fallback for `default_comment_approved` is now the secure moderation queue value `0`. Deploying this behavior does not rewrite option values already stored in an existing SQLite database.

## Engine exports and site snapshots

### Clean engine archive

```bash
npm run export-zip
# or: node bin/deadletters.js export-zip
```

The engine ZIP is built from an explicit source-file allowlist. It includes `package.json`, `package-lock.json`, the startup/API/core code, browser assets, bundled themes/addons, and three explicitly named demo images. It does **not** include `src/content`, saved `config.json` files, databases or WAL/SHM files, other user uploads, runtime themes/addons outside the bundled source list, tests, temporary files, generated archives, `node_modules`, `.git`, or environment files. The allowlist must be updated deliberately when new runtime source files are added.

To install an extracted engine archive, run `node install.js` from its root. The bootstrap runs `npm ci --omit=dev`, exits with an error if dependency installation fails, and then calls `startServer()`. Dependency installation still requires npm, network access or a populated npm cache, and a platform supported by the locked native SQLite dependency. The ZIP does not bundle dependencies.

### Snapshot creation

```bash
npm run snapshot-zip
# or: node bin/deadletters.js snapshot-zip
```

Snapshot creation awaits the `better-sqlite3` online backup API instead of copying a live database and its WAL/SHM files. The resulting ZIP uses this layout:

```text
data/deadletters.db
data/config.json       # included when present
uploads/
themes/
addons/
```

Old ZIPs, temporary files/directories, SQLite sidecars, VCS/dependency directories, symlinks, and special files are not packaged from asset directories. The SQLite backup is transactionally consistent; asset files are read individually, so a snapshot is not an atomic filesystem-wide freeze while uploads or themes are being edited.

**Snapshots are sensitive, unencrypted files.** In particular, `data/config.json` can contain the JWT and legacy provenance secrets as well as deployment settings, and `data/deadletters.db` contains the node's Ed25519 **private key**. Anyone with a snapshot can sign re-letters as this node and read all of its content. Snapshot output is set to owner-only permissions (`0600`) on POSIX systems; preserve restrictive permissions when copying it. Protect snapshot archives like a database credential backup and rotate secrets if an archive is disclosed. There is no scheduling, encryption, off-site upload, retention management, or hosted backup service here.

### Non-destructive snapshot restore

From an installed Deadletters engine source directory, preferably running the same version that created the snapshot:

```bash
node bin/deadletters.js snapshot-restore /path/to/site-snapshot.zip /path/to/new-restored-site
```

The target must not exist or must be an existing empty directory. Restore refuses a non-empty target, validates entry names and containment with the archive-security helpers, rejects unexpected top-level paths and malformed file/directory collisions, and requires a SQLite database that passes `quick_check` and contains the core Deadletters tables. It never restores over the running installation.

A successful restore creates `data`, `uploads`, `themes`, and `addons` below the target and prints the complete command to start it. The command sets all configurable runtime paths explicitly; its POSIX-shell form is:

```bash
env DEADLETTERS_DATA_DIR='/path/to/new-restored-site/data' \
  DEADLETTERS_UPLOADS_DIR='/path/to/new-restored-site/uploads' \
  DEADLETTERS_THEMES_DIR='/path/to/new-restored-site/themes' \
  DEADLETTERS_ADDONS_DIR='/path/to/new-restored-site/addons' \
  DB_PATH='/path/to/new-restored-site/data/deadletters.db' \
  npm start
```

Run that command from the engine directory. Restoration copies site data only—not the engine or dependencies—and does not start or restart a server automatically. Archive extraction is bounded by the shared archive-security entry-count, uncompressed-size, and compression-ratio limits; programmatic callers can pass `archiveLimits` to `restoreSiteSnapshot` when a reviewed snapshot needs different bounds.

## What is implemented

| Area | Current status |
| --- | --- |
| Publishing | Posts and pages, drafts and publishing states, revisions, categories, tags, comments, media uploads, and JWT-backed operator authentication are present in the native application/API. |
| Editor and rendering | A shared server-side Markdown renderer provides `pullquote`, `callout`, `glitch`, and `dropcap` shortcodes, sanitizes output, and is reused by native API, WordPress-shaped reads, feeds, and editor preview. |
| Themes | Three bundled themes, browser preview controls, persisted design tokens, custom CSS, theme activation, and ZIP installation are present. Uploaded theme archives are CSS/JSON/raster/font-only and their active `style.css` is loaded dynamically through `/api/v1/themes/active/style.css`. Client-side previews affect only the current browser; they are not a real-time multi-client service. |
| Resharing | Authenticated users can quote local posts or external URLs with curator commentary. External import performs basic HTML metadata extraction and returns fallback data when fetching or parsing fails. |
| Provenance | **Local Ed25519 prototype.** New re-letters carry a signed public-key envelope and a full provenance chain. Verification is local to this node; it is not remote identity proof, a trusted timestamp, or authorization of arbitrary external URLs. |
| Mesh / federation | **Delivery-only MVP.** Superadmin-registered peers, signed outbox delivery, a public verified inbox audit store, idempotency, and retry/dead-letter handling are implemented. There is no ActivityPub, automatic peer/key discovery, remote post creation, cross-node parent proof, or general synchronization; the mesh addon remains a logging/response stub. |
| WordPress bridge | **Partial and read-only.** Selected `GET` endpoints return WordPress-shaped data; this is not full WordPress REST API emulation or guaranteed drop-in client compatibility. |
| WordPress migration | Authorized operators can export standard posts/pages as WXR and run bounded, transactional WXR imports. The supported fields and deliberate exclusions are documented below; this is not lossless WordPress migration. |
| Addons and hooks | A small WordPress-inspired action/filter bus and ZIP addon loader are present. Addons execute trusted Node.js code and installation/toggling is superadmin-only; they do not provide compatibility with WordPress PHP plugins. |
| Operations | The control panel requests process, database-size, and content-count telemetry on demand. There is no external monitoring pipeline or real-time telemetry stream. |
| Export | `npm run export-zip` packages an allowlisted clean engine; `npm run snapshot-zip` creates a consistent SQLite backup plus site assets, and `snapshot-restore` restores to a new location. These are local archive commands, not a hosted backup service. |

### Theme and static asset boundary

Theme packages are code-free presentation bundles. ZIP installation allows only `.css`, `.json`, raster images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`), and font assets (`.woff`, `.woff2`, `.ttf`, `.otf`); HTML, JavaScript, SVG, and other executable/active formats are rejected before extraction. Theme manifests and slugs are bounded and containment-checked. The active theme's CSS is served from `/api/v1/themes/active/style.css`, so restored or newly installed themes work without rebuilding the frontend.

Static `/uploads` and `/themes` requests are separately restricted to passive media, CSS, JSON, image, and font extensions. This extension guard also protects against legacy or restored files that predate upload validation. Uploaded files remain on the application origin, so operator trust and dependency patching still matter; `Content-Security-Policy` and `X-Content-Type-Options: nosniff` are defense-in-depth, not a substitute for trust boundaries.

### Provenance and node identity

New re-letters use a **local Ed25519 node envelope** (`deadletters-reletter-v1`). The node identity is created lazily and stored as a singleton SQLite row: node handle, Ed25519 public and private keys in DER form encoded as base64url, key ID, algorithm, and creation time. The private key is never returned by the API, hooks, telemetry, or engine export. The SQLite file and its WAL/SHM sidecars are set to owner-only permissions where supported, and the private key remains in database backups.

`GET /.well-known/deadletters.json` is available only on an installed node. It returns the envelope spec, protocol version, node handle, site URL, and the **public** key object (`algorithm`, `key_id`, `public_key`, `created_at`, `public_key_url`). It is served before the single-page-app fallback with a short public cache lifetime. It never includes private key material.

The signed envelope contains:

- `type` and `spec` (`deadletters-reletter-v1`).
- `source` with `url`, `node`, `author`, `title`, `excerpt`, and an optional `local_post_id`.
- `curator` with the local curator `id` and `commentary`.
- `created_at` — a node-local ISO timestamp, not a trusted external timestamp.
- `signing_node` with the local node `handle` and `key_id`.
- `parent_envelope_hash` — `null` for a first re-letter, otherwise the SHA-256 envelope hash of the re-letter being re-lettered.
- `provenance_chain` — the complete chain, including all prior entries.

Serialization is deterministic canonical JSON: object keys are sorted recursively, array order is preserved, and non-finite numbers or unsupported values are rejected. The envelope hash is SHA-256 of the exact canonical bytes, encoded as base64url. The signature is Ed25519 over those same bytes, also base64url. Re-lettering an existing re-letter preserves the original source metadata, the full chain, and the parent envelope hash.

`GET /api/v1/reshares/provenance/:id` returns the stored source and chain plus explicit `hash_valid`, `signature_valid`, `verification_status` (`verified`, `invalid`, or `unverified`), `verification_scope`, `key_id`, `envelope_hash`, `parent_envelope_hash`, `public_key_url`, and `reason`. New records use scope `deadletters-ed25519-v1`. Verification recomputes the canonical hash, checks the signature against the local node public key, validates the key ID and algorithm, and confirms that every stored source, commentary, chain, timestamp, and parent-hash field matches the signed envelope. Unknown or missing keys are `unverified`; mismatched fields or tampered bytes are `invalid`.

Rows created before this feature have no envelope. They continue to use the legacy installation-local HMAC verifier and scope `local-integrity`; new rows never use HMAC. Legacy signatures may be **invalid or unverified** if the original provenance secret was rotated, the record was edited, or the row predates the current HMAC scheme.

This is strictly **local node-envelope verification**. It proves that this node's stored record matches a signature made by this node's key. Registering a peer and receiving a remote envelope does **not** turn that into factual authorship proof, authorization of an arbitrary external URL, validation of the remote source's content, a trusted timestamp, or cross-node agreement. The delivery-only federation MVP below adds an explicitly trusted peer allowlist and signed inbox/outbox transport, but it still does not fetch remote keys automatically, verify parents across nodes, or create local posts from remote envelopes. It has no retraction protocol or general federation synchronization. The mesh addon remains a logging/response stub.

### Delivery-only federation MVP

The engine has a deliberately narrow federation layer. It transports signed re-letter envelopes between explicitly trusted nodes and retains an auditable inbox; it is not ActivityPub, a general mesh sync protocol, or a remote publishing system.

**Peer trust model.** A superadmin registers each peer at `POST /api/v1/federation/peers` with an HTTP(S) base URL, node handle, and an Ed25519 public key in SPKI DER base64url form. The key ID is computed with the same algorithm as local provenance (`ed25519-` plus the first 16 hex characters of SHA-256 over the DER bytes) and must match any supplied `key_id`. The superadmin obtains this key out-of-band (for example, by manually reading the peer's `/.well-known/deadletters.json`) and explicitly trusts it. The node does not fetch remote keys, follow discovery documents, or auto-enroll peers; this avoids remote-key SSRF and blind key substitution. Endpoint URLs must be HTTP(S), credential-free base URLs without query strings or fragments. `GET /api/v1/federation/peers`, `PATCH /api/v1/federation/peers/:id`, `POST /api/v1/federation/peers/:id/disable`, and `DELETE /api/v1/federation/peers/:id` are superadmin-only. Responses contain public peer data only.

**Outbox and signed delivery.** Creating a local re-letter registers a core `post_reshared` hook once and enqueues the signed envelope for every enabled peer. A superadmin can also enqueue explicitly with `POST /api/v1/federation/outbox/enqueue` (`reshare_id` or `post_id`). Delivery IDs are deterministic per peer + envelope hash, and the outbox has a unique constraint on the same pair, so hook and manual enqueue are idempotent.

The delivery body is JSON containing:

- `spec: "deadletters-federation-delivery-v1"`.
- `delivery_id` and `sent_at`.
- `envelope` — the canonical `deadletters-reletter-v1` envelope.
- `envelope_hash`, `signature`, `signature_algorithm: "Ed25519"`, and `key_id`.

The worker POSTs this to `<peer endpoint>/api/v1/federation/inbox` with `redirect: "error"`, a five-second timeout, and a capped response-body read. Non-2xx responses are failures.

**Inbox verification and storage.** `POST /api/v1/federation/inbox` is public but rate-limited and body-capped at 256 KiB. It validates the delivery spec, delivery ID, timestamps, envelope type/spec/fields, chain bounds, and canonical envelope size. It finds an **enabled** registered peer matching the envelope's `signing_node.key_id` and node handle, then recomputes the canonical SHA-256 envelope hash and verifies the Ed25519 signature with that peer's trusted key. A delivery whose claimed `envelope_hash` does not match is rejected. Unknown, disabled, unregistered, mismatched-handle, and tampered deliveries are rejected before any accepted row is written; rejected attempts are still recorded as audit rows when possible.

Accepted rows store the full delivery payload, including the complete signed provenance chain and `parent_envelope_hash`. Duplicate delivery IDs and duplicate accepted envelope hashes return `200` idempotently. New accepted deliveries return `202`. Responses report `parent_envelope_known_locally` and `parent_verification_scope: "local-presence-only"`: the node can say whether it has seen the parent envelope locally, but it does **not** claim to have verified the parent across nodes.

**No fabricated remote posts.** The inbox is an exchange and audit store. Remote envelopes are never converted into local posts or reshares in this MVP, so no remote content is published automatically. Each accepted inbox record explicitly reports `local_post_created: false`.

**Manual and automatic processing.** `POST /api/v1/federation/outbox/process` processes due rows once; superadmins may pass `force` to retry unscheduled rows. `GET /api/v1/federation/outbox` and `GET /api/v1/federation/status` expose counts and delivery state, and `GET /api/v1/federation/inbox` exposes audit records. On an installed node, `startServer()` starts an optional unref'd worker that runs every 60 seconds and is stopped when the HTTP server closes. The worker is not started by importing the app in tests or by other modules.

**Retries and dead letters.** A failed attempt increments `attempts`, stores a bounded error message without a stack trace, and schedules a bounded exponential backoff (30 s, 60 s, 120 s, 240 s, 480 s). After five attempts the row becomes `dead`. Successful deliveries become `delivered`; retryable failures are `failed`; queued rows are `pending`. Disabling a peer stops new hook enqueues and due delivery attempts; re-enabling allows manual enqueue and future processing. Deleting a peer cascades pending outbox rows and leaves inbox audit history with `source_peer_id` cleared.

**Schema.** Migration 3 adds `dl_federation_peers`, `dl_federation_outbox`, and `dl_federation_inbox` with foreign keys and indexes, and the fresh-install schema creates the same tables. Snapshots include this state because it is stored in SQLite.

**Limitations.** This MVP does not implement ActivityPub, automatic peer discovery, remote key fetching, retractions, cross-node parent verification, remote post creation, or a general synchronization protocol. It provides no confidentiality beyond HTTPS; delivery bodies are not application-layer encrypted. A valid node signature proves the envelope was signed by the registered peer key and matches the signed canonical bytes, not that an arbitrary external URL is factually authored or authorized by the claimed source. Use HTTPS and treat peer registration as a security-sensitive act.

**Control-panel surface.** The hash router exposes `#/admin/comments` to roles with `comments:moderate` (art directors and superadmins). It reads `GET /api/v1/comments?status=all`, filters the returned queue locally by all/pending/approved/spam/trash, and changes moderation state through `PUT /api/v1/comments/:id/status`. `#/admin/federation` is superadmin-only and drives the existing federation API: `GET /api/v1/federation/status`, `GET`/`POST /api/v1/federation/peers`, `PATCH`/`DELETE /api/v1/federation/peers/:id`, `GET /api/v1/federation/outbox`, `POST /api/v1/federation/outbox/process`, `GET /api/v1/federation/inbox`, and `POST /api/v1/federation/outbox/enqueue`. The view labels peers as explicitly trusted from out-of-band keys, reports inbox rows as audit records only, and does not present accepted deliveries as cross-node factual proof or publish remote content.

### WordPress-shaped read endpoints

The compatibility router currently implements `GET` handlers for:

- `/wp-json` (discovery document)
- `/wp-json/wp/v2/posts` and `/wp-json/wp/v2/posts/:id`
- `/wp-json/wp/v2/pages`
- `/wp-json/wp/v2/categories`
- `/wp-json/wp/v2/tags`
- `/wp-json/wp/v2/users`
- `/wp-json/wp/v2/comments`

Pagination/search and response fields are limited compared with WordPress. The discovery document may advertise routes beyond the implemented read handlers; consult the router before integrating a client. Writes through `/wp-json`, WordPress authentication/media behavior, permalinks, plugins, and the wider WordPress API surface are not emulated. Native Deadletters write endpoints are separate and require their own authentication.

### WordPress WXR migration scope

`GET /api/v1/settings/export-wxr` exports XML, and `POST /api/v1/settings/import-wxr` accepts one `.xml` upload in the `wxr_file` multipart field. Export requires the settings-export capability; import requires settings-management capability. The importer understands the usual WXR 1.0/1.1/1.2 namespace-qualified fields for **standard `post` and `page` items only**.

The supported migration scope is:

- Post/page titles, source content, excerpts, slugs, local/GMT dates, modification dates, comment status, menu order, and sticky state. Deadletters exports its stored Markdown verbatim in CDATA, including embedded `]]>` delimiters. Imported WordPress HTML or block markup is retained as source text; there is **no HTML-to-Markdown or block-to-shortcode conversion**. Missing excerpts are generated with the shared Markdown renderer.
- `publish`, `private`, `draft`, and `trash` states. WordPress `pending`, `future`, and other non-public states become drafts. Existing slugs are never overwritten: collisions receive numeric suffixes, and every imported item receives a newly checked unique drop code. Database IDs are newly assigned; post-parent links are remapped when the parent is in the same import.
- Authors are matched to **existing** Deadletters accounts by login and then the WXR author email. Unmatched or missing authors use the authenticated operator supplied as `defaultUserId`. Import never creates users, passwordless accounts, or credentials.
- Standard categories and tags, including descriptions, available category parents, and post relationships. Equivalent `wp:term` declarations for these two taxonomies are accepted. Other taxonomies are skipped and counted. Taxonomy counters are recalculated from relationships after import.
- Approved (`1`) and pending (`0`) comments, their source text/authors/dates, and parent links where possible. Comment user IDs are linked only to matched existing accounts. Spam, trash, and other moderation states are skipped and counted; post comment counters include approved imported comments only.
- Unsupported item types such as attachments, custom post types, and revisions are explicitly skipped. The response reports imported post/page/term/relationship/comment counts plus skipped item types, taxonomies, and comment states.

The importer validates the complete XML before writing and performs all supported item, taxonomy, relationship, comment, and counter changes in one all-or-nothing SQLite transaction. DTDs, entity declarations, and external entities are rejected; parsing performs no network or external-file resolution. Only the five predefined XML entities and valid numeric character references are decoded outside CDATA. Uploads are UTF-8 XML limited to **20 MiB**, one file, 5,000 channel items, 10,000 term declarations, and 50,000 comments on supported items. Temporary upload files are removed after success, parse/database errors, and multipart limit errors.

**Not migrated:** user passwords/password hashes or post passwords, new WordPress users, media binaries or attachment items, featured-image assignments, revisions, Deadletters reshares/provenance records, arbitrary post/user metadata, custom taxonomies, WordPress options, widgets, navigation menus, plugin state, or arbitrary custom post types. Orphaned parent IDs and unsupported relationships are not retained as arbitrary metadata. A WXR import is therefore a content migration, not a complete site clone or backup/restore mechanism.

## Native API and feeds

The application mounts native routes under `/api/v1` for installer status/execution, authentication, posts, reshares, media, taxonomies, comments, themes, addons, settings, and delivery-only federation. Authentication and role requirements vary by route; the server and route modules are the source of truth while the API is evolving.

Useful read routes include:

- `GET /api/v1/posts` and `GET /api/v1/posts/:idOrSlug`
- `GET /api/v1/reshares/stream`
- `GET /api/v1/reshares/provenance/:id`
- `POST /api/v1/federation/inbox` — public, rate-limited signed delivery endpoint
- `GET`/`POST /api/v1/federation/peers` — superadmin peer trust anchors
- `POST /api/v1/federation/outbox/enqueue` and `POST /api/v1/federation/outbox/process` — superadmin outbox operations
- `GET /api/v1/federation/status`, `/outbox`, and `/inbox` — superadmin delivery counts and audit records
- `GET /.well-known/deadletters.json` — public Ed25519 node identity discovery
- `GET /api/v1/themes` and `GET /api/v1/themes/active`
- `GET /feed` or `GET /rss` — RSS 2.0
- `GET /feed/json` — JSON Feed 1.1
- `GET /sitemap.xml` and `GET /robots.txt`

## Checks and tests

```bash
npm run check:syntax
npm test
```

- `check:syntax` recursively runs Node's syntax checker over project `.js`, `.cjs`, and `.mjs` files. It skips dependency/VCS directories, generated build/export/log directories, and runtime data/upload directories.
- `test` runs Node's built-in `node --test` runner without adding a third-party test framework. The suite includes unit, route/application integration, archive-security, export/snapshot/restore, and WXR namespace/entity/rollback/round-trip/upload-limit tests; database and archive tests use temporary runtime directories and close their SQLite connections.

GitHub Actions runs `npm ci`, the syntax check, and `npm test` on Node.js 24 for pushes and pull requests. These checks do not replace deployment, migration, or browser testing.

## CLI commands

```bash
node bin/deadletters.js start         # Start the HTTP server
node bin/deadletters.js install       # Run the interactive terminal installer
node bin/deadletters.js export-zip    # Create an engine archive in the data directory
node bin/deadletters.js snapshot-zip  # Create a site snapshot in the data directory
node bin/deadletters.js snapshot-restore <archive> <target-directory>
node bin/deadletters.js help          # Show CLI help
```

## License

**Proprietary.** This repository does not currently grant an open-source license, and no open-source `LICENSE` file has been selected.
