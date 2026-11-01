/**
 * DEADLETTERS STATIC PAGES MANAGER
 * WordPress Pages parity with hierarchical ordering
 */

const PagesView = {
  async render(container) {
    try {
      const res = await API.get('/api/v1/posts?type=page&status=all');
      const pages = res.posts || [];

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // STATIC HIERARCHICAL CONTENT //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">PAGES & ARCHIVES</h2>
            </div>
            <button id="btn-create-page" class="dl-btn dl-btn-accent">+ NEW PAGE</button>
          </div>

          <div class="dl-card" style="padding: 0; overflow: hidden;">
            <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700;">
              PUBLISHED & DRAFT PAGES // ${pages.length} ENTRIES
            </div>

            <table class="dl-addons-table">
              <thead>
                <tr>
                  <th>PAGE TITLE</th>
                  <th>SLUG / PERMALINK</th>
                  <th>STATUS</th>
                  <th>LAST MODIFIED</th>
                  <th style="text-align: right;">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                ${pages.length === 0 ? `
                  <tr>
                    <td colspan="5" style="text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono); padding: 2.5rem;">
                      // NO STATIC PAGES CREATED YET // CLICK '+ NEW PAGE' TO ADD ONE //
                    </td>
                  </tr>
                ` : pages.map(p => `
                  <tr>
                    <td>
                      <div style="font-weight: 700; font-size: 0.95rem;">
                        <a href="#/page/${p.post_name}" target="_blank">${escapeHtml(p.post_title)}</a>
                      </div>
                    </td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.78rem; color: var(--dl-cyan);">/page/${escapeHtml(p.post_name)}</td>
                    <td>
                      <span class="dl-badge ${p.post_status === 'publish' ? 'dl-badge-accent' : ''}">${p.post_status.toUpperCase()}</span>
                    </td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
                      ${new Date(p.post_modified || p.post_date).toLocaleDateString()}
                    </td>
                    <td style="text-align: right;">
                      <a href="#/page/${p.post_name}" target="_blank" class="dl-btn dl-btn-ghost dl-btn-sm">VIEW ↗</a>
                      <a href="#/admin/editor/${p.ID}" class="dl-btn dl-btn-ghost dl-btn-sm">EDIT</a>
                      <button class="dl-btn dl-btn-danger dl-btn-sm btn-delete-page" data-id="${p.ID}">PURGE</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // New Page Button
      container.querySelector('#btn-create-page').addEventListener('click', () => {
        App.openModal(`
          <div class="dl-modal-header">
            <h3 style="font-size: 1.25rem;">NEW STATIC PAGE</h3>
            <button class="dl-modal-close" onclick="App.closeModal()">✕</button>
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Page Title</label>
            <input id="modal-page-title" class="dl-input" type="text" placeholder="e.g. About the Atelier" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Custom Slug</label>
            <input id="modal-page-slug" class="dl-input" type="text" placeholder="e.g. about" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Initial Page Content (Markdown)</label>
            <textarea id="modal-page-content" class="dl-textarea" style="min-height: 140px;" placeholder="Compose initial page manifesto or information..."></textarea>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
            <button class="dl-btn dl-btn-outline dl-btn-sm" onclick="App.closeModal()">CANCEL</button>
            <button id="btn-modal-save-page" class="dl-btn dl-btn-accent dl-btn-sm">⚡ CREATE & PUBLISH PAGE</button>
          </div>
        `);

        document.getElementById('btn-modal-save-page').addEventListener('click', async () => {
          const title = document.getElementById('modal-page-title').value.trim();
          const slug = document.getElementById('modal-page-slug').value.trim();
          const content = document.getElementById('modal-page-content').value.trim();

          if (!title) return alert('Page title required.');

          try {
            await API.post('/api/v1/posts', {
              title,
              slug,
              content,
              type: 'page',
              status: 'publish'
            });
            App.closeModal();
            App.showToast('Page published.');
            this.render(container);
          } catch (e) {
            alert('Failed to create page: ' + e.message);
          }
        });
      });

      // Delete Page
      container.querySelectorAll('.btn-delete-page').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Permanently purge this page?')) {
            try {
              await API.del(`/api/v1/posts/${btn.dataset.id}`);
              App.showToast('Page purged.');
              this.render(container);
            } catch (e) {
              alert(e.message);
            }
          }
        });
      });

    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Pages error: ${err.message}</div></div>`;
    }
  }
};
