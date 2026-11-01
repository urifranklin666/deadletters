/**
 * DEADLETTERS MEDIA VAULT
 * Asset repository & CDN-ready media management
 */

const MediaVault = {
  async render(container) {
    try {
      const res = await API.get('/api/v1/media');
      const media = res.media || [];

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // ATELIER ASSET ARCHIVE //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">MEDIA VAULT</h2>
            </div>
            <div>
              <input type="file" id="vault-file-input" style="display: none;" multiple />
              <button id="btn-vault-upload" class="dl-btn dl-btn-accent">+ UPLOAD ASSET</button>
            </div>
          </div>

          <!-- Drag and Drop Dropzone -->
          <div id="vault-dropzone" style="border: 2px dashed var(--dl-border-strong); padding: 2.5rem; text-align: center; background: var(--dl-obsidian); margin-bottom: 2rem; cursor: pointer; transition: var(--dl-transition);">
            <div style="font-family: var(--dl-font-mono); font-size: 0.85rem; color: var(--dl-accent); margin-bottom: 0.5rem;">
              [ DRAG & DROP MEDIA ASSETS OR CLICK TO UPLOAD ]
            </div>
            <div style="font-size: 0.78rem; color: var(--dl-text-muted);">
              Supports JPEG, PNG, WEBP, GIF, SVG, MP4, MP3 up to 25MB.
            </div>
          </div>

          <!-- Asset Grid -->
          <div class="dl-media-grid">
            ${media.length === 0 ? `
              <div style="grid-column: 1 / -1; padding: 3rem; text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono);">
                // MEDIA VAULT EMPTY //
              </div>
            ` : media.map(m => `
              <div class="dl-media-card">
                ${m.isImage ? `
                  <img src="${m.url}" class="dl-media-thumb" loading="lazy" />
                ` : `
                  <div class="dl-media-thumb" style="display: flex; align-items: center; justify-content: center; font-family: var(--dl-font-mono); font-size: 0.8rem; color: var(--dl-text-muted);">
                    FILE ASSET
                  </div>
                `}
                <div class="dl-media-info">
                  <div class="dl-media-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
                  <div class="dl-media-meta">
                    <span>${Math.round(m.sizeBytes / 1024)} KB</span>
                    <span style="color: var(--dl-accent);">${new Date(m.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div style="display: flex; gap: 4px; margin-top: 0.5rem;">
                    <button class="dl-btn dl-btn-outline dl-btn-sm btn-copy-url" data-url="${m.url}" style="flex: 1; padding: 2px 4px; font-size: 0.68rem;">COPY URL</button>
                    <button class="dl-btn dl-btn-danger dl-btn-sm btn-delete-media" data-filename="${m.filename}" style="padding: 2px 6px; font-size: 0.68rem;">✕</button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;

      this.bindVaultEvents(container);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Vault error: ${err.message}</div></div>`;
    }
  },

  bindVaultEvents(container) {
    const dropzone = container.querySelector('#vault-dropzone');
    const fileInput = container.querySelector('#vault-file-input');
    const uploadBtn = container.querySelector('#btn-vault-upload');

    uploadBtn.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--dl-accent)';
      dropzone.style.backgroundColor = 'var(--dl-surface)';
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'var(--dl-border-strong)';
      dropzone.style.backgroundColor = 'var(--dl-obsidian)';
    });

    const handleUploadFiles = async (files) => {
      if (!files || files.length === 0) return;
      App.showToast(`Uploading ${files.length} asset(s)...`);
      for (const f of files) {
        try {
          await API.uploadFile(f);
        } catch (e) {
          alert('Upload failed for ' + f.name + ': ' + e.message);
        }
      }
      App.showToast('Uploads completed.');
      this.render(container);
    };

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--dl-border-strong)';
      handleUploadFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
      handleUploadFiles(e.target.files);
    });

    // Copy URL
    container.querySelectorAll('.btn-copy-url').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.url);
        App.showToast('Asset URL copied to clipboard.');
      });
    });

    // Delete
    container.querySelectorAll('.btn-delete-media').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Vaporize asset from media vault?')) {
          try {
            await API.del(`/api/v1/media/${btn.dataset.filename}`);
            App.showToast('Asset vaporized.');
            this.render(container);
          } catch (e) {
            alert(e.message);
          }
        }
      });
    });
  }
};
