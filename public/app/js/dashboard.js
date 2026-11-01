/**
 * DEADLETTERS ADMIN DASHBOARD & TELEMETRY HUD
 */

const DashboardView = {
  async render(container) {
    try {
      const [telemetry, postsRes, resharesRes] = await Promise.all([
        API.get('/api/v1/settings/telemetry'),
        API.get('/api/v1/posts?type=all&status=all&limit=8'),
        API.get('/api/v1/reshares/stream?limit=5')
      ]);

      const stats = telemetry.stats || {};
      const posts = postsRes.posts || [];
      const reshares = resharesRes.reshares || [];

      container.innerHTML = `
        <div class="dl-admin-content">
          <!-- Top Telemetry HUD -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // DEADPLUG.DIGITAL // OPERATOR TERMINAL
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">COMMAND & TELEMETRY HUD</h2>
            </div>
            <div style="display: flex; gap: 0.75rem;">
              <a href="#/admin/editor" class="dl-btn dl-btn-accent">+ NEW DROP</a>
              <a href="#/admin/reshares" class="dl-btn dl-btn-outline">↻ RE-LETTER HUB</a>
              <button id="btn-quick-export" class="dl-btn dl-btn-ghost">📦 PACKAGE ZIP</button>
            </div>
          </div>

          <!-- Metrics HUD Grid -->
          <div class="dl-metrics-grid">
            <div class="dl-metric-card">
              <div class="dl-metric-label">TOTAL DROPS (POSTS)</div>
              <div class="dl-metric-val">${stats.posts || 0}</div>
              <div class="dl-metric-meta">
                <span class="dl-badge dl-badge-accent">PUBLISHED</span>
                <span>${stats.pages || 0} STATIC PAGES</span>
              </div>
            </div>

            <div class="dl-metric-card">
              <div class="dl-metric-label">RE-LETTERS (RESHARES)</div>
              <div class="dl-metric-val">${stats.reshares || 0}</div>
              <div class="dl-metric-meta">
                <span class="dl-badge dl-badge-cyan">MESH ACTIVE</span>
                <span>SIGNATURES VERIFIED</span>
              </div>
            </div>

            <div class="dl-metric-card">
              <div class="dl-metric-label">DISCUSSIONS & COMMENTS</div>
              <div class="dl-metric-val">${stats.comments || 0}</div>
              <div class="dl-metric-meta">
                <span>COMMUNITY TRANSMISSIONS</span>
              </div>
            </div>

            <div class="dl-metric-card">
              <div class="dl-metric-label">SQLITE DB SIZE</div>
              <div class="dl-metric-val">${telemetry.databaseSizeFormatted || '12.0 KB'}</div>
              <div class="dl-metric-meta">
                <span>MEM: ${telemetry.memoryUsageMB}MB // UP: ${Math.round(telemetry.uptimeSeconds / 60)}M</span>
              </div>
            </div>
          </div>

          <!-- Two-Column Control Stream -->
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 2rem;">
            <!-- Left: Recent Letters Table -->
            <div class="dl-card" style="padding: 0; overflow: hidden;">
              <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); display: flex; justify-content: space-between; align-items: center;">
                <div style="font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                  RECENT ATELIER TRANSMISSIONS
                </div>
                <a href="#/admin/editor" class="dl-btn dl-btn-outline dl-btn-sm">+ DROP NEW LETTER</a>
              </div>

              <table class="dl-addons-table" style="border: none;">
                <thead>
                  <tr>
                    <th>LETTER TITLE / CODE</th>
                    <th>FORMAT</th>
                    <th>STATUS</th>
                    <th>DATE</th>
                    <th style="text-align: right;">ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  ${posts.map(p => `
                    <tr>
                      <td>
                        <div style="font-weight: 600; font-size: 0.92rem;">
                          <a href="#/letter/${p.post_name}" target="_blank">${escapeHtml(p.post_title)}</a>
                        </div>
                        <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-accent);">
                          ${p.drop_code || 'DL-STANDALONE'}
                        </div>
                      </td>
                      <td>
                        <span class="dl-badge">${escapeHtml(p.content_format || 'standard')}</span>
                      </td>
                      <td>
                        <span class="dl-badge ${p.post_status === 'publish' ? 'dl-badge-accent' : ''}">${p.post_status.toUpperCase()}</span>
                      </td>
                      <td style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
                        ${new Date(p.post_date).toLocaleDateString()}
                      </td>
                      <td style="text-align: right;">
                        <a href="#/admin/editor/${p.ID}" class="dl-btn dl-btn-ghost dl-btn-sm">EDIT</a>
                        <button class="dl-btn dl-btn-danger dl-btn-sm btn-delete-post" data-id="${p.ID}">PURGE</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- Right: Reshare & Mesh Stream -->
            <div style="display: flex; flex-direction: column; gap: 1.5rem;">
              <!-- Node Diagnostics Box -->
              <div class="dl-card">
                <div class="dl-box-title">// ACTIVE NODE STATUS</div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.78rem; display: flex; flex-direction: column; gap: 0.6rem;">
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">ENGINE:</span>
                    <span>DEADLETTERS v1.0</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">ATELIER:</span>
                    <span style="color: var(--dl-accent);">deadplug.digital</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">NODE HOST:</span>
                    <span>${telemetry.node}</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">OPERATOR:</span>
                    <span>${telemetry.operator}</span>
                  </div>
                  <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--dl-text-muted);">LICENSE TIER:</span>
                    <span style="color: var(--dl-emerald);">${telemetry.license ? telemetry.license.tier : 'ENTERPRISE ATELIER'}</span>
                  </div>
                </div>
              </div>

              <!-- Recent Reshares Stream Box -->
              <div class="dl-card">
                <div class="dl-box-title" style="display: flex; justify-content: space-between;">
                  <span>// RECENT RE-LETTERS</span>
                  <a href="#/admin/reshares" style="color: var(--dl-accent); font-size: 0.7rem;">VIEW ALL →</a>
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  ${reshares.slice(0, 3).map(r => `
                    <div style="padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-size: 0.85rem;">
                      <div style="font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(r.original_title)}</div>
                      <div style="font-size: 0.78rem; color: var(--dl-text-muted); margin-bottom: 0.5rem;">
                        "${escapeHtml((r.curator_commentary || '').substring(0, 80))}..."
                      </div>
                      <div style="font-family: var(--dl-font-mono); font-size: 0.68rem; color: var(--dl-accent); display: flex; justify-content: space-between;">
                        <span>BY: ${escapeHtml(r.curator_name || 'Operator')}</span>
                        <span>SIG: ${r.signature ? r.signature.substring(0, 8) : 'VERIFIED'}</span>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      // Bind Delete Buttons
      const deleteBtns = container.querySelectorAll('.btn-delete-post');
      deleteBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Permanently purge this letter from the atelier node?')) {
            try {
              await API.del(`/api/v1/posts/${btn.dataset.id}`);
              App.showToast('Letter purged.');
              this.render(container);
            } catch (e) {
              alert(e.message);
            }
          }
        });
      });

      // Quick export button
      const exportBtn = container.querySelector('#btn-quick-export');
      if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
          exportBtn.disabled = true;
          exportBtn.innerHTML = '📦 PACKING ZIP...';
          try {
            const res = await API.post('/api/v1/settings/export-engine-zip');
            App.showToast(`Distributable compiled: ${res.filename}`);
            window.location.href = res.downloadUrl;
          } catch (e) {
            alert('Export failed: ' + e.message);
          } finally {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '📦 PACKAGE ZIP';
          }
        });
      }

    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Dashboard error: ${err.message}</div></div>`;
    }
  }
};
