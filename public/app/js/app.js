/**
 * DEADLETTERS CLIENT MASTER APPLICATION & ROUTER
 * Orchestrates views, state, modals, command palette, and design tokens
 */

const App = {
  currentUser: null,

  async init() {
    window.addEventListener('hashchange', () => this.handleRoute());
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openCommandPalette();
      }
    });

    // Check installation status
    try {
      const status = await API.get('/api/v1/installer/status');
      if (!status.isInstalled) {
        window.location.hash = '#/installer';
        return this.handleRoute();
      }
    } catch {}

    // Check operator auth
    if (API.token) {
      try {
        const me = await API.get('/api/v1/auth/me');
        this.currentUser = me.user;
      } catch {
        API.setToken(null);
      }
    }

    // Load active theme design tokens
    try {
      const themeData = await API.get('/api/v1/themes/active');
      if (themeData && themeData.activeTheme) {
        document.documentElement.setAttribute('data-theme', themeData.activeTheme.slug);
        this.applyThemeTokens(themeData.activeTheme.slug, themeData.activeTheme.tokens, themeData.activeTheme.customCss);
      }
    } catch {}

    this.handleRoute();
  },

  async handleRoute() {
    const hash = window.location.hash || '#/';
    const root = document.getElementById('app');

    // Routing table
    if (hash === '#/installer') {
      return InstallerWizard.render(root);
    }

    if (hash === '#/' || hash === '') {
      return BlogReader.render(root);
    }

    if (hash === '#/reshares') {
      BlogReader.currentFilter = 'reshare';
      return BlogReader.render(root);
    }

    if (hash.startsWith('#/letter/')) {
      const slug = hash.replace('#/letter/', '');
      return BlogReader.render(root, slug);
    }

    if (hash.startsWith('#/page/')) {
      const slug = hash.replace('#/page/', '');
      return BlogReader.render(root, slug);
    }

    // Admin routes require auth check
    if (hash.startsWith('#/admin')) {
      if (!API.token || !this.currentUser) {
        return this.renderLoginView(root);
      }
      return this.renderAdminLayout(root, hash);
    }

    // Fallback
    BlogReader.render(root);
  },

  renderLoginView(container) {
    container.innerHTML = `
      <div class="dl-installer-wrap">
        <div class="dl-installer-card" style="max-width: 440px;">
          <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.5rem;">
            // OPERATOR CLEARANCE REQUIRED //
          </div>
          <h2 style="font-size: 1.6rem; margin-bottom: 0.5rem;">Atelier Control Access</h2>
          <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.5rem;">Authenticate with your node master key or operator credentials.</p>

          <form id="admin-login-form">
            <div class="dl-form-group">
              <label class="dl-label">Operator Handle / Email</label>
              <input id="login-handle" class="dl-input" type="text" placeholder="clown" required />
            </div>
            <div class="dl-form-group">
              <label class="dl-label">Master Secret Key</label>
              <input id="login-password" class="dl-input" type="password" placeholder="••••••••••••" required />
            </div>
            <button type="submit" class="dl-btn dl-btn-accent" style="width: 100%; margin-top: 1rem;">
              ⚡ AUTHENTICATE OPERATOR
            </button>
            <div style="text-align: center; margin-top: 1.5rem;">
              <a href="#/" style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">← Return to Public Transmissions</a>
            </div>
          </form>
        </div>
      </div>
    `;

    container.querySelector('#admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const login = container.querySelector('#login-handle').value.trim();
      const password = container.querySelector('#login-password').value;

      try {
        const res = await API.post('/api/v1/auth/login', { login, password });
        API.setToken(res.token);
        this.currentUser = res.user;
        this.showToast(`Welcome back, ${res.user.displayName}`);
        this.handleRoute();
      } catch (err) {
        alert('Authentication failed: ' + err.message);
      }
    });
  },

  renderAdminLayout(container, activeHash) {
    container.innerHTML = `
      <div class="dl-admin-layout">
        <!-- Sidebar Navigation -->
        <aside class="dl-admin-sidebar">
          <div class="dl-sidebar-header">
            <div class="dl-sidebar-brand">
              DEADLETTERS
              <span class="dl-sidebar-version">v1.0</span>
            </div>
            <a href="#/" target="_blank" title="View Public Atelier" style="color: var(--dl-accent); font-size: 0.85rem;">↗</a>
          </div>

          <nav class="dl-sidebar-nav">
            <div class="dl-nav-category">CORE ENGINE</div>
            <a href="#/admin" class="dl-sidebar-item ${activeHash === '#/admin' ? 'active' : ''}">
              <span>⚡</span> Overview / HUD
            </a>
            <a href="#/admin/editor" class="dl-sidebar-item ${activeHash.startsWith('#/admin/editor') ? 'active' : ''}">
              <span>✍</span> Editor Studio
            </a>
            <a href="#/admin/pages" class="dl-sidebar-item ${activeHash.startsWith('#/admin/pages') ? 'active' : ''}">
              <span>📄</span> Pages & Archives
            </a>
            <a href="#/admin/reshares" class="dl-sidebar-item ${activeHash === '#/admin/reshares' ? 'active' : ''}">
              <span>↻</span> Reshare & Mesh Hub
            </a>
            <a href="#/admin/media" class="dl-sidebar-item ${activeHash === '#/admin/media' ? 'active' : ''}">
              <span>▤</span> Media Vault
            </a>

            <div class="dl-nav-category">DESIGN & ATELIER</div>
            <a href="#/admin/themes" class="dl-sidebar-item ${activeHash === '#/admin/themes' ? 'active' : ''}">
              <span>🎨</span> Theme Studio
            </a>
            <a href="#/admin/addons" class="dl-sidebar-item ${activeHash === '#/admin/addons' ? 'active' : ''}">
              <span>🧩</span> Addons & Plugins
            </a>

            <div class="dl-nav-category">GOVERNANCE</div>
            <a href="#/admin/users" class="dl-sidebar-item ${activeHash === '#/admin/users' ? 'active' : ''}">
              <span>👥</span> Operators & Access
            </a>
            <a href="#/admin/settings" class="dl-sidebar-item ${activeHash === '#/admin/settings' ? 'active' : ''}">
              <span>⚙</span> Site & Distro Packager
            </a>
          </nav>

          <div class="dl-sidebar-footer">
            <div class="dl-operator-pill">
              <img src="${this.currentUser?.avatarUrl || '/uploads/deadplug_operator_avatar.jpg'}" />
              <div class="dl-operator-details">
                <span class="dl-operator-name">${escapeHtml(this.currentUser?.displayName || 'Operator')}</span>
                <span class="dl-operator-role">${escapeHtml(this.currentUser?.role || 'SUPERADMIN')}</span>
              </div>
            </div>
            <button id="btn-logout" class="dl-btn dl-btn-ghost dl-btn-sm" title="Terminate Session" style="padding: 4px;">✕</button>
          </div>
        </aside>

        <!-- Main Body -->
        <main class="dl-admin-main">
          <header class="dl-admin-topbar">
            <div class="dl-topbar-left">
              <div class="dl-page-title">DEADPLUG ATELIER // DEADLETTERS CONTROL</div>
            </div>
            <div class="dl-topbar-right">
              <button id="btn-cmd-palette" class="dl-btn dl-btn-outline dl-btn-sm" style="font-family: var(--dl-font-mono);">
                CTRL+K PALETTE
              </button>
              <a href="#/" class="dl-btn dl-btn-ghost dl-btn-sm" target="_blank">
                VIEW PUBLIC READER ↗
              </a>
            </div>
          </header>

          <div id="admin-view-target"></div>
        </main>
      </div>
    `;

    // Logout handler
    container.querySelector('#btn-logout').addEventListener('click', async () => {
      await API.post('/api/v1/auth/logout');
      API.setToken(null);
      this.currentUser = null;
      this.showToast('Session terminated.');
      window.location.hash = '#/';
    });

    container.querySelector('#btn-cmd-palette').addEventListener('click', () => {
      this.openCommandPalette();
    });

    // Mount subviews
    const target = container.querySelector('#admin-view-target');

    if (activeHash === '#/admin') {
      DashboardView.render(target);
    } else if (activeHash.startsWith('#/admin/editor')) {
      const parts = activeHash.split('/');
      const editId = parts.length > 3 ? parts[3] : null;
      EditorStudio.render(target, editId);
    } else if (activeHash.startsWith('#/admin/pages')) {
      PagesView.render(target);
    } else if (activeHash === '#/admin/reshares') {
      ReshareHub.render(target);
    } else if (activeHash === '#/admin/media') {
      MediaVault.render(target);
    } else if (activeHash === '#/admin/themes') {
      ThemeStudio.render(target);
    } else if (activeHash === '#/admin/addons') {
      AddonsView.render(target);
    } else if (activeHash === '#/admin/users') {
      UsersView.render(target);
    } else if (activeHash === '#/admin/settings') {
      SettingsView.render(target);
    } else {
      DashboardView.render(target);
    }
  },

  applyThemeTokens(themeSlug, tokens = {}, customCss = '') {
    if (tokens.accent_color) {
      document.documentElement.style.setProperty('--dl-accent', tokens.accent_color);
      document.documentElement.style.setProperty('--dl-accent-glow', `${tokens.accent_color}33`);
    }
    if (tokens.border_radius) {
      document.documentElement.style.setProperty('--dl-radius', tokens.border_radius);
    }
    if (tokens.font_heading) {
      document.documentElement.style.setProperty('--dl-font-heading', tokens.font_heading);
    }

    // Dynamic style tag for custom CSS
    let customStyleTag = document.getElementById('dl-custom-theme-css');
    if (!customStyleTag) {
      customStyleTag = document.createElement('style');
      customStyleTag.id = 'dl-custom-theme-css';
      document.head.appendChild(customStyleTag);
    }
    customStyleTag.innerHTML = customCss || '';
  },

  showToast(message, type = 'accent') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'dl-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'dl-toast';
    toast.innerHTML = `
      <span style="color: var(--dl-accent);">//</span>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  openModal(html) {
    this.closeModal();
    const modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'active-modal-backdrop';
    modalBackdrop.className = 'dl-modal-backdrop';
    modalBackdrop.innerHTML = `<div class="dl-modal">${html}</div>`;
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) this.closeModal();
    });
    document.body.appendChild(modalBackdrop);
  },

  closeModal() {
    const existing = document.getElementById('active-modal-backdrop');
    if (existing) existing.remove();
  },

  openReshareModal({ sourcePostId, title, author, excerpt }) {
    this.openModal(`
      <div class="dl-modal-header">
        <h3 style="font-size: 1.25rem;">RE-LETTER THIS TRANSMISSION</h3>
        <button class="dl-modal-close" onclick="App.closeModal()">✕</button>
      </div>
      <div style="margin-bottom: 1rem;">
        <div class="dl-quoted-envelope" style="margin-bottom: 1.25rem;">
          <div class="dl-quoted-source-header">
            <span>ORIGINAL DROP</span>
            <span>by ${escapeHtml(author)}</span>
          </div>
          <div class="dl-quoted-title">${escapeHtml(title)}</div>
          <div class="dl-quoted-excerpt">${escapeHtml(excerpt)}</div>
        </div>

        <div class="dl-form-group">
          <label class="dl-label">Your Curator Commentary</label>
          <textarea id="modal-reshare-comment" class="dl-textarea" placeholder="Add your perspective or critique for the mesh feed..."></textarea>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
          <button class="dl-btn dl-btn-outline dl-btn-sm" onclick="App.closeModal()">CANCEL</button>
          <button id="btn-modal-broadcast" class="dl-btn dl-btn-accent dl-btn-sm">⚡ SIGN & RE-LETTER</button>
        </div>
      </div>
    `);

    document.getElementById('btn-modal-broadcast').addEventListener('click', async () => {
      const commentary = document.getElementById('modal-reshare-comment').value.trim();
      if (!commentary) {
        alert('Curator commentary cannot be empty.');
        return;
      }
      try {
        await API.post('/api/v1/reshares', {
          sourcePostId: parseInt(sourcePostId, 10),
          curatorCommentary: commentary
        });
        App.closeModal();
        App.showToast('Re-letter broadcasted to frequency.');
      } catch (err) {
        alert('Reshare failed: ' + err.message);
      }
    });
  },

  openCommandPalette() {
    this.openModal(`
      <div style="font-family: var(--dl-font-mono);">
        <input id="cmd-input" type="text" placeholder="Type a command or jump to view..." class="dl-input" style="font-size: 1.1rem; padding: 1rem; border-color: var(--dl-accent);" autofocus />
        <div id="cmd-list" style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.4rem;">
          <div class="cmd-item" data-hash="#/admin/editor" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">✍ New Post (Editor Studio)</div>
          <div class="cmd-item" data-hash="#/admin/reshares" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">↻ Reshare & Mesh Hub</div>
          <div class="cmd-item" data-hash="#/admin/themes" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">🎨 Theme Studio & Customizer</div>
          <div class="cmd-item" data-hash="#/admin/addons" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">🧩 Addons & Hooks</div>
          <div class="cmd-item" data-hash="#/admin/media" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">▤ Media Vault</div>
          <div class="cmd-item" data-hash="#/admin/settings" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">📦 Package Engine Distributable Zip</div>
          <div class="cmd-item" data-hash="#/" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">↗ View Public Editorial Reader</div>
        </div>
      </div>
    `);

    const input = document.getElementById('cmd-input');
    const items = document.querySelectorAll('.cmd-item');
    input.focus();

    items.forEach(item => {
      item.addEventListener('click', () => {
        App.closeModal();
        window.location.hash = item.dataset.hash;
      });
    });

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      items.forEach(i => {
        i.style.display = i.innerText.toLowerCase().includes(q) ? 'block' : 'none';
      });
    });
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
