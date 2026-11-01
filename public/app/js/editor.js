/**
 * DEADLETTERS DUAL-MODE EDITOR STUDIO
 * Visual / Markdown Editorial Composition with Deadplug Shortcodes
 */

const EditorStudio = {
  activePostId: null,

  async render(container, postId = null) {
    this.activePostId = postId;
    let post = {
      post_title: '',
      post_name: '',
      post_content: '',
      post_excerpt: '',
      post_status: 'publish',
      post_type: 'post',
      featured_image: '',
      content_format: 'standard',
      drop_code: 'NEW-DROP'
    };

    if (postId) {
      try {
        const res = await API.get(`/api/v1/posts/${postId}`);
        post = res.post;
      } catch (err) {
        alert('Could not load letter: ' + err.message);
      }
    }

    container.innerHTML = `
      <div class="dl-admin-content">
        <!-- Editor Studio Top Controls -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem;">
          <div style="display: flex; align-items: center; gap: 1rem;">
            <a href="#/admin" class="dl-btn dl-btn-ghost dl-btn-sm">← RETURN TO TERMINAL</a>
            <span class="dl-badge dl-badge-accent">${postId ? 'EDITING TRANSMISSION' : 'NEW LETTER DROP'}</span>
            <span style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">CODE: ${post.drop_code || 'PENDING'}</span>
          </div>

          <div style="display: flex; align-items: center; gap: 0.75rem;">
            ${postId ? `<button id="btn-revisions-history" class="dl-btn dl-btn-ghost dl-btn-sm">📜 REVISIONS</button>` : ''}
            ${postId ? `<button id="btn-trash-post" class="dl-btn dl-btn-danger dl-btn-sm">TRASH</button>` : ''}
            <button id="btn-save-draft" class="dl-btn dl-btn-outline dl-btn-sm">SAVE DRAFT</button>
            <button id="btn-publish" class="dl-btn dl-btn-accent dl-btn-sm">⚡ PUBLISH DROP</button>
          </div>
        </div>

        <!-- Studio Grid -->
        <div class="dl-editor-studio">
          <!-- Main Content Pane -->
          <div class="dl-editor-main">
            <!-- Mode Toggle & Formatting Bar -->
            <div class="dl-editor-header">
              <div class="dl-editor-mode-toggle">
                <button class="dl-mode-btn active" data-mode="markdown">MARKDOWN / CODE</button>
                <button class="dl-mode-btn" data-mode="preview">LIVE PREVIEW</button>
              </div>

              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">
                <span id="word-count">0</span> WORDS // <span id="read-time">1</span> MIN READ
              </div>
            </div>

            <!-- Toolbar Buttons -->
            <div id="editor-toolbar" class="dl-editor-toolbar">
              <button class="dl-tool-btn" data-tag="bold"><strong>B</strong></button>
              <button class="dl-tool-btn" data-tag="italic"><em>I</em></button>
              <button class="dl-tool-btn" data-tag="h2">H2</button>
              <button class="dl-tool-btn" data-tag="h3">H3</button>
              <button class="dl-tool-btn" data-tag="pullquote">[PULLQUOTE]</button>
              <button class="dl-tool-btn" data-tag="callout">[CALLOUT]</button>
              <button class="dl-tool-btn" data-tag="glitch">[GLITCH]</button>
              <button class="dl-tool-btn" data-tag="dropcap">[DROPCAP]</button>
              <button class="dl-tool-btn" data-tag="code">&lt;/&gt;</button>
            </div>

            <!-- Title Input -->
            <input id="post-title" class="dl-title-input" type="text" placeholder="DROP TRANSMISSION TITLE..." value="${escapeHtml(post.post_title)}" />

            <!-- Content Area (Dual Mode) -->
            <div id="editor-body-wrap" style="position: relative;">
              <textarea id="post-content" class="dl-content-textarea" placeholder="Compose editorial manifesto or markdown correspondence...">${escapeHtml(post.post_content)}</textarea>
              <div id="post-preview" style="display: none; padding: 2rem; font-size: 1.1rem; line-height: 1.8; color: #dce0e8; min-height: 480px; background: var(--dl-obsidian);"></div>
            </div>
          </div>

          <!-- Inspector Sidebar -->
          <div class="dl-editor-sidebar">
            <!-- Publishing Meta -->
            <div class="dl-sidebar-box">
              <div class="dl-box-title">// LETTER SPECS</div>
              <div class="dl-form-group">
                <label class="dl-label">Publication Status</label>
                <select id="post-status" class="dl-select">
                  <option value="publish" ${post.post_status === 'publish' ? 'selected' : ''}>Published (Active Frequency)</option>
                  <option value="draft" ${post.post_status === 'draft' ? 'selected' : ''}>Draft (Local Atelier Only)</option>
                  <option value="private" ${post.post_status === 'private' ? 'selected' : ''}>Private (Operator Clearance)</option>
                </select>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Editorial Format</label>
                <select id="post-format" class="dl-select">
                  <option value="standard" ${post.content_format === 'standard' ? 'selected' : ''}>Standard Letter</option>
                  <option value="manifesto" ${post.content_format === 'manifesto' ? 'selected' : ''}>Manifesto Dispatch</option>
                  <option value="lookbook" ${post.content_format === 'lookbook' ? 'selected' : ''}>Visual Lookbook</option>
                  <option value="audio_drop" ${post.content_format === 'audio_drop' ? 'selected' : ''}>Audio Frequency Drop</option>
                </select>
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Custom Slug</label>
                <input id="post-slug" class="dl-input" type="text" placeholder="auto-generated-slug" value="${escapeHtml(post.post_name)}" />
              </div>

              <div class="dl-form-group">
                <label class="dl-label">Editorial Excerpt / Abstract</label>
                <textarea id="post-excerpt" class="dl-textarea" style="min-height: 80px;" placeholder="Brief synopsis for index and RSS feed...">${escapeHtml(post.post_excerpt)}</textarea>
              </div>

              <div style="padding: 0.6rem 0.8rem; background: var(--dl-surface); border: 1px solid var(--dl-border); display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="check-sticky" ${post.is_sticky ? 'checked' : ''} style="accent-color: var(--dl-accent); width: 16px; height: 16px;" />
                <label for="check-sticky" style="font-size: 0.8rem; cursor: pointer;"><strong>📌 Pin to Top (Sticky Post)</strong></label>
              </div>
            </div>

            <!-- Featured Media -->
            <div class="dl-sidebar-box">
              <div class="dl-box-title">// FEATURED MEDIA</div>
              <div class="dl-form-group">
                <label class="dl-label">Media Asset URL</label>
                <input id="post-featured-image" class="dl-input" type="text" placeholder="/uploads/image.jpg" value="${escapeHtml(post.featured_image || '')}" />
              </div>
              <div style="display: flex; gap: 0.5rem;">
                <input type="file" id="file-uploader" style="display: none;" accept="image/*" />
                <button id="btn-upload-media" class="dl-btn dl-btn-outline dl-btn-sm" style="width: 100%;">UPLOAD ASSET</button>
              </div>
              <div id="media-preview-box" style="margin-top: 1rem; ${post.featured_image ? '' : 'display: none;'}">
                <img id="featured-preview" src="${post.featured_image || ''}" style="width: 100%; height: 120px; object-fit: cover; border: 1px solid var(--dl-border);" />
              </div>
            </div>

            <!-- SEO & Meta Card Preview -->
            <div class="dl-sidebar-box">
              <div class="dl-box-title">// SEO & TELEMETRY CARD</div>
              <div style="background: #000; border: 1px solid var(--dl-border); padding: 1rem; font-family: var(--dl-font-mono); font-size: 0.72rem;">
                <div style="color: var(--dl-text-muted); margin-bottom: 0.25rem;">deadplug.digital &gt; letters &gt; ...</div>
                <div id="seo-preview-title" style="color: var(--dl-cyan); font-weight: 700; margin-bottom: 0.25rem; font-size: 0.82rem;">${post.post_title || 'Untitled Transmission'}</div>
                <div id="seo-preview-desc" style="color: var(--dl-text-muted); font-size: 0.7rem; line-height: 1.4;">${post.post_excerpt || 'No synopsis provided.'}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEditorEvents(container, post);
  },

  bindEditorEvents(container, post) {
    const titleInput = container.querySelector('#post-title');
    const contentArea = container.querySelector('#post-content');
    const excerptArea = container.querySelector('#post-excerpt');
    const previewArea = container.querySelector('#post-preview');
    const wordCountSpan = container.querySelector('#word-count');
    const readTimeSpan = container.querySelector('#read-time');
    const seoTitle = container.querySelector('#seo-preview-title');
    const seoDesc = container.querySelector('#seo-preview-desc');

    const updateMetrics = () => {
      const words = contentArea.value.trim().split(/\s+/).filter(Boolean).length;
      wordCountSpan.innerText = words;
      readTimeSpan.innerText = Math.max(1, Math.ceil(words / 200));
      seoTitle.innerText = titleInput.value || 'Untitled Transmission';
      seoDesc.innerText = excerptArea.value || (contentArea.value.substring(0, 140) + '...');
    };

    titleInput.addEventListener('input', updateMetrics);
    contentArea.addEventListener('input', updateMetrics);
    excerptArea.addEventListener('input', updateMetrics);
    updateMetrics();

    // Mode Toggle (Markdown vs Preview)
    const modeBtns = container.querySelectorAll('.dl-mode-btn');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        if (mode === 'preview') {
          contentArea.style.display = 'none';
          previewArea.style.display = 'block';
          // Simple local render
          let html = contentArea.value
            .replace(/\[glitch\](.*?)\[\/glitch\]/gis, '<span class="dl-glitch-text">$1</span>')
            .replace(/\[pullquote(?:\s+author="([^"]*)")?\](.*?)\[\/pullquote\]/gis, '<figure class="dl-editorial-pullquote"><blockquote class="dl-quote-body">$2</blockquote><figcaption class="dl-quote-author">// $1</figcaption></figure>')
            .replace(/\[callout(?:\s+type="([^"]*)")?\](.*?)\[\/callout\]/gis, '<div class="dl-callout dl-callout-$1"><div class="dl-callout-header">// NOTICE</div><div>$2</div></div>')
            .replace(/\n\n/g, '<br/><br/>');
          previewArea.innerHTML = html || '<em>Empty drop composition.</em>';
        } else {
          contentArea.style.display = 'block';
          previewArea.style.display = 'none';
        }
      });
    });

    // Formatting Toolbar Insertion
    const toolbar = container.querySelector('#editor-toolbar');
    toolbar.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        const start = contentArea.selectionStart;
        const end = contentArea.selectionEnd;
        const sel = contentArea.value.substring(start, end);
        let replacement = '';

        switch (tag) {
          case 'bold': replacement = `**${sel || 'Bold Text'}**`; break;
          case 'italic': replacement = `*${sel || 'Italic Text'}*`; break;
          case 'h2': replacement = `\n## ${sel || 'Section Heading'}\n`; break;
          case 'h3': replacement = `\n### ${sel || 'Subsection Heading'}\n`; break;
          case 'pullquote': replacement = `\n[pullquote author="deadplug.digital"]${sel || 'Oversized luxury statement'}[/pullquote]\n`; break;
          case 'callout': replacement = `\n[callout type="alert"]${sel || 'Critical system advisory'}[/callout]\n`; break;
          case 'glitch': replacement = `[glitch]${sel || 'TRANSMISSION CORRUPTED'}[/glitch]`; break;
          case 'dropcap': replacement = `[dropcap]${sel || 'T'}[/dropcap]`; break;
          case 'code': replacement = `\`\`\`javascript\n${sel || '// code snippet'}\n\`\`\``; break;
        }

        contentArea.setRangeText(replacement, start, end, 'end');
        contentArea.focus();
        updateMetrics();
      });
    });

    // Asset upload button
    const fileInput = container.querySelector('#file-uploader');
    const uploadBtn = container.querySelector('#btn-upload-media');
    const featuredInput = container.querySelector('#post-featured-image');
    const previewBox = container.querySelector('#media-preview-box');
    const previewImg = container.querySelector('#featured-preview');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.innerHTML = 'UPLOADING...';
      try {
        const res = await API.uploadFile(file);
        featuredInput.value = res.url;
        previewImg.src = res.url;
        previewBox.style.display = 'block';
        App.showToast('Asset uploaded to vault.');
      } catch (err) {
        alert('Upload failed: ' + err.message);
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = 'UPLOAD ASSET';
      }
    });

    // Save Draft & Publish
    const savePost = async (targetStatus) => {
      const title = titleInput.value.trim();
      const content = contentArea.value.trim();
      const excerpt = excerptArea.value.trim();
      const slug = container.querySelector('#post-slug').value.trim();
      const featuredImage = featuredInput.value.trim();
      const format = container.querySelector('#post-format').value;
      const isSticky = container.querySelector('#check-sticky').checked;

      if (!title) {
        alert('Letter title is required.');
        return;
      }

      const payload = {
        title,
        content,
        excerpt,
        status: targetStatus,
        slug,
        featuredImage,
        contentFormat: format,
        isSticky
      };

      try {
        if (this.activePostId) {
          await API.put(`/api/v1/posts/${this.activePostId}`, payload);
          App.showToast('Letter updated in atelier archive.');
        } else {
          const res = await API.post('/api/v1/posts', payload);
          App.showToast('Letter dropped successfully.');
          window.location.hash = `#/admin/editor/${res.post.ID}`;
        }
      } catch (err) {
        alert('Failed to save transmission: ' + err.message);
      }
    };

    container.querySelector('#btn-save-draft').addEventListener('click', () => savePost('draft'));
    container.querySelector('#btn-publish').addEventListener('click', () => savePost('publish'));

    // Revisions History Modal
    const revBtn = container.querySelector('#btn-revisions-history');
    if (revBtn) {
      revBtn.addEventListener('click', async () => {
        try {
          const res = await API.get(`/api/v1/posts/${this.activePostId}/revisions`);
          const revs = res.revisions || [];
          App.openModal(`
            <div class="dl-modal-header">
              <h3 style="font-size: 1.25rem;">POST REVISIONS & SNAPSHOT HISTORY</h3>
              <button class="dl-modal-close" onclick="App.closeModal()">✕</button>
            </div>
            <p style="font-size: 0.82rem; color: var(--dl-text-muted); margin-bottom: 1.25rem;">Select an earlier editorial version to restore.</p>
            <div style="display: flex; flex-direction: column; gap: 0.75rem; max-height: 400px; overflow-y: auto;">
              ${revs.length === 0 ? '<div style="color: var(--dl-text-muted); font-family: var(--dl-font-mono);">No previous revisions recorded yet. Revisions are created automatically upon each edit.</div>' : revs.map(r => `
                <div style="padding: 1rem; background: var(--dl-surface); border: 1px solid var(--dl-border); display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-weight: 700; font-size: 0.9rem;">${escapeHtml(r.post_title)}</div>
                    <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">
                      Snapshot by ${escapeHtml(r.author_name || 'Operator')} on ${new Date(r.created_at).toLocaleString()}
                    </div>
                  </div>
                  <button class="dl-btn dl-btn-accent dl-btn-sm btn-restore-rev" data-revid="${r.revision_id}">RESTORE VERSION</button>
                </div>
              `).join('')}
            </div>
          `);

          document.querySelectorAll('.btn-restore-rev').forEach(btn => {
            btn.addEventListener('click', async () => {
              if (confirm('Restore letter to this historical version?')) {
                await API.post(`/api/v1/posts/${this.activePostId}/revisions/${btn.dataset.revid}/restore`);
                App.closeModal();
                App.showToast('Historical revision restored.');
                EditorStudio.render(container, this.activePostId);
              }
            });
          });
        } catch (e) {
          alert('Could not load revisions: ' + e.message);
        }
      });
    }

    // Move to Trash
    const trashBtn = container.querySelector('#btn-trash-post');
    if (trashBtn) {
      trashBtn.addEventListener('click', async () => {
        if (confirm('Move this letter to the trash queue?')) {
          await API.put(`/api/v1/posts/${this.activePostId}/trash`);
          App.showToast('Letter moved to trash.');
          window.location.hash = '#/admin';
        }
      });
    }
  }
};
