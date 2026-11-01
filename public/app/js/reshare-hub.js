/**
 * DEADLETTERS RESHARE & RE-LETTER HUB
 * Decentralized Editorial Provenance & Curation System
 */

const ReshareHub = {
  async render(container) {
    try {
      const [streamRes, postsRes] = await Promise.all([
        API.get('/api/v1/reshares/stream?limit=30'),
        API.get('/api/v1/posts?type=post&status=publish&limit=50')
      ]);

      const reshares = streamRes.reshares || [];
      const posts = postsRes.posts || [];

      container.innerHTML = `
        <div class="dl-admin-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
                // ATELIER FEDERATION PROTOCOL //
              </div>
              <h2 style="font-size: 1.8rem; font-weight: 800;">RESHARE & SYNDICATION HUB</h2>
            </div>
            <button id="btn-toggle-composer" class="dl-btn dl-btn-accent">+ COMPOSE RE-LETTER</button>
          </div>

          <!-- Composer Box (Collapsible) -->
          <div id="reshare-composer-box" class="dl-card" style="margin-bottom: 2.5rem; display: none; border-color: var(--dl-accent);">
            <div class="dl-box-title" style="display: flex; justify-content: space-between;">
              <span>// RE-LETTER COMPOSITION ENVELOPE</span>
              <button id="btn-close-composer" class="dl-btn dl-btn-ghost dl-btn-sm" style="padding: 0;">✕</button>
            </div>

            <!-- Source Mode Tabs -->
            <div style="display: flex; gap: 1rem; margin-bottom: 1.25rem;">
              <button id="tab-src-local" class="dl-btn dl-btn-accent dl-btn-sm">LOCAL ATELIER DROP</button>
              <button id="tab-src-remote" class="dl-btn dl-btn-outline dl-btn-sm">EXTERNAL NODE URL</button>
            </div>

            <!-- Local Drop Picker -->
            <div id="source-local-pane" class="dl-form-group">
              <label class="dl-label">Select Atelier Letter to Reshare</label>
              <select id="select-local-post" class="dl-select">
                <option value="">-- Choose local transmission to quote --</option>
                ${posts.map(p => `
                  <option value="${p.ID}" data-title="${escapeHtml(p.post_title)}" data-author="${escapeHtml(p.author_name)}" data-excerpt="${escapeHtml(p.post_excerpt || '')}" data-img="${p.featured_image || ''}">
                    ${p.drop_code || 'DL'} // ${escapeHtml(p.post_title)} (by ${escapeHtml(p.author_name)})
                  </option>
                `).join('')}
              </select>
            </div>

            <!-- External Drop Importer -->
            <div id="source-remote-pane" class="dl-form-group" style="display: none;">
              <label class="dl-label">Paste External URL (Web, Substack, Peer Node)</label>
              <div style="display: flex; gap: 0.75rem;">
                <input id="input-external-url" class="dl-input" type="url" placeholder="https://raw.zine.club/letters/issue-01" />
                <button id="btn-fetch-meta" class="dl-btn dl-btn-outline dl-btn-sm" style="white-space: nowrap;">⚡ FETCH META</button>
              </div>
            </div>

            <!-- Quoted Preview Preview Envelope -->
            <div id="quoted-preview-pane" class="dl-quoted-envelope" style="margin-bottom: 1.25rem; display: none;">
              <div class="dl-quoted-source-header">
                <span id="preview-src-node">// deadplug://local</span>
                <span id="preview-src-author">by Operator</span>
              </div>
              <h4 id="preview-src-title" class="dl-quoted-title">Title</h4>
              <p id="preview-src-excerpt" class="dl-quoted-excerpt">Excerpt</p>
            </div>

            <!-- Curator Commentary Textarea -->
            <div class="dl-form-group">
              <label class="dl-label">Curator Commentary / Editorial Marginalia</label>
              <textarea id="curator-commentary" class="dl-textarea" placeholder="Add your perspective, critique, or contextual framing for the re-letter..."></textarea>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
              <button id="btn-broadcast-reshare" class="dl-btn dl-btn-accent">⚡ SIGN & BROADCAST RE-LETTER</button>
            </div>
          </div>

          <!-- Reshare Stream List -->
          <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            ${reshares.length === 0 ? `
              <div class="dl-card" style="text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono); padding: 3rem;">
                // NO RE-LETTERS IN FEED // USE THE COMPOSER TO CURATE YOUR FIRST RESHARE //
              </div>
            ` : reshares.map(r => `
              <article class="dl-reshare-card">
                <div class="dl-reshare-header">
                  <div class="dl-curator-info">
                    <img src="${r.curator_avatar || '/uploads/deadplug_operator_avatar.jpg'}" class="dl-avatar" />
                    <div>
                      <div class="dl-curator-name">${escapeHtml(r.curator_name || 'Operator')}</div>
                      <div class="dl-curator-node">// RE-LETTERED ON ${new Date(r.created_at).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span class="dl-badge dl-badge-cyan">PROVENANCE VERIFIED</span>
                    <button class="dl-btn dl-btn-ghost dl-btn-sm btn-inspect-sig" data-id="${r.reshare_id}" data-sig="${r.signature || ''}" data-chain='${escapeHtml(JSON.stringify(r.provenance_chain || []))}'>
                      INSPECT SIG
                    </button>
                  </div>
                </div>

                <div class="dl-reshare-body">
                  <div class="dl-curator-commentary">
                    "${escapeHtml(r.curator_commentary)}"
                  </div>

                  <!-- Quoted Envelope -->
                  <div class="dl-quoted-envelope">
                    <div class="dl-quoted-source-header">
                      <span>ORIGINAL TRANSMISSION // ${escapeHtml(r.source_node || 'deadplug://node')}</span>
                      <span>AUTHOR: ${escapeHtml(r.original_author)}</span>
                    </div>
                    <div class="dl-quoted-title">
                      <a href="#/letter/${r.post_name}">${escapeHtml(r.original_title)}</a>
                    </div>
                    <div class="dl-quoted-excerpt">
                      ${escapeHtml(r.original_excerpt)}
                    </div>
                  </div>
                </div>

                <div class="dl-provenance-bar">
                  <span>SIG HASH: ${r.signature ? r.signature.substring(0, 24) : 'DP-HASH-NIL'}...</span>
                  <span>RELAY HOPS: ${(r.provenance_chain || []).length} NODES</span>
                </div>
              </article>
            `).join('')}
          </div>
        </div>
      `;

      this.bindReshareEvents(container, posts);
    } catch (err) {
      container.innerHTML = `<div class="dl-admin-content"><div class="dl-card" style="border-color: var(--dl-crimson);">Error loading reshare hub: ${err.message}</div></div>`;
    }
  },

  bindReshareEvents(container, posts) {
    const composerBox = container.querySelector('#reshare-composer-box');
    const toggleBtn = container.querySelector('#btn-toggle-composer');
    const closeBtn = container.querySelector('#btn-close-composer');
    const tabLocal = container.querySelector('#tab-src-local');
    const tabRemote = container.querySelector('#tab-src-remote');
    const localPane = container.querySelector('#source-local-pane');
    const remotePane = container.querySelector('#source-remote-pane');
    const selectLocal = container.querySelector('#select-local-post');
    const previewPane = container.querySelector('#quoted-preview-pane');
    const previewTitle = container.querySelector('#preview-src-title');
    const previewAuthor = container.querySelector('#preview-src-author');
    const previewExcerpt = container.querySelector('#preview-src-excerpt');
    const commentaryInput = container.querySelector('#curator-commentary');
    const broadcastBtn = container.querySelector('#btn-broadcast-reshare');

    let stagedReshare = {
      sourcePostId: null,
      sourceUrl: null,
      sourceNode: 'deadplug://local',
      originalAuthor: '',
      originalTitle: '',
      originalExcerpt: '',
      featuredImage: null
    };

    toggleBtn.addEventListener('click', () => {
      composerBox.style.display = composerBox.style.display === 'none' ? 'block' : 'none';
    });

    closeBtn.addEventListener('click', () => {
      composerBox.style.display = 'none';
    });

    tabLocal.addEventListener('click', () => {
      tabLocal.className = 'dl-btn dl-btn-accent dl-btn-sm';
      tabRemote.className = 'dl-btn dl-btn-outline dl-btn-sm';
      localPane.style.display = 'block';
      remotePane.style.display = 'none';
    });

    tabRemote.addEventListener('click', () => {
      tabRemote.className = 'dl-btn dl-btn-accent dl-btn-sm';
      tabLocal.className = 'dl-btn dl-btn-outline dl-btn-sm';
      localPane.style.display = 'none';
      remotePane.style.display = 'block';
    });

    selectLocal.addEventListener('change', () => {
      const opt = selectLocal.selectedOptions[0];
      if (!opt || !opt.value) {
        previewPane.style.display = 'none';
        return;
      }
      stagedReshare.sourcePostId = opt.value;
      stagedReshare.sourceUrl = null;
      stagedReshare.sourceNode = 'deadplug://local';
      stagedReshare.originalTitle = opt.dataset.title;
      stagedReshare.originalAuthor = opt.dataset.author;
      stagedReshare.originalExcerpt = opt.dataset.excerpt;
      stagedReshare.featuredImage = opt.dataset.img;

      previewTitle.innerText = stagedReshare.originalTitle;
      previewAuthor.innerText = `by ${stagedReshare.originalAuthor}`;
      previewExcerpt.innerText = stagedReshare.originalExcerpt;
      previewPane.style.display = 'block';
    });

    // Remote meta fetch
    const fetchBtn = container.querySelector('#btn-fetch-meta');
    fetchBtn.addEventListener('click', async () => {
      const url = container.querySelector('#input-external-url').value.trim();
      if (!url) return alert('Enter a URL.');
      fetchBtn.disabled = true;
      fetchBtn.innerText = 'FETCHING...';
      try {
        const res = await API.post('/api/v1/reshares/import-external', { url });
        const d = res.data;
        stagedReshare.sourcePostId = null;
        stagedReshare.sourceUrl = d.sourceUrl;
        stagedReshare.sourceNode = d.sourceNode;
        stagedReshare.originalTitle = d.originalTitle;
        stagedReshare.originalAuthor = d.originalAuthor;
        stagedReshare.originalExcerpt = d.originalExcerpt;
        stagedReshare.featuredImage = d.featuredImage;

        previewTitle.innerText = stagedReshare.originalTitle;
        previewAuthor.innerText = `by ${stagedReshare.originalAuthor}`;
        previewExcerpt.innerText = stagedReshare.originalExcerpt;
        previewPane.style.display = 'block';
        App.showToast('External transmission metadata pulled.');
      } catch (e) {
        alert('Could not fetch URL: ' + e.message);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.innerText = '⚡ FETCH META';
      }
    });

    // Broadcast Reshare
    broadcastBtn.addEventListener('click', async () => {
      const commentary = commentaryInput.value.trim();
      if (!commentary) {
        alert('Curator commentary cannot be empty.');
        return;
      }
      if (!stagedReshare.sourcePostId && !stagedReshare.sourceUrl) {
        alert('Select or input a source letter to re-letter.');
        return;
      }

      broadcastBtn.disabled = true;
      broadcastBtn.innerText = '⚡ SIGNING & BROADCASTING...';

      try {
        await API.post('/api/v1/reshares', {
          ...stagedReshare,
          curatorCommentary: commentary
        });
        App.showToast('Re-letter successfully dropped into mesh.');
        this.render(container);
      } catch (err) {
        alert('Reshare broadcast failed: ' + err.message);
        broadcastBtn.disabled = false;
        broadcastBtn.innerText = '⚡ SIGN & BROADCAST RE-LETTER';
      }
    });

    // Inspect Signature Modal
    container.querySelectorAll('.btn-inspect-sig').forEach(btn => {
      btn.addEventListener('click', () => {
        const chain = JSON.parse(btn.dataset.chain || '[]');
        App.openModal(`
          <div class="dl-modal-header">
            <h3 style="font-size: 1.2rem;">CRYPTOGRAPHIC PROVENANCE ENVELOPE</h3>
            <button class="dl-modal-close" onclick="App.closeModal()">✕</button>
          </div>
          <div style="font-family: var(--dl-font-mono); font-size: 0.78rem;">
            <div style="margin-bottom: 1rem; color: var(--dl-accent);">
              HMAC-SHA256 SIGNATURE:
              <div style="color: #fff; word-break: break-all; margin-top: 0.25rem;">${btn.dataset.sig}</div>
            </div>
            <div style="margin-bottom: 0.5rem; color: var(--dl-text-muted);">RELAY HOP AUDIT:</div>
            <pre style="background: #000; padding: 1rem; border: 1px solid var(--dl-border); overflow-x: auto;">${JSON.stringify(chain, null, 2)}</pre>
          </div>
        `);
      });
    });
  }
};
