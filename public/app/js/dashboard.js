/**
 * DEADLETTERS ADMIN DASHBOARD & TELEMETRY HUD
 */

const DashboardView = {
  async render(container) {
    const canTelemetry = App.can('settings:telemetry');
    const canCreate = App.can('posts:create');
    const canEdit = App.can('posts:edit');
    const canDelete = App.can('posts:delete');
    const canReshare = App.can('reshares:create');
    const canExport = App.can('settings:export');
    const roleLabel = App.role() || 'unknown';

    try {
      const requests = [
        API.get('/api/v1/posts?type=all&status=all&limit=8'),
        API.get('/api/v1/reshares/stream?limit=5')
      ];
      if (canTelemetry) {
        requests.push(API.get('/api/v1/settings/telemetry'));
      }

      const results = await Promise.all(requests);
      const postsRes = results[0];
      const resharesRes = results[1];
      const telemetry = canTelemetry ? results[2] : null;

      const stats = telemetry?.stats || {};
      const posts = postsRes.posts || [];
      const reshares = resharesRes.reshares || [];

      const postActions = post => {
        const actions = [];
        if (canEdit && App.canManagePost(post)) {
          actions.push(`<a href="#/admin/editor/${escapeHtml(encodeURIComponent(post.ID))}" class="dl-btn dl-btn-ghost dl-btn-sm">EDIT</a>`);
        }
        if (canDelete && App.canManagePost(post)) {
          actions.push(`<button class="dl-btn dl-btn-danger dl-btn-sm btn-delete-post" data-id="${escapeHtml(post.ID)}">PURGE</button>`);
        }
        return actions.length ? actions.join('') : '<span style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-text-muted);">READ ONLY</span>';
      };

      const superadminMetrics = `
        <div class="dl-metrics-grid">
          <div class="dl-metric-card">
            <div class="dl-metric-label">TOTAL DROPS (POSTS)</div>
            <div class="dl-metric-val">${escapeHtml(stats.posts || 0)}</div>
            <div class="dl-metric-meta">
              <span class="dl-badge dl-badge-accent">PUBLISHED</span>
              <span>${escapeHtml(stats.pages || 0)} STATIC PAGES</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">RE-LETTERS (RESHARES)</div>
            <div class="dl-metric-val">${escapeHtml(stats.reshares || 0)}</div>
            <div class="dl-metric-meta">
              <span class="dl-badge dl-badge-cyan">LOCAL NODE</span>
              <span>SIGNATURES STORED LOCALLY</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">DISCUSSIONS & COMMENTS</div>
            <div class="dl-metric-val">${escapeHtml(stats.comments || 0)}</div>
            <div class="dl-metric-meta">
              <span>COMMUNITY TRANSMISSIONS</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">SQLITE DB SIZE</div>
            <div class="dl-metric-val">${escapeHtml(telemetry?.databaseSizeFormatted || '0 KB')}</div>
            <div class="dl-metric-meta">
              <span>MEM: ${escapeHtml(telemetry?.memoryUsageMB ?? 0)}MB // UP: ${escapeHtml(Math.round((telemetry?.uptimeSeconds || 0) / 60))}M</span>
            </div>
          </div>
        </div>
      `;

      const limitedMetrics = `
        <div class="dl-metrics-grid">
          <div class="dl-metric-card">
            <div class="dl-metric-label">RECENT LETTERS</div>
            <div class="dl-metric-val">${escapeHtml(posts.length)}</div>
            <div class="dl-metric-meta">
              <span class="dl-badge dl-badge-accent">EDITORIAL</span>
              <span>LATEST RECORDS ONLY</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">RECENT RE-LETTERS</div>
            <div class="dl-metric-val">${escapeHtml(reshares.length)}</div>
            <div class="dl-metric-meta">
              <span class="dl-badge dl-badge-cyan">LOCAL STREAM</span>
              <span>SIG RECORDS NOT CROSS-VERIFIED</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">ROLE CLEARANCE</div>
            <div class="dl-metric-val" style="font-size: 1.1rem; word-break: break-word;">${escapeHtml(roleLabel.toUpperCase())}</div>
            <div class="dl-metric-meta">
              <span>BACKEND ENFORCED</span>
            </div>
          </div>

          <div class="dl-metric-card">
            <div class="dl-metric-label">LOCAL NODE</div>
            <div class="dl-metric-val" style="font-size: 1rem; word-break: break-word;">${escapeHtml(window.location.host || 'localhost')}</div>
            <div class="dl-metric-meta">
              <span>TELEMETRY RESTRICTED TO SUPERADMIN</span>
            </div>
          </div>
        </div>
      `;

      const diagnostics = canTelemetry
        ? `
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">ENGINE:</span>
            <span>DEADLETTERS ${escapeHtml(telemetry?.version || 'v1.0')}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">NODE HOST:</span>
            <span>${escapeHtml(telemetry?.node || 'local')}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">OPERATOR:</span>
            <span>${escapeHtml(telemetry?.operator || App.currentUser?.displayName || 'Operator')}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">DATABASE:</span>
            <span>${escapeHtml(telemetry?.databaseSizeFormatted || '0 KB')}</span>
          </div>
        `
        : `
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">ENGINE:</span>
            <span>DEADLETTERS v1.0</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">ROLE:</span>
            <span style="color: var(--dl-accent);">${escapeHtml(roleLabel.toUpperCase())}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">LOCAL HOST:</span>
            <span>${escapeHtml(window.location.host || 'localhost')}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--dl-text-muted);">TELEMETRY:</span>
            <span style="color: var(--dl-text-muted);">SUPERADMIN ONLY</span>
          </div>
        `;

      container.innerHTML = `
        <div class="dl-admin-content">
          <!-- Top HUD -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // DEADPLUG.DIGITAL // ${canTelemetry ? 'OPERATOR TERMINAL' : 'LOCAL EDITORIAL NODE'} // ROLE: ${escapeHtml(roleLabel.toUpperCase())}
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">${canTelemetry ? 'COMMAND & TELEMETRY HUD' : 'EDITORIAL HUD'}</h2>
            </div>
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
              ${canCreate ? '<a href="#/admin/editor" class="dl-btn dl-btn-accent">+ NEW DROP</a>' : ''}
              ${canReshare ? '<a href="#/admin/reshares" class="dl-btn dl-btn-outline">↻ RE-LETTER HUB</a>' : ''}
              ${canExport ? '<button id="btn-quick-export" class="dl-btn dl-btn-ghost">📦 PACKAGE ZIP</button>' : ''}
            </div>
          </div>

          ${canTelemetry ? superadminMetrics : limitedMetrics}

          <!-- Two-Column Control Stream -->
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 2rem;">
            <!-- Left: Recent Letters Table -->
            <div class="dl-card" style="padding: 0; overflow: hidden;">
              <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); display: flex; justify-content: space-between; align-items: center;">
                <div style="font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                  ${canTelemetry ? 'RECENT ATELIER TRANSMISSIONS' : 'RECENT EDITORIAL TRANSMISSIONS'}
                </div>
                ${canCreate ? '<a href="#/admin/editor" class="dl-btn dl-btn-outline dl-btn-sm">+ DROP NEW LETTER</a>' : ''}
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
                  ${posts.length === 0 ? `
                    <tr>
                      <td colspan="5" style="text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono); padding: 2rem;">
                        // NO LETTERS VISIBLE FOR THIS ROLE //
                      </td>
                    </tr>
                  ` : posts.map(p => `
                    <tr>
                      <td>
                        <div style="font-weight: 600; font-size: 0.92rem;">
                          <a href="#/letter/${escapeHtml(encodeURIComponent(p.post_name || ''))}" target="_blank">${escapeHtml(p.post_title)}</a>
                        </div>
                        <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-accent);">
                          ${escapeHtml(p.drop_code || 'DL-STANDALONE')}
                        </div>
                      </td>
                      <td>
                        <span class="dl-badge">${escapeHtml(p.content_format || 'standard')}</span>
                      </td>
                      <td>
                        <span class="dl-badge ${p.post_status === 'publish' ? 'dl-badge-accent' : ''}">${escapeHtml(String(p.post_status || '').toUpperCase())}</span>
                      </td>
                      <td style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
                        ${escapeHtml(new Date(p.post_date).toLocaleDateString())}
                      </td>
                      <td style="text-align: right;">
                        ${postActions(p)}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- Right: Local Node & Reshare Stream -->
            <div style="display: flex; flex-direction: column; gap: 1.5rem;">
              <!-- Node Diagnostics Box -->
              <div class="dl-card">
                <div class="dl-box-title">// LOCAL NODE STATUS</div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.78rem; display: flex; flex-direction: column; gap: 0.6rem;">
                  ${diagnostics}
                </div>
              </div>

              <!-- Recent Reshares Stream Box -->
              <div class="dl-card">
                <div class="dl-box-title" style="display: flex; justify-content: space-between;">
                  <span>// RECENT RE-LETTERS</span>
                  ${canReshare ? '<a href="#/admin/reshares" style="color: var(--dl-accent); font-size: 0.7rem;">VIEW ALL →</a>' : ''}
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                  ${reshares.length === 0 ? `
                    <div style="color: var(--dl-text-muted); font-family: var(--dl-font-mono); font-size: 0.75rem; padding: 0.75rem;">
                      // NO LOCAL RE-LETTER RECORDS //
                    </div>
                  ` : reshares.slice(0, 3).map(r => `
                    <div style="padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-size: 0.85rem;">
                      <div style="font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(r.original_title)}</div>
                      <div style="font-size: 0.78rem; color: var(--dl-text-muted); margin-bottom: 0.5rem;">
                        "${escapeHtml((r.curator_commentary || '').substring(0, 80))}..."
                      </div>
                      <div style="font-family: var(--dl-font-mono); font-size: 0.68rem; color: var(--dl-accent); display: flex; justify-content: space-between;">
                        <span>BY: ${escapeHtml(r.curator_name || 'Operator')}</span>
                        <span>${r.signature ? `LOCAL SIG: ${escapeHtml(String(r.signature).substring(0, 8))}...` : 'SIG: NOT RECORDED'}</span>
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
              await API.del(`/api/v1/posts/${encodeURIComponent(btn.dataset.id)}`);
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
          exportBtn.textContent = '📦 PACKING ZIP...';
          try {
            const res = await API.post('/api/v1/settings/export-engine-zip');
            const downloadUrl = safeUrl(res.downloadUrl);
            if (!downloadUrl) throw new Error('Export returned an invalid download URL.');
            const downloaded = await API.download(downloadUrl, res.filename || 'deadletters-engine.zip');
            App.showToast(`Distributable downloaded: ${downloaded.filename || res.filename}`);
          } catch (e) {
            alert('Export failed: ' + e.message);
          } finally {
            exportBtn.disabled = false;
            exportBtn.textContent = '📦 PACKAGE ZIP';
          }
        });
      }

    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Dashboard error: ${escapeHtml(err.message)}</div></div>`;
    }
  }
};
