/**
 * DEADLETTERS THEME STUDIO & LIVE TOKEN CUSTOMIZER
 * Atelier Design Direction & Custom CSS Pipeline
 */

const ThemeStudio = {
  async render(container) {
    try {
      const [themesRes, activeRes] = await Promise.all([
        API.get('/api/v1/themes'),
        API.get('/api/v1/themes/active')
      ]);

      const themes = themesRes.themes || [];
      const active = activeRes.activeTheme || {};
      const tokens = active.tokens || {};

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // DEADPLUG ATELIER THEME ENGINE //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">THEME STUDIO & CUSTOMIZER</h2>
            </div>
            <div>
              <input type="file" id="theme-zip-input" style="display: none;" accept=".zip" />
              <button id="btn-upload-theme" class="dl-btn dl-btn-outline">+ INSTALL THEME (.ZIP)</button>
            </div>
          </div>

          <!-- Installed Themes Grid -->
          <h3 style="font-size: 1.15rem; margin-bottom: 1rem;">INSTALLED THEMES</h3>
          <div class="dl-themes-grid">
            ${themes.map(t => `
              <div class="dl-theme-card ${t.isActive ? 'active' : ''}">
                <img src="${escapeHtml(safeUrl(t.preview_image, '/uploads/deadplug_editorial_cover.jpg'))}" alt="${escapeHtml(`${t.name || t.slug} theme preview`)}" class="dl-theme-preview" />
                <div class="dl-theme-body">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <div class="dl-theme-name">${escapeHtml(t.name)}</div>
                    ${t.isActive ? '<span class="dl-badge dl-badge-accent">ACTIVE</span>' : ''}
                  </div>
                  <p class="dl-theme-desc">${escapeHtml(t.description)}</p>
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-text-faint);">by ${escapeHtml(t.author || 'deadplug.digital')}</span>
                    ${!t.isActive ? `
                      <button class="dl-btn dl-btn-accent dl-btn-sm btn-activate-theme" data-slug="${escapeHtml(t.slug)}">ACTIVATE</button>
                    ` : `
                      <span style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-accent);">CURRENTLY APPLIED</span>
                    `}
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <!-- Live Design Token Customizer -->
          <div class="dl-card" style="margin-top: 2rem;">
            <div class="dl-box-title" style="display: flex; justify-content: space-between; align-items: center;">
              <span>// LIVE DESIGN TOKENS // ${escapeHtml(active.name || active.slug)}</span>
              <button id="btn-save-tokens" class="dl-btn dl-btn-accent dl-btn-sm">⚡ SYNC & COMMIT TOKENS</button>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-top: 1.5rem;">
              <div>
                <!-- Accent Color Picker -->
                <div class="dl-form-group">
                  <label class="dl-label" for="token-accent-color">Accent Brand Color</label>
                  <div style="display: flex; gap: 0.75rem; align-items: center;">
                    <input type="color" id="token-accent-color" value="${escapeHtml(tokens.accent_color || '#D6FF00')}" style="width: 50px; height: 38px; border: 1px solid var(--dl-border); background: transparent; cursor: pointer;" />
                    <input type="text" id="token-accent-hex" class="dl-input" aria-label="Accent color hex value" value="${escapeHtml(tokens.accent_color || '#D6FF00')}" style="width: 140px; font-family: var(--dl-font-mono);" />
                    <!-- Preset swatches -->
                    <div style="display: flex; gap: 6px;">
                      <span class="color-swatch" data-hex="#D6FF00" style="width: 24px; height: 24px; background: #D6FF00; cursor: pointer; border: 1px solid #333;" title="Acid Lime"></span>
                      <span class="color-swatch" data-hex="#00F0FF" style="width: 24px; height: 24px; background: #00F0FF; cursor: pointer; border: 1px solid #333;" title="Cyber Cyan"></span>
                      <span class="color-swatch" data-hex="#FF2A55" style="width: 24px; height: 24px; background: #FF2A55; cursor: pointer; border: 1px solid #333;" title="Crimson"></span>
                      <span class="color-swatch" data-hex="#FFB703" style="width: 24px; height: 24px; background: #FFB703; cursor: pointer; border: 1px solid #333;" title="Tech Amber"></span>
                      <span class="color-swatch" data-hex="#FFFFFF" style="width: 24px; height: 24px; background: #FFFFFF; cursor: pointer; border: 1px solid #333;" title="Chalk White"></span>
                    </div>
                  </div>
                </div>

                <!-- Border Radius -->
                <div class="dl-form-group">
                  <label class="dl-label" for="token-radius">Border Radius: <span id="radius-val">${escapeHtml(tokens.border_radius || '0px')}</span></label>
                  <input type="range" id="token-radius" min="0" max="16" step="2" value="${escapeHtml(parseInt(tokens.border_radius || '0', 10))}" style="accent-color: var(--dl-accent); width: 100%;" />
                </div>

                <!-- Font Heading -->
                <div class="dl-form-group">
                  <label class="dl-label" for="token-font-heading">Editorial Heading Typography</label>
                  <select id="token-font-heading" class="dl-select">
                    <option value="'Syne', sans-serif">Syne (High-Fashion Avant-Garde)</option>
                    <option value="'Instrument Serif', Georgia, serif">Instrument Serif (Luxury Editorial)</option>
                    <option value="'Space Grotesk', sans-serif">Space Grotesk (Brutalist Modern)</option>
                    <option value="'JetBrains Mono', monospace">JetBrains Mono (Stealth Terminal)</option>
                  </select>
                </div>
              </div>

              <!-- Custom CSS Injection -->
              <div>
                <div class="dl-form-group">
                  <label class="dl-label" for="token-custom-css">Custom CSS Overrides</label>
                  <textarea id="token-custom-css" class="dl-textarea" style="font-family: var(--dl-font-mono); font-size: 0.8rem; min-height: 180px;" placeholder="/* Custom CSS injected directly into atelier frontend */">${escapeHtml(active.customCss || '')}</textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      this.bindThemeEvents(container, active);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Theme studio error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  bindThemeEvents(container, active) {
    // Activate Theme
    container.querySelectorAll('.btn-activate-theme').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await API.post('/api/v1/themes/activate', { slug: btn.dataset.slug });
          await App.loadActiveTheme();
          App.showToast(`Theme activated: ${btn.dataset.slug}`);
          this.render(container);
        } catch (e) {
          alert('Activation failed: ' + e.message);
        }
      });
    });

    // Color Pickers & Live Preview
    const colorPicker = container.querySelector('#token-accent-color');
    const colorHex = container.querySelector('#token-accent-hex');
    const radiusSlider = container.querySelector('#token-radius');
    const radiusVal = container.querySelector('#radius-val');

    const updateLiveTokens = () => {
      document.documentElement.style.setProperty('--dl-accent', colorHex.value);
      document.documentElement.style.setProperty('--dl-radius', `${radiusSlider.value}px`);
      radiusVal.innerText = `${radiusSlider.value}px`;
    };

    colorPicker.addEventListener('input', () => {
      colorHex.value = colorPicker.value.toUpperCase();
      updateLiveTokens();
    });

    colorHex.addEventListener('input', () => {
      colorPicker.value = colorHex.value;
      updateLiveTokens();
    });

    radiusSlider.addEventListener('input', updateLiveTokens);

    container.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        colorHex.value = swatch.dataset.hex;
        colorPicker.value = swatch.dataset.hex;
        updateLiveTokens();
      });
    });

    // Save Tokens
    container.querySelector('#btn-save-tokens').addEventListener('click', async () => {
      const tokens = {
        accent_color: colorHex.value,
        border_radius: `${radiusSlider.value}px`,
        font_heading: container.querySelector('#token-font-heading').value
      };
      const customCss = container.querySelector('#token-custom-css').value;

      try {
        await API.post(`/api/v1/themes/tokens/${encodeURIComponent(active.slug)}`, { tokens, customCss });
        App.showToast('Theme tokens saved & synchronized.');
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    });

    // Upload Theme Zip
    const fileInput = container.querySelector('#theme-zip-input');
    const uploadBtn = container.querySelector('#btn-upload-theme');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.innerText = 'EXTRACTING ZIP...';
      try {
        await API.uploadFile(file, '/api/v1/themes/upload-zip', 'theme_zip');
        App.showToast('Theme package installed successfully!');
        this.render(container);
      } catch (err) {
        alert('Theme install failed: ' + err.message);
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = '+ INSTALL THEME (.ZIP)';
      }
    });
  }
};
