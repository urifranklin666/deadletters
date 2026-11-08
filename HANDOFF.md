# Deadletters implementation handoff

Date: 2026-11-08

## 1. Repository state — read this first

- Project root: `/run/media/deadplug/CODE/deadletters`
- Public remote: `https://github.com/urifranklin666/deadletters.git`
- Branch: `main`, tracking `origin/main`.
- HEAD remains `7ece279` (`Initial commit: Deadletters v1.0.0 brutalist blogging engine`).
- **All of the implementation below is uncommitted and unpushed.**
- The working tree contains a large, intentional Phase 0–4 change set. **Do not run `git reset`, `git clean`, or discard changes.**
- The only staged change is the deletion of `src/content/data/config.json` from Git’s index. The local runtime config remains on disk and is ignored.
- Local runtime secrets were rotated during this work. The local config and SQLite database are mode `0600`. The original public-repository JWT secret must still be treated as compromised because it remains in Git history.
- Existing legacy HMAC reshare signatures may now verify as invalid after secret rotation; this is expected. New reshares use Ed25519.
- No commit or push was made. Ask for explicit confirmation before any further Git mutation.
- No `AGENTS.md` exists.

## 2. Final verification

Current verified state:

```text
npm test                 -> 162 tests passed, 0 failed
npm run check:syntax     -> 70 JavaScript files passed
git diff --check         -> clean
```

A live smoke test against the existing local database passed:

```text
GET /healthz                          -> 200
GET /readyz                           -> 200
GET /.well-known/deadletters.json     -> 200
GET /                                -> 200
discovery spec                        -> deadletters-reletter-v1
discovery key id                      -> ed25519-66057df79173d78e
private key exposed                   -> false
shutdown                              -> closed, no timeout
database/config permissions           -> 0600
```

The federation tests spawn two real child Node processes with isolated runtime directories and exchange signed re-letters over HTTP.

## 3. Architecture

Keep the current architecture:

- CommonJS Node.js, Express 5, synchronous `better-sqlite3` with WAL.
- No-build vanilla browser frontend with hash routes plus server-injected canonical initial routes.
- Node built-in `node:test`; no Playwright/browser suite yet.
- Node `>=22.12.0`; CI uses Node 24.
- Proprietary package metadata; no open-source LICENSE selected.

Commands:

```bash
npm test
npm run check:syntax
git diff --check
npm start
```

## 4. Completed roadmap

### Phase 0 — reproducible baseline

- Aligned manifest/lock dependencies and added Node/repository metadata.
- Added `npm test`, recursive syntax checking, and GitHub Actions CI.
- Reworked README to distinguish implemented, limited, and planned behavior.
- Removed runtime config from Git tracking and ignored runtime data.
- Replaced the fixed JWT fallback with generated/persisted secrets.
- Added atomic owner-only config writes and safe environment configuration.
- Default bind address is loopback for new installs.

### Phase 1 — secure single node

#### Authentication and authorization

- Bearer-only JWT authentication with issuer/audience checks, configurable TTL, and per-user token versions.
- Password changes revoke previous tokens.
- Login/comment/external-import/federation-inbox rate limits.
- Central capability matrix in `src/core/capabilities.js`:
  - `superadmin`: all.
  - `art_director`: editorial, moderation, media, themes, limited user enrollment.
  - `author`: own posts and media upload.
  - `operator`: authentication, comments, reshares; no admin tools.
- Route-level ownership and capability checks; executable addons are superadmin-only.
- Settings and telemetry privacy enforcement.

#### Content safety

- Shared server renderer in `src/core/content-renderer.js` using `marked` and `sanitize-html`.
- Markdown plus pullquote/callout/glitch/dropcap; second sanitize boundary after addon filters.
- Native API, WP reads, feeds, and editor preview share the renderer.
- Frontend escape/safe-URL helpers, encoded path segments, and removed inline executable handlers.
- Browser CSP with same-origin executable scripts, no inline script/eval, and defense-in-depth headers.

#### Uploads and external data

- Media allowlist with extension/MIME/magic-byte checks, random filenames, and cleanup.
- Archive path containment, entry/count/size/ratio limits, no overwrite, rollback.
- Theme ZIPs allow only CSS/JSON/raster images/fonts; HTML/JS/SVG rejected.
- `/uploads` and `/themes` static requests are extension-restricted, including legacy/restored files.
- External metadata import blocks credentials, non-HTTP(S), private/reserved DNS/IP ranges, unsafe redirects, non-HTML, and oversized bodies. DNS-rebinding TOCTOU remains documented because built-in fetch cannot pin the resolved IP.

#### Database/reliability

- Ordered schema migrations with fail-fast startup.
- Transactional install, posts/taxonomies, revisions, comments/moderation, reshares, federation, and WXR import.
- Correct counters, slug updates, revision attribution, and publish hooks.
- SQLite main/WAL/SHM permissions restricted where supported.

#### Install and hooks

- Real Node/SQLite/filesystem diagnostics.
- 12-character administrator passwords.
- Local-only tokenless install in development; setup token required for production/remote.
- Working post-install authenticated state.
- Addon reload removes old handlers before registration; no duplicate hooks.

### Phase 2 — editorial product and portability

- Canonical direct routes: `/`, `/letter/:slug`, `/page/:slug`, `/reshares`, `/admin`, `/installer`.
- Per-letter safe title/description/canonical/OpenGraph/Twitter/JSON-LD through the SEO hook.
- Public re-letter view with quoted source, commentary, full chain, envelope/key IDs, and honest verification states.
- Public settings projection excludes admin email/moderation/permalink fields.
- Supported settings validated; pagination, static front-page display, re-letter enablement, comment moderation default, site URL/email, and canonical permalink structure are wired to product behavior.
- Comments moderation UI and federation control UI.
- Engine ZIP uses explicit allowlists, excludes secrets/runtime content, includes lockfile, and has a working bootstrap that starts the server.
- Snapshot creation uses SQLite online backup; non-destructive restore CLI validates archive/database and requires a new empty target.
- WXR migration uses `fast-xml-parser`, validates complete XML, imports atomically, supports standard posts/pages, terms, relationships, parents, and comments, and reports unsupported content. Media/revisions/reshares/passwords/metadata remain outside scope.
- Active theme CSS, including safely installed themes, loads dynamically via `/api/v1/themes/active/style.css`.

### Phase 3 — Ed25519 provenance and delivery federation

#### Local provenance

- Singleton per-node Ed25519 identity stored in SQLite; private key never exposed.
- Public discovery: `GET /.well-known/deadletters.json`.
- `deadletters-reletter-v1` canonical envelope with sorted JSON, full chain, parent hash, source/curator metadata, node/key identity, and timestamp.
- SHA-256 envelope hash and Ed25519 signature in base64url.
- New reshares are Ed25519-signed, not HMAC-signed.
- Re-lettering a re-letter preserves original source metadata, complete chain, and parent envelope hash.
- Verification detects tampered commentary/source/chain/hash and reports `verified`/`invalid`/`unverified` with explicit scope, key ID, hashes, public-key URL, and reason.
- Legacy HMAC rows remain verifiable only as `local-integrity`; rotation can make old signatures invalid.

#### Delivery-only federation

- Superadmin explicitly registers peers with endpoint, node handle, and out-of-band Ed25519 public key.
- No automatic remote key discovery/fetching in this MVP.
- `post_reshared` enqueues once per enabled peer; explicit enqueue is also available.
- Signed JSON delivery to peer `/api/v1/federation/inbox`.
- Inbox validates registered peer key/handle, canonical hash, signature, claimed hash, bounds, and idempotency.
- Accepted inbox rows retain the complete signed chain/parent hash in an audit store; remote content is not fabricated into local posts.
- Five-attempt exponential backoff and dead-letter state.
- Optional unref’d 60-second worker started only by `startServer`; graceful shutdown stops it.
- Superadmin federation UI for peers, outbox/inbox status, delivery processing, and enqueue.
- Two-node integration test proves real HTTP exchange, tamper rejection, idempotency, retry, and dead-letter behavior.

### Phase 4 — operations and product polish

- `GET /healthz` liveness and `GET /readyz` readiness with safe component booleans.
- Idempotent `shutdown({ timeoutMs })`, signal handlers only from `startServer`, worker/database cleanup.
- Opt-in structured request logs without query strings or auth headers.
- CSP, COOP, nosniff, frame denial, referrer/permissions policy, and non-local HTTPS HSTS.
- Role-aware admin landing/navigation and hidden unauthorized controls.
- Accessible confirmation/modal patterns, focus trapping/Escape, responsive moderation/federation tables.
- Honest addon metadata: compatibility markers and local license status only; no fake enterprise verification or peer relay claims.

## 5. Remaining limitations and known gaps

These are deliberate next steps, not defects hidden by the test suite.

1. **No browser E2E/visual/accessibility suite.** Current tests are HTTP/unit/integration plus syntax. Add Playwright for fresh install → admin → publish → canonical URL → comment/moderation → reshare → federation UI → export/restore.
2. **No node-key rotation/revocation workflow.** A disclosed DB/snapshot means the node private key is compromised. A future migration should retain retired public keys for historical verification while rotating the current signing key.
3. **Federation remains delivery-only.** It does not auto-discover/fetch keys, ingest remote envelopes into the public blog, verify parents across nodes, retract content, or implement ActivityPub/general sync. Inbox is audit-only.
4. **Snapshots contain private keys and config secrets and are unencrypted.** They are mode 0600 but must be protected like credential backups.
5. **No deployment automation/scheduling.** No systemd unit, reverse-proxy config, TLS termination, backup schedule, retention, or off-site backup.
6. **No performance/load benchmarks.** Avoid restoring cold-boot/high-traffic claims without measurements.
7. **Addons execute trusted Node code.** Superadmin-only and reload cleanup exist, but there is no sandbox, permission manifest, async hook contract, or full compatibility layer.
8. **Theme/custom CSS is trusted presentation state.** Uploaded files are strictly passive and client token values are pattern-checked, but arbitrary custom CSS from authorized editors is still powerful.
9. **Comment admin queue reads the latest 100 and filters client-side.** Add server pagination/filter support when volume grows.
10. **Canonical missing/draft content currently returns a shell with HTTP 200 and `noindex`.** Decide whether a true 404 is preferable and test it.
11. **WXR remains content-only.** No media binaries, revisions, reshares/provenance, passwords, arbitrary metadata, custom taxonomies, menus, widgets, or plugin state.
12. **No API schema/OpenAPI/client SDK.** README and route code remain the source of truth.
13. **No automatic local JWT/provenance-secret rotation command.** Local secrets have been rotated manually; a documented CLI upgrade flow is still desirable.
14. **Package version remains `1.0.0`.** Choose an intentional release version and update package metadata/lock together when preparing to commit.
15. **Licensing decision is unresolved.** Package is marked Proprietary; no LICENSE file has been added.

## 6. Recommended next steps

### 1. Browser regression suite

Add Playwright with CI Chromium and cover:

- Fresh install from empty temp runtime.
- Superadmin instant login and role-aware landing.
- Publish/preview/safe shortcode rendering.
- Direct canonical URL and metadata.
- Comment submission/pending/moderation.
- Re-letter creation and verification UI.
- Federation peer registration/outbox processing against a second test node.
- Downloads using bearer auth.
- Snapshot export and non-destructive restore.

### 2. Node identity rotation

- Add migration/history table for retired public keys.
- Rotate current key in a transaction; retain retired public keys for local historical verification.
- CLI with explicit confirmation and backup warning.
- Update discovery/federation trust documentation.
- Do not print private material.

### 3. Decide federation product boundary

Either keep inbox as audit-only or design safe remote-content import/display with clear provenance labels, moderation, source trust, deletion/retraction, and parent-key handling. Do not silently turn signed remote payloads into normal local posts.

### 4. Deployment and backup operations

Add reviewed systemd/reverse-proxy/TLS examples, backup scheduling, restore drills, log rotation, health probes, and secret/env management. Document the exact supported Node LTS.

### 5. Performance claims

Benchmark cold boot, publication reads, feed generation, export/restore, and federation batches. Remove or retain claims based on measurements.

### 6. Release preparation

- Review the full diff.
- Bump version/package lock if desired.
- Decide license and add `LICENSE`.
- Confirm user approval for `git add`, commit, and push.
- Push only after confirming secrets have been rotated and no runtime data is staged.

## 7. Files most useful to the next agent

- Auth/capabilities: `src/core/auth.js`, `src/core/capabilities.js`
- Rendering/XSS: `src/core/content-renderer.js`, frontend `public/app/js/api.js`
- Provenance: `src/core/provenance.js`, `test/provenance.test.js`
- Federation: `src/core/federation.js`, `src/api/federation.routes.js`, `test/federation.test.js`
- Public shell/SEO: `src/core/public-shell.js`, `test/public-shell.test.js`
- Database/migrations: `src/core/db.js`, `src/core/schema.js`, `src/core/migrations.js`
- Export/restore: `src/core/exporter.js`, `test/exporter.test.js`
- WXR: `src/core/wxr.js`, `test/wxr.test.js`
- Operations: `src/server.js`, `test/operations.test.js`
- Full app lifecycle: `test/app-integration.test.js`
- Settings privacy: `test/settings-privacy.test.js`
- UI: `public/app/js/comments-view.js`, `federation-view.js`, `blog-reader.js`, `settings-view.js`, `theme-studio.js`
- Runtime handoff: this file.

## 8. Git safety

- Do not discard or reset the working tree.
- Do not force-push.
- The initial public commit still contains the old secret; rotation is the remediation, not history deletion.
- Ask for confirmation before any Git mutation.
- If committing, include the staged deletion of runtime config and exclude `src/content/data/`, databases, exports, logs, and ignored runtime files.
