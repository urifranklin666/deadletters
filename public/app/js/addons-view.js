/**
 * DEADLETTERS ADDONS & PLUGINS MANAGER
 * Extensible Hook & Action Architecture Interface
 */

const AddonsView = {
  async render(container) {
    try {
      const [addonsRes, hooksRes] = await Promise.all([
        API.get('/api/v1/addons'),
        API.get('/api/v1/addons/hooks')
      ]);

      const addons = addonsRes.addons || [];
      const hooks = hooksRes || { actions: [], filters: [] };

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // EXTENSIBLE RUNTIME PIPELINE //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">ADDONS & HOOK ARCHITECTURE</h2>
            </div>
            <div>
              <input type="file" id="addon-zip-input" style="display: none;" accept=".zip" />
              <button id="btn-upload-addon" class="dl-btn dl-btn-accent">+ UPLOAD ADDON (.ZIP)</button>
            </div>
          </div>

          <!-- Addons List Table -->
          <div class="dl-card" style="padding: 0; overflow: hidden; margin-bottom: 2.5rem;">
            <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700;">
              INSTALLED ENGINE ADDONS // ${addons.length} ACTIVE MODULES
            </div>

            <table class="dl-addons-table">
              <thead>
                <tr>
                  <th style="width: 80px;">STATUS</th>
                  <th>ADDON MODULE</th>
                  <th>VERSION</th>
                  <th>AUTHOR</th>
                  <th>DESCRIPTION</th>
                </tr>
              </thead>
              <tbody>
                ${addons.map(a => `
                  <tr>
                    <td>
                      <label class="dl-switch">
                        <input type="checkbox" class="toggle-addon-switch" data-slug="${a.slug}" ${a.isActive ? 'checked' : ''} />
                        <span class="dl-slider"></span>
                      </label>
                    </td>
                    <td>
                      <div style="font-weight: 700; font-size: 0.95rem;">${escapeHtml(a.name)}</div>
                      <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-accent);">/${a.slug}</div>
                    </td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.75rem;">v${escapeHtml(a.version)}</td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">${escapeHtml(a.author)}</td>
                    <td style="font-size: 0.85rem; color: var(--dl-text-muted);">${escapeHtml(a.description)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <!-- Hook & Filter Introspection Table -->
          <div class="dl-card" style="padding: 0; overflow: hidden;">
            <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); display: flex; justify-content: space-between; align-items: center;">
              <div style="font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700;">
                // ACTIVE LIFECYCLE HOOKS & FILTERS (WORDPRESS-COMPATIBLE BUS)
              </div>
              <span class="dl-badge dl-badge-accent">${(hooks.actions || []).length + (hooks.filters || []).length} HOOKS WIRED</span>
            </div>

            <div style="padding: 1.5rem; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
              <div>
                <h4 style="font-size: 1rem; margin-bottom: 1rem; font-family: var(--dl-font-mono); color: var(--dl-accent);">ACTIONS (EVENT BUS)</h4>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  ${(hooks.actions || []).map(act => `
                    <div style="padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.75rem;">
                      <strong style="color: #fff;">${act.hook}</strong>
                      <div style="color: var(--dl-text-muted); font-size: 0.7rem; margin-top: 2px;">
                        Handlers: ${act.handlers.map(h => `${h.addon} (pri: ${h.priority})`).join(', ') || 'none'}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>

              <div>
                <h4 style="font-size: 1rem; margin-bottom: 1rem; font-family: var(--dl-font-mono); color: var(--dl-cyan);">FILTERS (DATA TRANSFORMS)</h4>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  ${(hooks.filters || []).map(flt => `
                    <div style="padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.75rem;">
                      <strong style="color: #fff;">${flt.hook}</strong>
                      <div style="color: var(--dl-text-muted); font-size: 0.7rem; margin-top: 2px;">
                        Handlers: ${flt.handlers.map(h => `${h.addon} (pri: ${h.priority})`).join(', ') || 'none'}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      this.bindAddonEvents(container);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Addons view error: ${err.message}</div></div>`;
    }
  },

  bindAddonEvents(container) {
    // Toggle switch
    container.querySelectorAll('.toggle-addon-switch').forEach(sw => {
      sw.addEventListener('change', async () => {
        const slug = sw.dataset.slug;
        try {
          const res = await API.post(`/api/v1/addons/${slug}/toggle`);
          App.showToast(res.message);
          this.render(container);
        } catch (e) {
          alert('Toggle failed: ' + e.message);
          sw.checked = !sw.checked;
        }
      });
    });

    // Upload Addon Zip
    const fileInput = container.querySelector('#addon-zip-input');
    const uploadBtn = container.querySelector('#btn-upload-addon');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.innerText = 'INSTALLING ZIP...';
      try {
        await API.uploadFile(file, '/api/v1/addons/upload-zip', 'addon_zip');
        App.showToast('Addon package extracted & activated into runtime.');
        this.render(container);
      } catch (err) {
        alert('Addon install failed: ' + err.message);
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = '+ UPLOAD ADDON (.ZIP)';
      }
    });
  }
};
