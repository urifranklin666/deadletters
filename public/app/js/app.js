/**
 * DEADLETTERS CLIENT MASTER APPLICATION & ROUTER
 * Orchestrates views, state, modals, command palette, and design tokens
 */

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getServerInitialRoute() {
  const routeNode = document.getElementById('dl-initial-route');
  if (!routeNode) return '';
  try {
    const route = JSON.parse(routeNode.textContent || '{}');
    const hash = typeof route.hash === 'string' ? route.hash : '';
    if (['#/', '#/reshares', '#/admin', '#/installer'].includes(hash)) return hash;
    if (/^#\/(letter|page)\/[^/]+$/.test(hash)) return hash;
  } catch {}
  return '';
}

// Frontend-only capability map used to keep the interface honest about what a
// role can attempt. The backend remains the authority for every request.
const ROLE_UI_CAPABILITIES = Object.freeze({
  art_director: Object.freeze([
    'posts:create',
    'posts:edit',
    'posts:revise',
    'posts:trash',
    'posts:restore',
    'posts:delete',
    'posts:manage-all',
    'comments:moderate',
    'media:upload',
    'media:delete',
    'themes:manage',
    'users:list',
    'users:create',
    'taxonomies:manage'
  ]),
  author: Object.freeze([
    'posts:create',
    'posts:edit',
    'posts:revise',
    'posts:trash',
    'posts:restore',
    'posts:delete',
    'media:upload'
  ]),
  operator: Object.freeze([])
});

const SHARED_UI_CAPABILITIES = Object.freeze([
  'reshares:create',
  'profile:edit'
]);

const App = {
  currentUser: null,

  role() {
    return this.currentUser?.role || '';
  },

  isSuperadmin() {
    return this.role() === 'superadmin';
  },

  can(capability) {
    const role = this.role();
    if (!role) return false;
    if (role === 'superadmin') return true;
    if (SHARED_UI_CAPABILITIES.includes(capability)) return true;
    const granted = ROLE_UI_CAPABILITIES[role] || [];
    return granted.includes(capability);
  },

  canManagePost(post) {
    if (!post) return false;
    if (this.isSuperadmin() || this.can('posts:manage-all')) return true;
    if (!this.can('posts:edit')) return false;

    const userId = this.currentUser?.id ?? this.currentUser?.ID;
    const authorId = post.post_author ?? post.author_id ?? post.authorId;
    if (userId === undefined || userId === null) return false;
    if (authorId === undefined || authorId === null) return false;
    return String(userId) === String(authorId);
  },

  canViewDashboard() {
    return this.can('posts:manage-all') || this.can('settings:telemetry');
  },

  getAdminLandingRoute() {
    switch (this.role()) {
      case 'superadmin':
      case 'art_director':
        return '#/admin';
      case 'author':
        return '#/admin/editor';
      case 'operator':
      default:
        return '#/admin/reshares';
    }
  },

  canAccessAdminRoute(hash) {
    if (!this.currentUser) return false;
    if (!hash || hash === '#/admin' || hash === '#/admin/') return true;
    if (hash.startsWith('#/admin/editor')) return this.can('posts:create') || this.can('posts:edit');
    if (hash.startsWith('#/admin/pages')) return this.can('posts:create') || this.can('posts:edit');
    if (hash === '#/admin/reshares') return this.can('reshares:create');
    if (hash === '#/admin/comments') return this.can('comments:moderate');
    if (hash === '#/admin/federation') return this.isSuperadmin();
    if (hash === '#/admin/media') return this.can('media:upload') || this.can('media:delete');
    if (hash === '#/admin/themes') return this.can('themes:manage');
    if (hash === '#/admin/addons') return this.can('addons:manage');
    if (hash === '#/admin/users') return this.can('users:list');
    if (hash === '#/admin/settings') return this.can('settings:manage') || this.can('settings:export');
    return false;
  },

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

    try {
      await this.loadActiveTheme();
    } catch {}

    this.handleRoute();
  },

  async loadActiveTheme() {
    const themeData = await API.get('/api/v1/themes/active');
    if (!themeData || !themeData.activeTheme) return null;

    const active = themeData.activeTheme;
    document.documentElement.setAttribute('data-theme', active.slug || 'deadplug-editorial');
    this.applyThemeTokens(active.slug, active.tokens, active.customCss);

    const stylesheet = document.getElementById('dl-active-theme-stylesheet');
    if (stylesheet) {
      stylesheet.href = `/api/v1/themes/active/style.css?v=${Date.now()}`;
    }
    return active;
  },

  async previewTheme(slug) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(slug || ''))) return null;
    const [themesData, tokenData] = await Promise.all([
      API.get('/api/v1/themes'),
      API.get(`/api/v1/themes/tokens/${encodeURIComponent(slug)}`)
    ]);
    const theme = (themesData.themes || []).find(item => item.slug === slug);
    if (!theme) return null;

    document.documentElement.setAttribute('data-theme', slug);
    this.applyThemeTokens(slug, { ...(theme.defaults || {}), ...(tokenData.tokens || {}) }, tokenData.customCss || '');
    const stylesheet = document.getElementById('dl-active-theme-stylesheet');
    if (stylesheet) {
      stylesheet.href = `/themes/${encodeURIComponent(slug)}/style.css?v=${Date.now()}`;
    }
    return theme;
  },

  async handleRoute() {
    const hash = window.location.hash || getServerInitialRoute() || '#/';
    const root = document.getElementById('app');

    // Routing table
    if (hash === '#/installer') {
      return InstallerWizard.render(root);
    }

    if (hash === '#/' || hash === '') {
      BlogReader.currentFilter = 'all';
      return BlogReader.render(root);
    }

    if (hash === '#/reshares') {
      BlogReader.currentFilter = 'reshare';
      return BlogReader.render(root);
    }

    if (hash.startsWith('#/letter/')) {
      const slug = decodeRouteSegment(hash.replace('#/letter/', ''));
      return BlogReader.render(root, slug);
    }

    if (hash.startsWith('#/page/')) {
      const slug = decodeRouteSegment(hash.replace('#/page/', ''));
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
          <p style="font-size: 0.85rem; color: var(--dl-text-muted); margin-bottom: 1.5rem;">Authenticate with your operator credentials.</p>

          <form id="admin-login-form">
            <div class="dl-form-group">
              <label class="dl-label">Operator Handle / Email</label>
              <input id="login-handle" class="dl-input" type="text" placeholder="clown" required />
            </div>
            <div class="dl-form-group">
              <label class="dl-label">Operator Password</label>
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
    const landingRoute = this.getAdminLandingRoute();
    const requestedHash = (activeHash === '#/admin' || activeHash === '#/admin/') ? landingRoute : activeHash;
    const allowed = this.canAccessAdminRoute(requestedHash);
    const effectiveHash = allowed ? requestedHash : '#/admin';

    const showDashboard = this.canViewDashboard();
    const showEditor = this.can('posts:create') || this.can('posts:edit');
    const showReshares = this.can('reshares:create');
    const showComments = this.can('comments:moderate');
    const showFederation = this.isSuperadmin();
    const showMedia = this.can('media:upload') || this.can('media:delete');
    const showThemes = this.can('themes:manage');
    const showAddons = this.can('addons:manage');
    const showUsers = this.can('users:list');
    const showSettings = this.can('settings:manage') || this.can('settings:export');

    const isActive = (prefix, exact = false) => {
      if (exact) return effectiveHash === prefix;
      return effectiveHash === prefix || effectiveHash.startsWith(`${prefix}/`);
    };
    const navItem = (href, icon, label, active) => `
      <a href="${escapeHtml(href)}" class="dl-sidebar-item ${active ? 'active' : ''}">
        <span>${escapeHtml(icon)}</span> ${escapeHtml(label)}
      </a>
    `;

    const sections = [];
    const editorialItems = [];
    if (showEditor) editorialItems.push(navItem('#/admin/editor', '✍', 'Editor Studio', isActive('#/admin/editor')));
    if (showEditor) editorialItems.push(navItem('#/admin/pages', '📄', 'Pages & Archives', isActive('#/admin/pages')));
    if (showComments) editorialItems.push(navItem('#/admin/comments', '💬', 'Comments & Moderation', isActive('#/admin/comments', true)));
    if (editorialItems.length) sections.push({ label: 'EDITORIAL', items: editorialItems });

    const coreItems = [];
    if (showDashboard) coreItems.push(navItem('#/admin', '⚡', 'Overview / HUD', isActive('#/admin', true)));
    if (showReshares) coreItems.push(navItem('#/admin/reshares', '↻', 'Reshare & Mesh Hub', isActive('#/admin/reshares', true)));
    if (showMedia) coreItems.push(navItem('#/admin/media', '▤', 'Media Vault', isActive('#/admin/media', true)));
    if (coreItems.length) sections.push({ label: 'CORE ENGINE', items: coreItems });

    const designItems = [];
    if (showThemes) designItems.push(navItem('#/admin/themes', '🎨', 'Theme Studio', isActive('#/admin/themes', true)));
    if (showAddons) designItems.push(navItem('#/admin/addons', '🧩', 'Addons & Plugins', isActive('#/admin/addons', true)));
    if (designItems.length) sections.push({ label: 'DESIGN & ATELIER', items: designItems });

    const governanceItems = [];
    if (showUsers) governanceItems.push(navItem('#/admin/users', '👥', 'Operators & Access', isActive('#/admin/users', true)));
    if (showSettings) governanceItems.push(navItem('#/admin/settings', '⚙', 'Site & Engine Packager', isActive('#/admin/settings', true)));
    if (showFederation) governanceItems.push(navItem('#/admin/federation', '🌐', 'Federation & Peers', isActive('#/admin/federation', true)));
    if (governanceItems.length) sections.push({ label: 'GOVERNANCE', items: governanceItems });

    const sidebarNav = sections.map(section => `
      <div class="dl-nav-category">${escapeHtml(section.label)}</div>
      ${section.items.join('')}
    `).join('');

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

          <nav class="dl-sidebar-nav">${sidebarNav}</nav>

          <div class="dl-sidebar-footer">
            <div class="dl-operator-pill">
              <img src="${escapeHtml(safeUrl(this.currentUser?.avatarUrl, '/uploads/deadplug_operator_avatar.jpg'))}" alt="" />
              <div class="dl-operator-details">
                <span class="dl-operator-name">${escapeHtml(this.currentUser?.displayName || 'Operator')}</span>
                <span class="dl-operator-role">${escapeHtml(this.currentUser?.role || 'operator')}</span>
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

    if (!allowed) {
      target.innerHTML = `
        <div class="dl-admin-content">
          <div class="dl-card" style="border-color: var(--dl-crimson);">
            <div class="dl-box-title" style="color: var(--dl-crimson);">// ACCESS DENIED //</div>
            <p style="font-size: 0.9rem; color: var(--dl-text-muted); line-height: 1.6; margin-bottom: 1.25rem;">
              The ${escapeHtml(this.role() || 'unknown')} role cannot open this control surface. The backend enforces the same clearance rules.
            </p>
            <a href="${escapeHtml(landingRoute)}" class="dl-btn dl-btn-accent dl-btn-sm">GO TO YOUR ADMIN HOME</a>
          </div>
        </div>
      `;
      return;
    }

    if (effectiveHash === '#/admin') {
      DashboardView.render(target);
    } else if (effectiveHash.startsWith('#/admin/editor')) {
      const parts = effectiveHash.split('/');
      const editId = parts.length > 3 ? parts[3] : null;
      EditorStudio.render(target, editId);
    } else if (effectiveHash.startsWith('#/admin/pages')) {
      const rendered = PagesView.render(target);
      if (!this.can('posts:manage-all') && rendered && typeof rendered.then === 'function') {
        rendered.then(async () => {
          try {
            const res = await API.get('/api/v1/posts?type=page&status=all');
            const ownership = new Map((res.posts || []).map(page => [String(page.ID), page.post_author]));
            const currentUserId = String(this.currentUser?.id ?? this.currentUser?.ID ?? '');

            target.querySelectorAll('.btn-delete-page').forEach(button => {
              if (ownership.get(String(button.dataset.id)) !== currentUserId) button.remove();
            });
            target.querySelectorAll('a[href^="#/admin/editor/"]').forEach(link => {
              const id = decodeRouteSegment(link.getAttribute('href').replace('#/admin/editor/', ''));
              if (ownership.get(String(id)) !== currentUserId) link.remove();
            });
          } catch {}
        }).catch(() => {});
      }
    } else if (effectiveHash === '#/admin/reshares') {
      ReshareHub.render(target);
    } else if (effectiveHash === '#/admin/comments') {
      CommentsView.render(target);
    } else if (effectiveHash === '#/admin/federation') {
      FederationView.render(target);
    } else if (effectiveHash === '#/admin/media') {
      MediaVault.render(target);
    } else if (effectiveHash === '#/admin/themes') {
      ThemeStudio.render(target);
    } else if (effectiveHash === '#/admin/addons') {
      AddonsView.render(target);
    } else if (effectiveHash === '#/admin/users') {
      const rendered = UsersView.render(target);
      if (rendered && typeof rendered.then === 'function') {
        rendered.then(() => {
          if (!this.can('users:delete')) {
            target.querySelectorAll('.btn-delete-user').forEach(button => button.remove());
          }
          if (!this.isSuperadmin()) {
            const createButton = target.querySelector('#btn-create-user');
            if (createButton) {
              createButton.addEventListener('click', () => {
                const roleSelect = document.getElementById('modal-user-role');
                if (!roleSelect) return;
                Array.from(roleSelect.options).forEach(option => {
                  if (!['author', 'operator'].includes(option.value)) option.remove();
                });
              });
            }
          }
        }).catch(() => {});
      }
    } else if (effectiveHash === '#/admin/settings') {
      SettingsView.render(target);
    } else {
      DashboardView.render(target);
    }
  },

  applyThemeTokens(themeSlug, tokens = {}, customCss = '') {
    const color = value => /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? String(value) : null;
    const length = value => /^\d+(?:\.\d+)?(?:px|rem|em|%)$/.test(String(value || '')) ? String(value) : null;
    const font = value => /^[a-z0-9\s,'"._-]{1,200}$/i.test(String(value || '')) ? String(value) : null;
    const accent = color(tokens.accent_color);
    if (accent) {
      document.documentElement.style.setProperty('--dl-accent', accent);
      document.documentElement.style.setProperty('--dl-accent-glow', `${accent}33`);
    }
    if (color(tokens.bg_color)) document.documentElement.style.setProperty('--dl-black', color(tokens.bg_color));
    if (color(tokens.card_bg)) document.documentElement.style.setProperty('--dl-surface', color(tokens.card_bg));
    if (color(tokens.text_color)) document.documentElement.style.setProperty('--dl-text', color(tokens.text_color));
    if (color(tokens.text_muted)) document.documentElement.style.setProperty('--dl-text-muted', color(tokens.text_muted));
    if (length(tokens.border_radius)) document.documentElement.style.setProperty('--dl-radius', length(tokens.border_radius));
    if (font(tokens.font_heading)) document.documentElement.style.setProperty('--dl-font-heading', font(tokens.font_heading));
    if (font(tokens.font_body)) document.documentElement.style.setProperty('--dl-font-body', font(tokens.font_body));
    if (font(tokens.font_mono)) document.documentElement.style.setProperty('--dl-font-mono', font(tokens.font_mono));
    if (length(tokens.container_width)) document.documentElement.style.setProperty('--dl-max-width', length(tokens.container_width));

    // Dynamic style tag for custom CSS
    let customStyleTag = document.getElementById('dl-custom-theme-css');
    if (!customStyleTag) {
      customStyleTag = document.createElement('style');
      customStyleTag.id = 'dl-custom-theme-css';
      document.head.appendChild(customStyleTag);
    }
    customStyleTag.textContent = customCss || '';
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
    const indicator = document.createElement('span');
    indicator.style.color = 'var(--dl-accent)';
    indicator.textContent = '//';
    const messageNode = document.createElement('span');
    messageNode.textContent = String(message ?? '');
    toast.append(indicator, document.createTextNode(' '), messageNode);

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  openModal(html, options = {}) {
    this.closeModal();
    const returnFocus = document.activeElement;
    const onClose = options && typeof options.onClose === 'function' ? options.onClose : null;

    const modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'active-modal-backdrop';
    modalBackdrop.className = 'dl-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'dl-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('tabindex', '-1');
    modal.innerHTML = html;

    const heading = modal.querySelector('.dl-modal-header h3, .dl-modal-header h2, h1, h2, h3');
    if (heading && heading.textContent.trim()) {
      if (!heading.id) heading.id = `dl-modal-title-${Date.now()}`;
      modal.setAttribute('aria-labelledby', heading.id);
    } else {
      modal.setAttribute('aria-label', 'Deadletters dialog');
    }

    modalBackdrop.appendChild(modal);

    const focusableElements = () => Array.from(modal.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.getClientRects().length > 0);

    modalBackdrop.querySelectorAll('[data-close-modal]').forEach(button => {
      button.addEventListener('click', () => this.closeModal());
    });

    // A backdrop click only closes the dialog when the same deliberate pointer
    // press started on the backdrop. Dragging a selection out of the panel does
    // not dismiss the operator's work.
    let pointerDownOnBackdrop = false;
    modalBackdrop.addEventListener('pointerdown', (event) => {
      pointerDownOnBackdrop = event.target === modalBackdrop;
    });
    modalBackdrop.addEventListener('click', (event) => {
      const deliberate = pointerDownOnBackdrop && event.target === modalBackdrop;
      pointerDownOnBackdrop = false;
      if (deliberate) this.closeModal();
    });

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeModal();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeInside = modal.contains(document.activeElement);
      if (event.shiftKey && (!activeInside || document.activeElement === first)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    this._modalReturnFocus = returnFocus;
    this._modalKeydown = handleKeydown;
    this._modalElement = modal;
    this._modalOnClose = onClose;
    document.addEventListener('keydown', handleKeydown, true);
    document.body.appendChild(modalBackdrop);

    const initialFocus = modal.querySelector('[autofocus]') ||
      modal.querySelector('input:not([type="hidden"]), select, textarea') ||
      focusableElements()[0] ||
      modal;
    initialFocus.focus({ preventScroll: true });
  },

  closeModal() {
    if (this._modalKeydown) {
      document.removeEventListener('keydown', this._modalKeydown, true);
      this._modalKeydown = null;
    }

    const existing = document.getElementById('active-modal-backdrop');
    if (existing) existing.remove();

    const returnFocus = this._modalReturnFocus;
    this._modalReturnFocus = null;
    this._modalElement = null;
    const onClose = this._modalOnClose;
    this._modalOnClose = null;

    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
      returnFocus.focus({ preventScroll: true });
    }

    if (onClose) {
      try {
        onClose();
      } catch {}
    }
  },

  confirmAction({
    title = 'CONFIRM ACTION',
    message = '',
    confirmLabel = 'CONFIRM',
    cancelLabel = 'CANCEL',
    danger = true
  } = {}) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        this.closeModal();
        resolve(value);
      };

      this.openModal(`
        <div class="dl-modal-header">
          <h3 style="font-size: 1.25rem;">${escapeHtml(title)}</h3>
          <button class="dl-modal-close" type="button" data-close-modal aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 0.9rem; color: var(--dl-text-muted); line-height: 1.65; margin-bottom: 1.5rem;">
          ${escapeHtml(message)}
        </p>
        <div style="display: flex; justify-content: flex-end; gap: 0.75rem; flex-wrap: wrap;">
          <button id="dl-confirm-cancel" class="dl-btn dl-btn-outline dl-btn-sm" type="button" autofocus>${escapeHtml(cancelLabel)}</button>
          <button id="dl-confirm-ok" class="dl-btn ${danger ? 'dl-btn-danger' : 'dl-btn-accent'} dl-btn-sm" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      `, { onClose: () => finish(false) });

      const cancelButton = document.getElementById('dl-confirm-cancel');
      const confirmButton = document.getElementById('dl-confirm-ok');
      if (cancelButton) cancelButton.addEventListener('click', () => finish(false));
      if (confirmButton) confirmButton.addEventListener('click', () => finish(true));
    });
  },

  openReshareModal({ sourcePostId, title, author, excerpt }) {
    if (!this.can('reshares:create')) {
      this.showToast('Operator authentication is required to re-letter.');
      window.location.hash = '#/admin';
      return;
    }

    this.openModal(`
      <div class="dl-modal-header">
        <h3 style="font-size: 1.25rem;">RE-LETTER THIS TRANSMISSION</h3>
        <button class="dl-modal-close" type="button" data-close-modal>✕</button>
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
          <button class="dl-btn dl-btn-outline dl-btn-sm" type="button" data-close-modal>CANCEL</button>
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
        App.showToast('Re-letter recorded on this node.');
      } catch (err) {
        alert('Reshare failed: ' + err.message);
      }
    });
  },

  openCommandPalette() {
    const commands = [];
    if (this.can('posts:create')) {
      commands.push({ hash: '#/admin/editor', label: '✍ New Post (Editor Studio)' });
    }
    if (this.can('reshares:create')) {
      commands.push({ hash: '#/admin/reshares', label: '↻ Reshare & Mesh Hub' });
    }
    if (this.can('comments:moderate')) {
      commands.push({ hash: '#/admin/comments', label: '💬 Comments & Moderation' });
    }
    if (this.isSuperadmin()) {
      commands.push({ hash: '#/admin/federation', label: '🌐 Federation & Peers' });
    }
    if (this.can('themes:manage')) {
      commands.push({ hash: '#/admin/themes', label: '🎨 Theme Studio & Customizer' });
    }
    if (this.can('addons:manage')) {
      commands.push({ hash: '#/admin/addons', label: '🧩 Addons & Hooks' });
    }
    if (this.can('media:upload') || this.can('media:delete')) {
      commands.push({ hash: '#/admin/media', label: '▤ Media Vault' });
    }
    if (this.can('settings:export')) {
      commands.push({ hash: '#/admin/settings', label: '📦 Engine Export Packager' });
    }
    commands.push({ hash: '#/', label: '↗ View Public Editorial Reader' });

    this.openModal(`
      <div style="font-family: var(--dl-font-mono);">
        <input id="cmd-input" type="text" placeholder="Type a command or jump to view..." class="dl-input" style="font-size: 1.1rem; padding: 1rem; border-color: var(--dl-accent);" autofocus />
        <div id="cmd-list" style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.4rem;">
          ${commands.map(command => `
            <div class="cmd-item" data-hash="${escapeHtml(command.hash)}" style="padding: 0.6rem; background: var(--dl-surface); cursor: pointer;">${escapeHtml(command.label)}</div>
          `).join('')}
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
