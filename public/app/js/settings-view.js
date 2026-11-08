/**
 * DEADLETTERS ENGINE SETTINGS & PACKAGER
 * Configuration, backup export, and WordPress migration controls
 */

const SettingsView = {
  async render(container) {
    try {
      const settings = await API.get('/api/v1/settings');
      const canManage = App.can('settings:manage');
      const canExport = App.can('settings:export');

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // ENGINE GOVERNANCE //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">SITE SETTINGS & ENGINE PACKAGER</h2>
            </div>
            ${canManage ? '<button id="btn-save-settings" class="dl-btn dl-btn-accent">⚡ COMMIT SETTINGS</button>' : ''}
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

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div class="dl-form-group">
                  <label class="dl-label">Dispatches Per Page</label>
                  <input id="set-per-page" class="dl-input" type="number" min="1" max="100" value="${escapeHtml(settings.posts_per_page || '12')}" />
                </div>
                <div class="dl-form-group">
                  <label class="dl-label">Front Page Displays</label>
                  <select id="set-front-page" class="dl-select">
                    <option value="posts" ${settings.front_page_display === 'page' ? '' : 'selected'}>Published dispatches</option>
                    <option value="page" ${settings.front_page_display === 'page' ? 'selected' : ''}>One static page</option>
                  </select>
                </div>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Static Front Page ID</label>
                <input id="set-page-on-front" class="dl-input" type="number" min="0" value="${escapeHtml(settings.page_on_front || 0)}" />
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Re-lettering</label>
                <select id="set-reshares" class="dl-select">
                  <option value="1" ${settings.reshares_enabled === '0' ? '' : 'selected'}>Enabled</option>
                  <option value="0" ${settings.reshares_enabled === '0' ? 'selected' : ''}>Disabled</option>
                </select>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Permalink Structure</label>
                <input id="set-permalink" class="dl-input" type="text" value="/letter/%postname%" readonly />
                <div style="font-size: 0.72rem; color: var(--dl-text-muted); margin-top: 0.35rem; line-height: 1.5;">
                  The current router serves letters at /letter/&lt;slug&gt; and pages at /page/&lt;slug&gt;. Alternate permalink patterns are not implemented.
                </div>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Discussion & Comment Moderation</label>
                <select id="set-comments" class="dl-select">
                  <option value="1" ${settings.default_comment_approved === '1' ? 'selected' : ''}>Instant Broadcast (Open Discussion)</option>
                  <option value="0" ${settings.default_comment_approved === '0' ? 'selected' : ''}>Queue for Operator Clearance (Moderation)</option>
                </select>
              </div>
            </div>

            <!-- Right: Engine and Site Packager -->
            <div style="display: flex; flex-direction: column; gap: 1.5rem;">
              <div class="dl-card" style="border-color: var(--dl-accent);">
                <div class="dl-box-title" style="color: var(--dl-accent);">// ENGINE EXPORT PACKAGER</div>
                <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.25rem; line-height: 1.5;">
                  Package the Deadletters engine or a full site snapshot into a ZIP archive for backup, migration, or deployment on another node. Site snapshots contain sensitive configuration; store them securely.
                </p>

                ${canExport ? `
                  <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    <button id="btn-export-engine-zip" class="dl-btn dl-btn-accent" style="width: 100%;">
                      📦 COMPILE ENGINE DISTRO (.ZIP)
                    </button>
                    <button id="btn-export-snapshot-zip" class="dl-btn dl-btn-outline" style="width: 100%;">
                      💾 EXPORT SITE SNAPSHOT (.ZIP)
                    </button>
                  </div>
                  <p style="font-size: 0.72rem; color: var(--dl-text-muted); margin-top: 0.85rem; line-height: 1.5;">
                    Downloads are fetched with the authenticated session; files are not exposed through public links.
                  </p>
                ` : `
                  <p style="font-size: 0.8rem; color: var(--dl-text-muted); font-family: var(--dl-font-mono);">
                    // EXPORT CLEARANCE REQUIRED //
                  </p>
                `}
              </div>

              <!-- WordPress WXR Migration Hub -->
              <div class="dl-card" style="border-color: var(--dl-cyan);">
                <div class="dl-box-title" style="color: var(--dl-cyan);">// WORDPRESS WXR MIGRATION HUB</div>
                <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.25rem; line-height: 1.5;">
                  Import or export WordPress eXtended RSS (WXR 1.2) for supported posts, pages, comments, and author fields. WXR is not a byte-for-byte backup of every WordPress feature.
                </p>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  ${canManage ? `
                    <input type="file" id="wxr-file-input" style="display: none;" accept=".xml" />
                    <button id="btn-import-wxr" class="dl-btn dl-btn-outline" style="width: 100%;">
                      📥 IMPORT WORDPRESS XML (.XML)
                    </button>
                  ` : ''}
                  ${canExport ? `
                    <button id="btn-export-wxr" class="dl-btn dl-btn-ghost" style="width: 100%;">
                      📤 EXPORT AS WORDPRESS WXR (.XML)
                    </button>
                  ` : ''}
                </div>
              </div>

              <!-- Node Runtime Card -->
              <div class="dl-card">
                <div class="dl-box-title">// NODE RUNTIME</div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">CREATOR:</span>
                    <span>deadplug.digital</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">RUNTIME:</span>
                    <span>Node.js CommonJS + SQLite</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">PHP STATUS:</span>
                    <span style="color: var(--dl-emerald);">ZERO PHP DETECTED</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">VERSION:</span>
                    <span style="color: var(--dl-accent);">${escapeHtml(settings.meta?.version || '1.0.0')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      this.bindSettingsEvents(container);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Settings error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  bindSettingsEvents(container) {
    // Save Settings
    const saveBtn = container.querySelector('#btn-save-settings');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const payload = {
          site_title: container.querySelector('#set-title').value,
          site_tagline: container.querySelector('#set-tagline').value,
          site_node_handle: container.querySelector('#set-handle').value,
          site_url: container.querySelector('#set-url').value,
          admin_email: container.querySelector('#set-email').value,
          permalink_structure: container.querySelector('#set-permalink').value,
          default_comment_approved: container.querySelector('#set-comments').value,
          posts_per_page: container.querySelector('#set-per-page').value,
          front_page_display: container.querySelector('#set-front-page').value,
          page_on_front: container.querySelector('#set-page-on-front').value,
          reshares_enabled: container.querySelector('#set-reshares').value
        };

        try {
          await API.put('/api/v1/settings', payload);
          App.showToast('Engine configuration updated.');
        } catch (e) {
          alert('Save failed: ' + e.message);
        }
      });
    }

    // Export Engine Zip
    const exportEngineBtn = container.querySelector('#btn-export-engine-zip');
    if (exportEngineBtn) {
      exportEngineBtn.addEventListener('click', async () => {
        exportEngineBtn.disabled = true;
        exportEngineBtn.innerText = 'COMPILING BUNDLE...';
        try {
          const res = await API.post('/api/v1/settings/export-engine-zip');
          const downloadUrl = safeUrl(res.downloadUrl);
          if (!downloadUrl) throw new Error('Export returned an invalid download URL.');
          const downloaded = await API.download(downloadUrl, res.filename || 'deadletters-engine.zip');
          App.showToast(`Engine distribution downloaded (${Math.round(downloaded.sizeBytes / 1024)} KB).`);
        } catch (e) {
          alert('Packaging error: ' + e.message);
        } finally {
          exportEngineBtn.disabled = false;
          exportEngineBtn.innerText = '📦 COMPILE ENGINE DISTRO (.ZIP)';
        }
      });
    }

    const exportSnapshotBtn = container.querySelector('#btn-export-snapshot-zip');
    if (exportSnapshotBtn) {
      exportSnapshotBtn.addEventListener('click', async () => {
        exportSnapshotBtn.disabled = true;
        exportSnapshotBtn.innerText = 'ARCHIVING SNAPSHOT...';
        try {
          const res = await API.post('/api/v1/settings/export-snapshot-zip');
          const downloadUrl = safeUrl(res.downloadUrl);
          if (!downloadUrl) throw new Error('Export returned an invalid download URL.');
          const downloaded = await API.download(downloadUrl, res.filename || 'deadletters-snapshot.zip');
          App.showToast(`Site snapshot downloaded (${Math.round(downloaded.sizeBytes / 1024)} KB).`);
        } catch (e) {
          alert('Snapshot error: ' + e.message);
        } finally {
          exportSnapshotBtn.disabled = false;
          exportSnapshotBtn.innerText = '💾 EXPORT SITE SNAPSHOT (.ZIP)';
        }
      });
    }

    // WordPress WXR Export
    const exportWxrBtn = container.querySelector('#btn-export-wxr');
    if (exportWxrBtn) {
      exportWxrBtn.addEventListener('click', async () => {
        exportWxrBtn.disabled = true;
        exportWxrBtn.innerText = 'PREPARING WXR EXPORT...';
        try {
          const downloaded = await API.download('/api/v1/settings/export-wxr', 'deadletters-export.xml');
          App.showToast(`WXR export downloaded: ${downloaded.filename}`);
        } catch (e) {
          alert('WXR export failed: ' + e.message);
        } finally {
          exportWxrBtn.disabled = false;
          exportWxrBtn.innerText = '📤 EXPORT AS WORDPRESS WXR (.XML)';
        }
      });
    }

    // WordPress XML Import
    const wxrFileInput = container.querySelector('#wxr-file-input');
    const importWxrBtn = container.querySelector('#btn-import-wxr');

    if (wxrFileInput && importWxrBtn) {
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
  }
};
