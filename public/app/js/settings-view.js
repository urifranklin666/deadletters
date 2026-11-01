/**
 * DEADLETTERS ENGINE SETTINGS & PACKAGER
 * Configuration and Distributable Zip Packaging for Deployment & Resale
 */

const SettingsView = {
  async render(container) {
    try {
      const settings = await API.get('/api/v1/settings');

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // ENGINE GOVERNANCE //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">SITE SETTINGS & ENGINE PACKAGER</h2>
            </div>
            <button id="btn-save-settings" class="dl-btn dl-btn-accent">⚡ COMMIT SETTINGS</button>
          </div>

          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 2rem;">
            <!-- Left: Settings Form -->
            <div class="dl-card">
              <div class="dl-box-title">// CORE ENGINE OPTIONS</div>

              <div class="dl-form-group">
                <label class="dl-label">Site / Atelier Title</label>
                <input id="set-title" class="dl-input" type="text" value="${escapeHtml(settings.site_title)}" />
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Tagline / Transmission Header</label>
                <input id="set-tagline" class="dl-input" type="text" value="${escapeHtml(settings.site_tagline)}" />
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div class="dl-form-group">
                  <label class="dl-label">Mesh Node Handle</label>
                  <input id="set-handle" class="dl-input" type="text" value="${escapeHtml(settings.site_node_handle)}" />
                </div>
                <div class="dl-form-group">
                  <label class="dl-label">Canonical URL</label>
                  <input id="set-url" class="dl-input" type="text" value="${escapeHtml(settings.site_url)}" />
                </div>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Master Operator Email</label>
                <input id="set-email" class="dl-input" type="email" value="${escapeHtml(settings.admin_email)}" />
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Permalink Structure</label>
                <select id="set-permalink" class="dl-select">
                  <option value="/letter/%postname%" selected>Editorial Slug (/letter/%postname%)</option>
                  <option value="/%year%/%month%/%postname%">WordPress Date Style (/%year%/%month%/%postname%)</option>
                  <option value="/drop/%drop_code%">Deadletter Drop Code (/drop/%drop_code%)</option>
                </select>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Discussion & Comment Moderation</label>
                <select id="set-comments" class="dl-select">
                  <option value="1" ${settings.default_comment_approved === '1' ? 'selected' : ''}>Instant Broadcast (Open Discussion)</option>
                  <option value="0" ${settings.default_comment_approved === '0' ? 'selected' : ''}>Queue for Operator Clearance (Moderation)</option>
                </select>
              </div>
            </div>

            <!-- Right: Standalone Engine Packager -->
            <div style="display: flex; flex-direction: column; gap: 1.5rem;">
              <div class="dl-card" style="border-color: var(--dl-accent);">
                <div class="dl-box-title" style="color: var(--dl-accent);">// ENTERPRISE PACKAGER // COMMERCIAL RESALE</div>
                <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.25rem; line-height: 1.5;">
                  Package the Deadletters engine into a clean, standalone, zero-dependency distribution ZIP ready to sell, license, or deploy for internal atelier clients.
                </p>

                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  <button id="btn-export-engine-zip" class="dl-btn dl-btn-accent" style="width: 100%;">
                    📦 COMPILE ENGINE DISTRO (.ZIP)
                  </button>
                  <button id="btn-export-snapshot-zip" class="dl-btn dl-btn-outline" style="width: 100%;">
                    💾 EXPORT SITE SNAPSHOT (.ZIP)
                  </button>
                </div>

                <div id="export-download-pane" style="margin-top: 1.25rem; padding: 1rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.75rem; display: none;">
                  <div style="color: var(--dl-accent); margin-bottom: 0.25rem;">PACKAGE READY:</div>
                  <div id="export-filename" style="color: #fff; margin-bottom: 0.5rem;"></div>
                  <a id="export-download-link" href="#" class="dl-btn dl-btn-accent dl-btn-sm" style="display: inline-block;">DOWNLOAD .ZIP</a>
                </div>
              </div>

              <!-- WordPress WXR Migration Hub -->
              <div class="dl-card" style="border-color: var(--dl-cyan);">
                <div class="dl-box-title" style="color: var(--dl-cyan);">// WORDPRESS WXR MIGRATION HUB</div>
                <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.25rem; line-height: 1.5;">
                  Achieve 100% data portability with standard WordPress eXtended RSS (WXR 1.2). Migrate from WordPress to Deadletters or export back anytime.
                </p>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  <input type="file" id="wxr-file-input" style="display: none;" accept=".xml" />
                  <button id="btn-import-wxr" class="dl-btn dl-btn-outline" style="width: 100%;">
                    📥 IMPORT WORDPRESS XML (.XML)
                  </button>
                  <a href="/api/v1/settings/export-wxr" target="_blank" class="dl-btn dl-btn-ghost" style="width: 100%; text-align: center;">
                    📤 EXPORT AS WORDPRESS WXR (.XML)
                  </a>
                </div>
              </div>

              <!-- Deadplug Licensing Card -->
              <div class="dl-card">
                <div class="dl-box-title">// DEADPLUG.DIGITAL CLEARANCE</div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">CREATOR:</span>
                    <span>deadplug.digital</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">RUNTIME:</span>
                    <span>Node.js ESM + SQLite</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">PHP STATUS:</span>
                    <span style="color: var(--dl-emerald);">ZERO PHP DETECTED</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">VERSION:</span>
                    <span style="color: var(--dl-accent);">1.0.0 ENTERPRISE</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      this.bindSettingsEvents(container);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Settings error: ${err.message}</div></div>`;
    }
  },

  bindSettingsEvents(container) {
    // Save Settings
    container.querySelector('#btn-save-settings').addEventListener('click', async () => {
      const payload = {
        site_title: container.querySelector('#set-title').value,
        site_tagline: container.querySelector('#set-tagline').value,
        site_node_handle: container.querySelector('#set-handle').value,
        site_url: container.querySelector('#set-url').value,
        admin_email: container.querySelector('#set-email').value,
        permalink_structure: container.querySelector('#set-permalink').value,
        default_comment_approved: container.querySelector('#set-comments').value
      };

      try {
        await API.put('/api/v1/settings', payload);
        App.showToast('Engine configuration updated.');
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    });

    // Export Engine Zip
    const exportEngineBtn = container.querySelector('#btn-export-engine-zip');
    const exportSnapshotBtn = container.querySelector('#btn-export-snapshot-zip');
    const dlPane = container.querySelector('#export-download-pane');
    const dlFilename = container.querySelector('#export-filename');
    const dlLink = container.querySelector('#export-download-link');

    exportEngineBtn.addEventListener('click', async () => {
      exportEngineBtn.disabled = true;
      exportEngineBtn.innerText = 'COMPILING BUNDLE...';
      try {
        const res = await API.post('/api/v1/settings/export-engine-zip');
        App.showToast(`Distributable created (${Math.round(res.sizeBytes / 1024)} KB)`);
        dlFilename.innerText = `${res.filename} (${(res.sizeBytes / 1024).toFixed(1)} KB)`;
        dlLink.href = res.downloadUrl;
        dlLink.download = res.filename;
        dlPane.style.display = 'block';
      } catch (e) {
        alert('Packaging error: ' + e.message);
      } finally {
        exportEngineBtn.disabled = false;
        exportEngineBtn.innerText = '📦 COMPILE ENGINE DISTRO (.ZIP)';
      }
    });

    exportSnapshotBtn.addEventListener('click', async () => {
      exportSnapshotBtn.disabled = true;
      exportSnapshotBtn.innerText = 'ARCHIVING SNAPSHOT...';
      try {
        const res = await API.post('/api/v1/settings/export-snapshot-zip');
        App.showToast(`Site snapshot created (${Math.round(res.sizeBytes / 1024)} KB)`);
        dlFilename.innerText = `${res.filename} (${(res.sizeBytes / 1024).toFixed(1)} KB)`;
        dlLink.href = res.downloadUrl;
        dlLink.download = res.filename;
        dlPane.style.display = 'block';
      } catch (e) {
        alert('Snapshot error: ' + e.message);
      } finally {
        exportSnapshotBtn.disabled = false;
        exportSnapshotBtn.innerText = '💾 EXPORT SITE SNAPSHOT (.ZIP)';
      }
    });

    // WordPress XML Import
    const wxrFileInput = container.querySelector('#wxr-file-input');
    const importWxrBtn = container.querySelector('#btn-import-wxr');

    importWxrBtn.addEventListener('click', () => wxrFileInput.click());
    wxrFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      importWxrBtn.disabled = true;
      importWxrBtn.innerText = 'IMPORTING WORDPRESS DATA...';

      try {
        const res = await API.uploadFile(file, '/api/v1/settings/import-wxr', 'wxr_file');
        App.showToast(res.message);
        alert(`Success: ${res.message}\nImported ${res.stats.importedPosts} post(s) and ${res.stats.importedPages} page(s).`);
      } catch (err) {
        alert('Import failed: ' + err.message);
      } finally {
        importWxrBtn.disabled = false;
        importWxrBtn.innerText = '📥 IMPORT WORDPRESS XML (.XML)';
      }
    });
  }
};
