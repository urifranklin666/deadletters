/**
 * DEADLETTERS OPERATORS & USER ACCESS MATRIX
 * WordPress Users management parity with RBAC roles
 */

const UsersView = {
  async render(container) {
    try {
      const res = await API.get('/api/v1/auth/users');
      const users = res.users || [];

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // ACCESS & PERMISSION MATRIX //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">OPERATORS & USERS</h2>
            </div>
            <button id="btn-create-user" class="dl-btn dl-btn-accent">+ ENROLL OPERATOR</button>
          </div>

          <div class="dl-card" style="padding: 0; overflow: hidden;">
            <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.78rem; font-weight: 700;">
              COMMISSIONED NODE OPERATORS // ${users.length} CREDENTIALS
            </div>

            <table class="dl-addons-table">
              <thead>
                <tr>
                  <th>OPERATOR</th>
                  <th>LOGIN HANDLE</th>
                  <th>EMAIL FREQUENCY</th>
                  <th>ROLE CLEARANCE</th>
                  <th>COMMISSIONED</th>
                  <th style="text-align: right;">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(u => `
                  <tr>
                    <td>
                      <div style="display: flex; align-items: center; gap: 10px;">
                        <img src="${escapeHtml(safeUrl(u.avatar_url, '/uploads/deadplug_operator_avatar.jpg'))}" style="width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dl-border-strong);" />
                        <div>
                          <div style="font-weight: 700; font-size: 0.92rem;">${escapeHtml(u.display_name)}</div>
                          <div style="font-size: 0.72rem; color: var(--dl-text-muted);">${escapeHtml(u.bio || '')}</div>
                        </div>
                      </div>
                    </td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.78rem; color: var(--dl-accent);">@${escapeHtml(u.user_login)}</td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.78rem; color: var(--dl-text-muted);">${escapeHtml(u.user_email)}</td>
                    <td>
                      <span class="dl-badge ${u.role === 'superadmin' ? 'dl-badge-accent' : (u.role === 'art_director' ? 'dl-badge-cyan' : '')}">
                        ${escapeHtml(String(u.role || '').toUpperCase())}
                      </span>
                    </td>
                    <td style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
                      ${escapeHtml(new Date(u.user_registered).toLocaleDateString())}
                    </td>
                    <td style="text-align: right;">
                      ${u.ID !== App.currentUser?.id ? `
                        <button class="dl-btn dl-btn-danger dl-btn-sm btn-delete-user" data-id="${escapeHtml(u.ID)}">DECOMMISSION</button>
                      ` : `
                        <span style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">YOU</span>
                      `}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Enroll Operator Modal
      container.querySelector('#btn-create-user').addEventListener('click', () => {
        App.openModal(`
          <div class="dl-modal-header">
            <h3 style="font-size: 1.25rem;">ENROLL NEW NODE OPERATOR</h3>
            <button class="dl-modal-close" type="button" data-close-modal>✕</button>
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Operator Handle (Login)</label>
            <input id="modal-user-login" class="dl-input" type="text" placeholder="e.g. raven" required />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Display Name / Title</label>
            <input id="modal-user-display" class="dl-input" type="text" placeholder="e.g. Operator Raven // Senior Stylist" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Email Address</label>
            <input id="modal-user-email" class="dl-input" type="email" placeholder="raven@deadplug.digital" required />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Role Clearance</label>
            <select id="modal-user-role" class="dl-select">
              <option value="art_director">Art Director (Editor - Full Publication Rights)</option>
              <option value="author" selected>Author (Writer - Publish Own Drops)</option>
              <option value="operator">Operator (Subscriber - Comment & Reshare)</option>
              <option value="superadmin">Superadmin (Master Clearance)</option>
            </select>
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Secret Password (Min 12 chars)</label>
            <input id="modal-user-pass" class="dl-input" type="password" placeholder="••••••••••••" required />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem;">
            <button class="dl-btn dl-btn-outline dl-btn-sm" type="button" data-close-modal>CANCEL</button>
            <button id="btn-modal-enroll" class="dl-btn dl-btn-accent dl-btn-sm">⚡ COMMISSION OPERATOR</button>
          </div>
        `);

        document.getElementById('btn-modal-enroll').addEventListener('click', async () => {
          const login = document.getElementById('modal-user-login').value.trim();
          const displayName = document.getElementById('modal-user-display').value.trim();
          const email = document.getElementById('modal-user-email').value.trim();
          const role = document.getElementById('modal-user-role').value;
          const password = document.getElementById('modal-user-pass').value;

          if (!login || !email || !password || password.length < 12) {
            return alert('All fields required. Password must be at least 12 characters.');
          }

          try {
            await API.post('/api/v1/auth/users', {
              login,
              displayName,
              email,
              role,
              password
            });
            App.closeModal();
            App.showToast(`Operator @${login} commissioned.`);
            this.render(container);
          } catch (e) {
            alert('Failed: ' + e.message);
          }
        });
      });

      // Decommission User
      container.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Decommission this operator? Their access keys will be terminated.')) {
            try {
              await API.del(`/api/v1/auth/users/${encodeURIComponent(btn.dataset.id)}`);
              App.showToast('Operator decommissioned.');
              this.render(container);
            } catch (e) {
              alert(e.message);
            }
          }
        });
      });

    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Users error: ${escapeHtml(err.message)}</div></div>`;
    }
  }
};
