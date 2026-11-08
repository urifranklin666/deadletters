/**
 * DEADLETTERS PUBLIC ATELIER BLOG READER
 * Cyber-Editorial Front-of-House Experience
 */

const BlogReader = {
  currentFilter: 'all',
  resharesEnabled: true,
  perPage: 12,

  async render(container, routeParam = null) {
    if (routeParam) {
      return this.renderSingle(container, routeParam);
    }

    try {
      const settingsRes = await API.get('/api/v1/settings');
      const site = settingsRes || {};

      if (site.front_page_display === 'page' && Number(site.page_on_front) > 0) {
        try {
          const front = await API.get(`/api/v1/posts/${encodeURIComponent(site.page_on_front)}`);
          if (front?.post?.post_status === 'publish' && front.post.post_type === 'page') {
            return this.renderSingle(container, front.post.post_name);
          }
        } catch {
          // Fall back to the configured dispatch stream if the front page is unavailable.
        }
      }

      const postType = this.currentFilter === 'reshare' ? 'reshare' : 'all';
      const rawPerPage = Number.parseInt(site.posts_per_page, 10);
      const perPage = Number.isFinite(rawPerPage) ? Math.min(Math.max(rawPerPage, 1), 100) : 12;
      const [postsRes, themesRes] = await Promise.all([
        API.get(`/api/v1/posts?type=${postType}&status=publish&limit=${perPage}`),
        API.get('/api/v1/themes')
      ]);

      const posts = (postsRes.posts || []).slice(0, perPage);
      const activeTheme = themesRes.activeTheme;
      this.perPage = perPage;
      this.resharesEnabled = String(site.reshares_enabled ?? '1') !== '0';

      container.innerHTML = `
        <header class="dl-header">
          <div class="dl-container dl-header-inner">
            <div class="dl-brand-group">
              <a href="/" class="dl-brand-logo">
                DEADLETTERS
                <span class="dl-brand-badge">ATELIER</span>
              </a>
              <div class="dl-mesh-beacon">
                <span class="dl-beacon-pulse"></span>
                <span>NODE // ${escapeHtml(site.site_node_handle || '@deadplug/node')}</span>
              </div>
            </div>

            <nav class="dl-nav-links">
              <a href="/" class="dl-nav-link ${this.currentFilter === 'all' ? 'active' : ''}">DISPATCHES</a>
              ${this.resharesEnabled ? `<a href="/reshares" class="dl-nav-link ${this.currentFilter === 'reshare' ? 'active' : ''}">RESHARE STREAM</a>` : ''}
              <a href="/feed" target="_blank" rel="noopener" class="dl-nav-link">RSS</a>
              <a href="/admin" class="dl-nav-link" style="color: var(--dl-accent);">CONTROL PANEL →</a>
            </nav>

            <div class="dl-header-actions">
              <select id="quick-theme-picker" class="dl-select dl-btn-sm" style="width: auto; padding: 0.3rem 0.6rem; font-family: var(--dl-font-mono); font-size: 0.72rem;">
                <option value="deadplug-editorial" ${activeTheme === 'deadplug-editorial' ? 'selected' : ''}>DEADPLUG EDITORIAL</option>
                <option value="monolith-cyberpunk" ${activeTheme === 'monolith-cyberpunk' ? 'selected' : ''}>MONOLITH MATRIX</option>
                <option value="suisse-minimal" ${activeTheme === 'suisse-minimal' ? 'selected' : ''}>SUISSE MINIMAL</option>
              </select>
            </div>
          </div>
        </header>

        <main class="dl-container" style="padding-top: 3.5rem; padding-bottom: 5rem;">
          <!-- Editorial Hero -->
          <section style="margin-bottom: 3.5rem; border-bottom: 1px solid var(--dl-border); padding-bottom: 2.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem;">
              <div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-accent); letter-spacing: 0.15em; margin-bottom: 0.5rem;">
                  // DEADPLUG DIGITAL TRANSMISSION FREQUENCY //
                </div>
                <h1 class="dl-hero-title">${escapeHtml(site.site_title || 'DEADLETTERS')}</h1>
              </div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.8rem; color: var(--dl-text-muted); text-align: right;">
                <div>${escapeHtml(site.site_tagline || 'the plug is dead. stay wired.')}</div>
                <div style="color: var(--dl-text-faint); font-size: 0.72rem; margin-top: 0.25rem;">SYNDICATION PROTOCOL v1.0.0</div>
              </div>
            </div>

            <!-- Category / Filter Navigation -->
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 2rem;">
              <button class="dl-badge ${this.currentFilter === 'all' ? 'dl-badge-accent' : ''}" data-filter="all" style="cursor: pointer; padding: 4px 10px;">ALL DROPS</button>
              <button class="dl-badge ${this.currentFilter === 'manifesto' ? 'dl-badge-accent' : ''}" data-filter="manifesto" style="cursor: pointer; padding: 4px 10px;">MANIFESTOS</button>
              ${this.resharesEnabled ? `<button class="dl-badge ${this.currentFilter === 'reshare' ? 'dl-badge-cyan' : ''}" data-filter="reshare" style="cursor: pointer; padding: 4px 10px;">RE-LETTERS (RESHARES)</button>` : ''}
              <button class="dl-badge" data-filter="atelier-architecture" style="cursor: pointer; padding: 4px 10px;">ATELIER ARCHITECTURE</button>
            </div>
          </section>

          <!-- Posts Grid -->
          <section id="posts-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 2rem;">
            ${this.renderPostsList(posts)}
          </section>
        </main>

        <footer style="border-top: 1px solid var(--dl-border); padding: 3rem 0; background: var(--dl-obsidian); margin-top: auto;">
          <div class="dl-container" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1.5rem;">
            <div>
              <div style="font-family: var(--dl-font-heading); font-weight: 800; font-size: 1rem; letter-spacing: -0.02em;">DEADLETTERS ENGINE</div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">CREATED BY DEADPLUG.DIGITAL // RUNNING ON ZERO PHP</div>
            </div>
            <div style="display: flex; gap: 1.5rem; font-family: var(--dl-font-mono); font-size: 0.75rem;">
              <a href="/wp-json/wp/v2/posts" target="_blank" style="color: var(--dl-text-muted);">WP-JSON API</a>
              <a href="/feed" target="_blank" style="color: var(--dl-text-muted);">RSS 2.0</a>
              <a href="/feed/json" target="_blank" style="color: var(--dl-text-muted);">JSON FEED</a>
              <a href="/sitemap.xml" target="_blank" style="color: var(--dl-text-muted);">SITEMAP</a>
              <a href="/admin" style="color: var(--dl-accent);">OPERATOR LOGIN</a>
            </div>
          </div>
        </footer>
      `;

      this.bindReaderEvents(container);
    } catch (err) {
      if (err.message && err.message.includes('503')) {
        window.location.hash = '#/installer';
        return;
      }
      container.innerHTML = `<div class="dl-container" style="padding: 4rem 1.5rem;"><div class="dl-card" style="border-color: var(--dl-crimson);">Error loading transmission: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  renderPostsList(posts) {
    if (!posts || posts.length === 0) {
      return `<div style="grid-column: 1 / -1; padding: 3rem; text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono);">// NO LETTER TRANSMISSIONS RECORDED IN THIS SECTOR //</div>`;
    }

    const canReshare = this.resharesEnabled && typeof App !== 'undefined' && App.can('reshares:create');

    return posts.map(p => {
      const isReshare = p.post_type === 'reshare';
      const featImg = safeUrl(p.featured_image, '/uploads/deadplug_editorial_cover.jpg');
      const authorAvatar = safeUrl(p.author_avatar, '/uploads/deadplug_operator_avatar.jpg');
      const postSlug = encodeURIComponent(p.post_name || '');
      const postPath = `/${p.post_type === 'page' ? 'page' : 'letter'}/${postSlug}`;

      return `
        <article class="dl-post-card ${isReshare ? 'dl-card-reshare' : ''}">
          <div style="position: relative; overflow: hidden; height: 220px; background: #000;">
            <img class="dl-post-card-image" src="${escapeHtml(featImg)}" alt="${escapeHtml(p.post_title)}" style="width: 100%; height: 100%; object-fit: cover; opacity: 0.88; transition: transform 0.4s var(--dl-ease-out);" />
            <div style="position: absolute; top: 12px; left: 12px; display: flex; gap: 6px;">
              <span class="dl-drop-badge">${escapeHtml(p.drop_code || 'DL-DROP')}</span>
              ${isReshare ? '<span class="dl-badge dl-badge-cyan">RE-LETTER</span>' : ''}
            </div>
          </div>

          <div style="padding: 1.5rem; display: flex; flex-direction: column; flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted); margin-bottom: 0.75rem;">
              <span>// ${escapeHtml(new Date(p.post_date).toLocaleDateString())}</span>
              <span>${escapeHtml(p.reading_time || 3)} MIN READ</span>
            </div>

            <h2 style="font-size: 1.35rem; margin-bottom: 0.75rem; line-height: 1.25;">
              <a href="${escapeHtml(postPath)}">${escapeHtml(p.post_title)}</a>
            </h2>

            <p style="font-size: 0.9rem; color: var(--dl-text-muted); line-height: 1.5; margin-bottom: 1.5rem; flex: 1;">
              ${escapeHtml(p.post_excerpt || '')}
            </p>

            <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--dl-border); padding-top: 1rem; margin-top: auto;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <img src="${escapeHtml(authorAvatar)}" style="width: 24px; height: 24px; border-radius: 50%;" />
                <span style="font-size: 0.75rem; font-weight: 600;">${escapeHtml(p.author_name || 'Operator')}</span>
              </div>
              <div style="display: flex; gap: 8px;">
                ${canReshare ? `
                  <button class="dl-btn dl-btn-outline dl-btn-sm btn-open-reshare" data-id="${escapeHtml(p.ID)}" data-title="${escapeHtml(p.post_title)}" data-author="${escapeHtml(p.author_name || 'Operator')}" data-excerpt="${escapeHtml(p.post_excerpt || '')}">
                    ↻ RE-LETTER
                  </button>
                ` : ''}
                <a href="${escapeHtml(postPath)}" class="dl-btn dl-btn-ghost dl-btn-sm">READ →</a>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  },

  async renderSingle(container, slug) {
    try {
      const res = await API.get(`/api/v1/posts/${encodeURIComponent(slug)}`);
      const post = res.post;
      const reshare = post.post_type === 'reshare' ? post.reshare_details : null;
      const provenanceId = reshare ? (reshare.reshare_id || reshare.post_id || post.ID) : null;
      const provenanceRequest = provenanceId
        ? API.get(`/api/v1/reshares/provenance/${encodeURIComponent(provenanceId)}`).catch(() => null)
        : Promise.resolve(null);
      const [commentsRes, provenance, settings] = await Promise.all([
        API.get(`/api/v1/comments/post/${encodeURIComponent(post.ID)}`),
        provenanceRequest,
        API.get('/api/v1/settings')
      ]);
      const comments = commentsRes.comments || [];
      this.resharesEnabled = String(settings?.reshares_enabled ?? '1') !== '0';
      const canReshare = this.resharesEnabled && typeof App !== 'undefined' && App.can('reshares:create');
      const authorAvatar = safeUrl(post.author_avatar, '/uploads/deadplug_operator_avatar.jpg');
      const featuredImage = safeUrl(post.featured_image);
      const postBody = reshare
        ? this.renderResharePresentation(post, reshare, provenance)
        : `<div class="dl-post-body" style="font-size: 1.15rem; line-height: 1.8; color: #dce0e8;">${post.post_content_rendered}</div>`;

      container.innerHTML = `
        <header class="dl-header">
          <div class="dl-container dl-header-inner">
            <div class="dl-brand-group">
              <a href="/" class="dl-brand-logo">DEADLETTERS</a>
              <span class="dl-drop-badge">${escapeHtml(post.drop_code || 'DL-DROP')}</span>
            </div>
            <nav class="dl-nav-links">
              <a href="/" class="dl-nav-link">← RETURN TO DISPATCHES</a>
            </nav>
            <div class="dl-header-actions">
              ${canReshare ? '<button id="btn-single-reshare" class="dl-btn dl-btn-accent dl-btn-sm">↻ RE-LETTER THIS DROP</button>' : ''}
            </div>
          </div>
        </header>

        <article class="dl-container" style="max-width: 860px; padding-top: 3.5rem; padding-bottom: 6rem;">
          <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
            <span>DROP CODE: <strong style="color: var(--dl-accent);">${escapeHtml(post.drop_code)}</strong></span>
            <span>//</span>
            <span>TRANSMITTED: ${escapeHtml(new Date(post.post_date).toLocaleDateString())}</span>
            <span>//</span>
            <span>READ TIME: ${escapeHtml(post.reading_time || 3)} MIN</span>
          </div>

          <h1 style="font-size: clamp(2.2rem, 5vw, 3.5rem); margin-bottom: 1.5rem; line-height: 1.1;">
            ${escapeHtml(post.post_title)}
          </h1>

          <div style="display: flex; align-items: center; gap: 1rem; padding-bottom: 2rem; border-bottom: 1px solid var(--dl-border); margin-bottom: 2.5rem;">
            <img src="${escapeHtml(authorAvatar)}" style="width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--dl-accent);" />
            <div>
              <div style="font-weight: 700; font-size: 0.95rem;">${escapeHtml(post.author_name || 'Operator')}</div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">${escapeHtml(post.author_bio || 'Deadplug Digital Atelier Operator')}</div>
            </div>
          </div>

          ${featuredImage ? `
            <div style="margin-bottom: 3rem; border: 1px solid var(--dl-border);">
              <img src="${escapeHtml(featuredImage)}" alt="${escapeHtml(post.post_title)}" style="width: 100%; max-height: 500px; object-fit: cover;" />
            </div>
          ` : ''}

          <!-- Standard post HTML is sanitized by the server. Re-letters use a
               dedicated quoted-source view with escaped curator commentary. -->
          ${postBody}

          <!-- Reshare Action Banner -->
          ${canReshare ? `
            <div style="margin-top: 4rem; padding: 2rem; background: var(--dl-surface); border: 1px solid var(--dl-border-strong); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
              <div>
                <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-accent); margin-bottom: 0.25rem;">// LOCAL RE-LETTER RECORD</div>
                <div style="font-weight: 700; font-size: 1.1rem;">Reshare & Append Editorial Marginalia</div>
                <div style="font-size: 0.85rem; color: var(--dl-text-muted);">Re-lettering appends a locally verifiable provenance record on this node; it does not prove cross-node identity.</div>
              </div>
              <button id="btn-banner-reshare" class="dl-btn dl-btn-accent">↻ RE-LETTER DROP</button>
            </div>
          ` : ''}

          <!-- Discussion Section -->
          <section style="margin-top: 4rem; border-top: 1px solid var(--dl-border); padding-top: 2.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
              <h3 style="font-size: 1.4rem;">DISCUSSIONS // ${comments.length}</h3>
              <span class="dl-badge">${post.comment_status === 'open' ? 'TRANSMISSIONS OPEN' : 'CLOSED'}</span>
            </div>

            <!-- Submit Comment Form -->
            <div class="dl-card" style="margin-bottom: 2.5rem;">
              <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted); margin-bottom: 1rem;">// DISPATCH THOUGHT TO NODE OPERATOR</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <input id="comment-author" class="dl-input" type="text" placeholder="Operator Call-Sign / Name" />
                <input id="comment-email" class="dl-input" type="email" placeholder="Email Frequency (Private)" />
              </div>
              <textarea id="comment-content" class="dl-textarea" placeholder="State your critique, inquiry, or transmission..." style="min-height: 90px; margin-bottom: 1rem;"></textarea>
              <div style="display: flex; justify-content: flex-end;">
                <button id="btn-submit-comment" class="dl-btn dl-btn-outline dl-btn-sm" data-postid="${escapeHtml(post.ID)}">TRANSMIT COMMENT</button>
              </div>
              <div id="comment-feedback" role="status" style="font-size: 0.8rem; color: var(--dl-text-muted); margin-top: 0.75rem;"></div>
            </div>

            <!-- Comments List -->
            <div id="comments-list" style="display: flex; flex-direction: column; gap: 1rem;">
              ${comments.map(c => `
                <div style="padding: 1.25rem; background: var(--dl-surface); border: 1px solid var(--dl-border);">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-family: var(--dl-font-mono); font-size: 0.75rem;">
                    <strong style="color: var(--dl-accent);">${escapeHtml(c.comment_author)}</strong>
                    <span style="color: var(--dl-text-muted);">${escapeHtml(new Date(c.comment_date).toLocaleString())}</span>
                  </div>
                  <div style="font-size: 0.95rem; color: var(--dl-text); line-height: 1.6;">${escapeHtml(c.comment_content)}</div>
                </div>
              `).join('')}
            </div>
          </section>
        </article>
      `;

      // Event handlers for reshare buttons
      const handleReshare = () => {
        App.openReshareModal({
          sourcePostId: post.ID,
          title: post.post_title,
          author: post.author_name,
          excerpt: post.post_excerpt
        });
      };

      const b1 = container.querySelector('#btn-single-reshare');
      const b2 = container.querySelector('#btn-banner-reshare');
      if (b1) b1.addEventListener('click', handleReshare);
      if (b2) b2.addEventListener('click', handleReshare);

      // Comment submission
      const commentBtn = container.querySelector('#btn-submit-comment');
      if (commentBtn) {
        commentBtn.addEventListener('click', async () => {
          const author = container.querySelector('#comment-author').value;
          const email = container.querySelector('#comment-email').value;
          const content = container.querySelector('#comment-content').value;

          if (!content || !content.trim()) {
            alert('Comment transmission cannot be empty.');
            return;
          }

          try {
            const result = await API.post('/api/v1/comments', {
              postId: post.ID,
              authorName: author || 'Anonymous Operator',
              authorEmail: email || 'anonymous@node.null',
              content: content.trim()
            });
            const isApproved = String(result.comment?.comment_approved) === '1';
            const message = result.message || (isApproved
              ? 'Comment dispatched to frequency.'
              : 'Comment received and pending operator moderation.');

            App.showToast(message);
            if (isApproved) {
              this.renderSingle(container, slug);
            } else {
              container.querySelector('#comment-feedback').textContent = message;
              container.querySelector('#comment-content').value = '';
            }
          } catch (err) {
            alert('Failed to transmit: ' + err.message);
          }
        });
      }

    } catch (err) {
      container.innerHTML = `<div class="dl-container" style="padding: 4rem 1.5rem;"><div class="dl-card" style="border-color: var(--dl-crimson);">Letter not located in archive: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  renderResharePresentation(post, reshare, provenance) {
    const scope = provenance?.verification_scope || 'unavailable';
    const status = provenance?.verification_status;
    const integrity = scope === 'deadletters-ed25519-v1'
      ? (status === 'verified'
        ? { label: 'NODE ENVELOPE VERIFIED', color: 'var(--dl-cyan)' }
        : status === 'invalid'
          ? { label: 'NODE ENVELOPE INVALID', color: 'var(--dl-crimson)' }
          : { label: 'NODE KEY UNVERIFIED', color: 'var(--dl-text-muted)' })
      : (scope === 'local-integrity' && provenance?.signature_valid === true
        ? { label: 'LEGACY LOCAL INTEGRITY VERIFIED', color: 'var(--dl-cyan)' }
        : (scope === 'local-integrity' && provenance?.signature_valid === false
          ? { label: 'LEGACY LOCAL INTEGRITY INVALID', color: 'var(--dl-crimson)' }
          : { label: 'UNVERIFIED', color: 'var(--dl-text-muted)' }));
    const integrityNote = scope === 'deadletters-ed25519-v1'
      ? 'Ed25519 verification authenticates this node\'s signed envelope and its bound fields. It does not prove factual authorship or authorization of an arbitrary external source.'
      : 'Legacy verification covers only this installation\'s stored HMAC signature and provenance fields. It is not cross-node identity proof.';
    const sourceUrl = safeUrl(provenance?.source_url || reshare.source_url);
    const sourceNode = provenance?.source_node || reshare.source_node || 'Unknown source node';
    const chain = Array.isArray(provenance?.provenance_chain)
      ? provenance.provenance_chain
      : (Array.isArray(reshare.provenance_chain) ? reshare.provenance_chain : []);
    const reshareId = provenance?.reshare_id || reshare.reshare_id || reshare.post_id || post.ID;
    const originalTitle = reshare.original_title || post.post_title || 'Untitled original letter';
    const originalAuthor = reshare.original_author || 'Unknown original author';
    const originalExcerpt = reshare.original_excerpt || 'No original excerpt was preserved.';
    const commentary = reshare.curator_commentary || post.post_content || 'No curator commentary was preserved.';

    const chainItems = chain.length
      ? chain.slice(0, 20).map((entry, index) => `
        <li style="padding: 0.85rem 0; border-top: 1px solid var(--dl-border);">
          <div style="display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
            <strong style="color: var(--dl-accent);">${escapeHtml(index + 1)} // ${escapeHtml(entry?.action || 'recorded_event')}</strong>
            <span>${escapeHtml(entry?.timestamp || 'Timestamp unavailable')}</span>
          </div>
          <div style="margin-top: 0.35rem; color: var(--dl-text-muted); overflow-wrap: anywhere;">
            NODE: ${escapeHtml(entry?.node || 'Unknown node')}
            ${entry?.author ? ` // AUTHOR: ${escapeHtml(entry.author)}` : ''}
            ${entry?.curator_id !== undefined ? ` // CURATOR ID: ${escapeHtml(entry.curator_id)}` : ''}
          </div>
        </li>
      `).join('')
      : '<li style="padding: 0.85rem 0; border-top: 1px solid var(--dl-border);">No provenance entries were returned.</li>';

    return `
      <section aria-label="Quoted original letter" style="margin-bottom: 2.5rem;">
        <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-cyan); letter-spacing: 0.12em; margin-bottom: 0.75rem;">
          // RE-LETTER // QUOTED ORIGINAL TRANSMISSION
        </div>
        <blockquote class="dl-quoted-envelope" style="margin: 0;">
          <div class="dl-quoted-source-header">
            <span>ORIGINAL LETTER</span>
            <span>BY ${escapeHtml(originalAuthor)}</span>
          </div>
          <h2 class="dl-quoted-title" style="margin: 1rem 0 0.75rem;">${escapeHtml(originalTitle)}</h2>
          <p class="dl-quoted-excerpt" style="white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(originalExcerpt)}</p>
          <div style="margin-top: 1.25rem; overflow-wrap: anywhere;">
            ${sourceUrl
              ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow" style="color: var(--dl-cyan);">OPEN ORIGINAL SOURCE ↗</a><div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-text-muted); margin-top: 0.45rem;">${escapeHtml(sourceUrl)}</div>`
              : '<span style="color: var(--dl-text-muted);">ORIGINAL SOURCE LINK UNAVAILABLE</span>'}
          </div>
        </blockquote>
      </section>

      <section aria-label="Curator commentary" style="margin-bottom: 3rem; padding: 1.5rem; border-left: 3px solid var(--dl-accent); background: var(--dl-surface);">
        <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-accent); margin-bottom: 0.85rem;">
          // CURATOR COMMENTARY // ${escapeHtml(post.author_name || 'Local curator')}
        </div>
        <div style="font-size: 1.1rem; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(commentary)}</div>
      </section>

      <aside id="reshare-provenance" aria-label="Re-letter provenance summary" style="margin: 3rem 0; padding: 1.5rem; border: 1px solid var(--dl-border-strong); background: var(--dl-obsidian); font-family: var(--dl-font-mono); font-size: 0.75rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;">
          <strong>PROVENANCE SUMMARY // RE-LETTER ${escapeHtml(reshareId)}</strong>
          <strong id="reshare-integrity-status" style="color: ${integrity.color}; letter-spacing: 0.08em;">${integrity.label}</strong>
        </div>
        <p style="line-height: 1.6; color: var(--dl-text-muted); margin-bottom: 1rem;">
          ${escapeHtml(integrityNote)}
        </p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; overflow-wrap: anywhere;">
          <span>SOURCE NODE: ${escapeHtml(sourceNode)}</span>
          <span>CHAIN ENTRIES: ${escapeHtml(chain.length)}</span>
          <span>VERIFICATION SCOPE: ${escapeHtml(scope)}</span>
          ${provenance?.key_id ? `<span>KEY ID: ${escapeHtml(provenance.key_id)}</span>` : ''}
          ${provenance?.envelope_hash ? `<span>ENVELOPE: ${escapeHtml(provenance.envelope_hash)}</span>` : ''}
          ${provenance?.parent_envelope_hash ? `<span>PARENT: ${escapeHtml(provenance.parent_envelope_hash)}</span>` : ''}
          ${provenance?.reason ? `<span>REASON: ${escapeHtml(provenance.reason)}</span>` : ''}
        </div>
        <ol style="list-style: none; padding: 0; margin: 0;">${chainItems}</ol>
      </aside>
    `;
  },

  bindReaderEvents(container) {
    // Quick Theme Picker
    const picker = container.querySelector('#quick-theme-picker');
    if (picker) {
      picker.addEventListener('change', async (e) => {
        const newTheme = e.target.value;
        try {
          const theme = await App.previewTheme(newTheme);
          if (!theme) throw new Error('Theme is not installed.');
          App.showToast(`Theme preview: ${newTheme} (not saved)`);
        } catch (error) {
          App.showToast('Theme preview failed: ' + error.message);
        }
      });
    }

    // Filter Buttons
    const filterBtns = container.querySelectorAll('[data-filter]');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        this.currentFilter = btn.dataset.filter;
        const limit = this.perPage;
        let url = `/api/v1/posts?type=all&status=publish&limit=${limit}`;
        if (this.currentFilter === 'reshare') url = `/api/v1/posts?type=reshare&status=publish&limit=${limit}`;
        if (this.currentFilter === 'manifesto') url = `/api/v1/posts?category=manifesto&status=publish&limit=${limit}`;
        if (this.currentFilter === 'atelier-architecture') url = `/api/v1/posts?category=atelier-architecture&status=publish&limit=${limit}`;

        const res = await API.get(url);
        const grid = container.querySelector('#posts-grid');
        grid.innerHTML = this.renderPostsList((res.posts || []).slice(0, limit));
        this.bindCardButtons(container);
      });
    });

    this.bindCardButtons(container);
  },

  bindCardButtons(container) {
    container.querySelectorAll('.dl-post-card-image').forEach(img => {
      img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.05)'; });
      img.addEventListener('mouseleave', () => { img.style.transform = 'scale(1)'; });
    });

    const reshareBtns = container.querySelectorAll('.btn-open-reshare');
    reshareBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        App.openReshareModal({
          sourcePostId: btn.dataset.id,
          title: btn.dataset.title,
          author: btn.dataset.author,
          excerpt: btn.dataset.excerpt
        });
      });
    });
  }
};
