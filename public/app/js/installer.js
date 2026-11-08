/**
 * DEADLETTERS INTERACTIVE INSTALLER WIZARD
 * Deadplug Digital Atelier Engine Initialization
 */

const InstallerWizard = {
  currentStep: 1,
  data: {
    siteTitle: 'DEADLETTERS // DEADPLUG',
    siteTagline: 'the plug is dead. stay wired.',
    siteNodeHandle: '@deadplug/main-node',
    siteUrl: window.location.origin,
    adminLogin: 'clown',
    adminEmail: 'clown@deadplug.digital',
    adminPassword: '',
    setupToken: '',
    themeSlug: 'deadplug-editorial',
    seedDemoContent: true
  },

  async render(container) {
    const status = await API.get('/api/v1/installer/status');
    if (status.isInstalled) {
      container.innerHTML = `
        <div class="dl-installer-wrap">
          <div class="dl-installer-card" style="text-align: center;">
            <div style="font-family: var(--dl-font-mono); color: var(--dl-accent); margin-bottom: 1rem;">// SYSTEM ALREADY INITIALIZED //</div>
            <h2 style="margin-bottom: 1rem;">Deadletters Node Operational</h2>
            <p style="color: var(--dl-text-muted); margin-bottom: 2rem;">This node is already provisioned and broadcasting to the mesh.</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
              <a href="#/admin" class="dl-btn dl-btn-accent">Enter Control Panel</a>
              <a href="#/" class="dl-btn dl-btn-outline">View Atelier Reader</a>
            </div>
          </div>
        </div>
      `;
      return;
    }

    this.renderStep(container, status);
  },

  renderStep(container, status) {
    container.innerHTML = `
      <div class="dl-installer-wrap">
        <div class="dl-installer-card">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em;">// DEADPLUG.DIGITAL // INSTALLER</div>
              <h2 style="font-weight: 800; letter-spacing: -0.03em;">PROVISION DEADLETTERS</h2>
            </div>
            <div class="dl-badge dl-badge-accent">v1.0.0</div>
          </div>

          <div class="dl-wizard-steps">
            <div class="dl-step-indicator ${this.currentStep === 1 ? 'active' : ''} ${this.currentStep > 1 ? 'completed' : ''}">01. DIAGNOSTICS</div>
            <div class="dl-step-indicator ${this.currentStep === 2 ? 'active' : ''} ${this.currentStep > 2 ? 'completed' : ''}">02. IDENTITY</div>
            <div class="dl-step-indicator ${this.currentStep === 3 ? 'active' : ''} ${this.currentStep > 3 ? 'completed' : ''}">03. OPERATOR</div>
            <div class="dl-step-indicator ${this.currentStep === 4 ? 'active' : ''} ${this.currentStep > 4 ? 'completed' : ''}">04. ATELIER</div>
          </div>

          <div id="dl-step-content">
            ${this.getStepContent(status)}
          </div>
        </div>
      </div>
    `;

    this.bindStepEvents(container, status);
  },

  getStepContent(status) {
    if (this.currentStep === 1) {
      return `
        <div style="margin-bottom: 1.5rem;">
          <h3 style="font-size: 1.15rem; margin-bottom: 0.75rem;">Environment Diagnostics</h3>
          <p style="font-size: 0.88rem; color: var(--dl-text-muted);">Confirming core runtime parameters before node allocation.</p>
          
          <div style="margin-top: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem;">
            <div style="display: flex; justify-content: space-between; padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.8rem;">
              <span>NODE.JS RUNTIME</span>
              <span style="color: var(--dl-emerald);">✓ ${escapeHtml(status.checks.nodeVersion.version)} (READY)</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.8rem;">
              <span>SQLITE STORAGE ENGINE</span>
              <span style="color: var(--dl-emerald);">✓ SYNCHRONOUS WAL (READY)</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 0.75rem; background: var(--dl-surface); border: 1px solid var(--dl-border); font-family: var(--dl-font-mono); font-size: 0.8rem;">
              <span>FILE SYSTEM PERMISSIONS</span>
              <span style="color: ${status.checks.fsWritable.passed ? 'var(--dl-emerald)' : 'var(--dl-crimson)'};">
                ${status.checks.fsWritable.passed ? '✓ WRITABLE (READY)' : '✗ PERMISSION DENIED'}
              </span>
            </div>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button id="btn-step-next" class="dl-btn dl-btn-accent">Proceed to Identity →</button>
        </div>
      `;
    }

    if (this.currentStep === 2) {
      return `
        <div style="margin-bottom: 1.5rem;">
          <h3 style="font-size: 1.15rem; margin-bottom: 0.75rem;">Atelier Node Identity</h3>
          <div class="dl-form-group">
            <label class="dl-label">Site / Atelier Title</label>
            <input id="input-title" class="dl-input" type="text" value="${escapeHtml(this.data.siteTitle)}" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Tagline / Transmission Header</label>
            <input id="input-tagline" class="dl-input" type="text" value="${escapeHtml(this.data.siteTagline)}" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Mesh Node Handle</label>
            <input id="input-handle" class="dl-input" type="text" value="${escapeHtml(this.data.siteNodeHandle)}" />
          </div>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <button id="btn-step-back" class="dl-btn dl-btn-outline">← Back</button>
          <button id="btn-step-next" class="dl-btn dl-btn-accent">Operator Credentials →</button>
        </div>
      `;
    }

    if (this.currentStep === 3) {
      return `
        <div style="margin-bottom: 1.5rem;">
          <h3 style="font-size: 1.15rem; margin-bottom: 0.75rem;">Master Operator Account</h3>
          <p style="font-size: 0.88rem; color: var(--dl-text-muted); margin-bottom: 1rem;">This account will have Superadmin clearance to govern the engine.</p>
          <div class="dl-form-group">
            <label class="dl-label">Operator Username</label>
            <input id="input-login" class="dl-input" type="text" value="${escapeHtml(this.data.adminLogin)}" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Operator Email</label>
            <input id="input-email" class="dl-input" type="email" value="${escapeHtml(this.data.adminEmail)}" />
          </div>
          <div class="dl-form-group">
            <label class="dl-label">Master Secret Key / Password (Min 12 chars)</label>
            <input id="input-password" class="dl-input" type="password" placeholder="••••••••••••" value="${escapeHtml(this.data.adminPassword)}" />
          </div>
          ${status.setupTokenRequired ? `
            <div class="dl-form-group">
              <label class="dl-label">Installation Setup Token</label>
              <input id="input-setup-token" class="dl-input" type="password" value="${escapeHtml(this.data.setupToken)}" autocomplete="off" />
            </div>
          ` : ''}
        </div>
        <div style="display: flex; justify-content: space-between;">
          <button id="btn-step-back" class="dl-btn dl-btn-outline">← Back</button>
          <button id="btn-step-next" class="dl-btn dl-btn-accent">Atelier Configuration →</button>
        </div>
      `;
    }

    if (this.currentStep === 4) {
      return `
        <div style="margin-bottom: 1.5rem;">
          <h3 style="font-size: 1.15rem; margin-bottom: 0.75rem;">Theme & Starter Content</h3>
          
          <div class="dl-form-group">
            <label class="dl-label">Initial Theme</label>
            <select id="select-theme" class="dl-select">
              <option value="deadplug-editorial" selected>Deadplug Signature Editorial (Flagship Brutalist Luxury)</option>
              <option value="monolith-cyberpunk">Monolith Cyberpunk / Matrix (Obsidian & Electric Cyan)</option>
              <option value="suisse-minimal">Suisse International Atelier (Pure Monochrome Modernism)</option>
            </select>
          </div>

          <div style="margin-top: 1.25rem; padding: 1rem; background: var(--dl-surface); border: 1px solid var(--dl-border); display: flex; align-items: center; gap: 0.75rem;">
            <input type="checkbox" id="check-seed" checked style="accent-color: var(--dl-accent); width: 18px; height: 18px;" />
            <label for="check-seed" style="font-size: 0.85rem; color: var(--dl-text); cursor: pointer;">
              <strong>Seed High-Quality Deadplug Editorial Demonstrations</strong>
              <div style="font-size: 0.75rem; color: var(--dl-text-muted);">Includes "The Plug is Dead" manifesto, Monolith Architecture drop, seed reshares, and media.</div>
            </label>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <button id="btn-step-back" class="dl-btn dl-btn-outline">← Back</button>
          <button id="btn-execute-install" class="dl-btn dl-btn-accent">⚡ Initialize Engine</button>
        </div>
      `;
    }
  },

  bindStepEvents(container, status) {
    const nextBtn = container.querySelector('#btn-step-next');
    const backBtn = container.querySelector('#btn-step-back');
    const execBtn = container.querySelector('#btn-execute-install');

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.currentStep === 2) {
          this.data.siteTitle = container.querySelector('#input-title').value;
          this.data.siteTagline = container.querySelector('#input-tagline').value;
          this.data.siteNodeHandle = container.querySelector('#input-handle').value;
        } else if (this.currentStep === 3) {
          this.data.adminLogin = container.querySelector('#input-login').value;
          this.data.adminEmail = container.querySelector('#input-email').value;
          this.data.adminPassword = container.querySelector('#input-password').value;
          this.data.setupToken = container.querySelector('#input-setup-token')?.value || '';
          if (!this.data.adminPassword || this.data.adminPassword.length < 12) {
            alert('Password must be at least 12 characters.');
            return;
          }
          if (status.setupTokenRequired && !this.data.setupToken) {
            alert('The installation setup token is required.');
            return;
          }
        }
        this.currentStep++;
        this.renderStep(container, status);
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        this.currentStep--;
        this.renderStep(container, status);
      });
    }

    if (execBtn) {
      execBtn.addEventListener('click', async () => {
        this.data.themeSlug = container.querySelector('#select-theme').value;
        this.data.seedDemoContent = container.querySelector('#check-seed').checked;

        execBtn.disabled = true;
        execBtn.textContent = '⚡ Compiling Engine...';

        try {
          const res = await API.post('/api/v1/installer/execute', this.data);
          API.setToken(res.token);
          App.currentUser = res.user;
          App.showToast('Deadletters Engine Initialized. Welcome, Operator.');
          window.location.hash = '#/admin';
        } catch (err) {
          alert('Installation Failed: ' + err.message);
          execBtn.disabled = false;
          execBtn.textContent = '⚡ Initialize Engine';
        }
      });
    }
  }
};
