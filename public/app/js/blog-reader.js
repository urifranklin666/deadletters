/**
 * DEADLETTERS PUBLIC ATELIER BLOG READER
 * Cyber-Editorial Front-of-House Experience
 */

const BlogReader = {
  currentFilter: 'all',

  async render(container, routeParam = null) {
    if (routeParam) {
      return this.renderSingle(container, routeParam);
    }

    try {
      const postsRes = await API.get('/api/v1/posts?type=all&status=publish&limit=30');
      const settingsRes = await API.get('/api/v1/settings');
      const themesRes = await API.get('/api/v1/themes');

      const posts = postsRes.posts || [];
      const site = settingsRes || {};
      const activeTheme = themesRes.activeTheme;

      container.innerHTML = `
        <header class="dl-header">
          <div class="dl-container dl-header-inner">
            <div class="dl-brand-group">
              <a href="#/" class="dl-brand-logo">
                DEADLETTERS
                <span class="dl-brand-badge">ATELIER</span>
              </a>
              <div class="dl-mesh-beacon">
                <span class="dl-beacon-pulse"></span>
                <span>NODE // ${escapeHtml(site.site_node_handle || '@deadplug/node')}</span>
              </div>
            </div>

            <nav class="dl-nav-links">
              <a href="#/" class="dl-nav-link ${this.currentFilter === 'all' ? 'active' : ''}">DISPATCHES</a>
              <a href="#/reshares" class="dl-nav-link ${this.currentFilter === 'reshares' ? 'active' : ''}">RESHARE STREAM</a>
              <a href="#/feed" target="_blank" class="dl-nav-link">RSS</a>
              <a href="#/admin" class="dl-nav-link" style="color: var(--dl-accent);">CONTROL PANEL →</a>
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
              <button class="dl-badge ${this.currentFilter === 'reshare' ? 'dl-badge-cyan' : ''}" data-filter="reshare" style="cursor: pointer; padding: 4px 10px;">RE-LETTERS (RESHARES)</button>
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
              <a href="#/admin" style="color: var(--dl-accent);">OPERATOR LOGIN</a>
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
      container.innerHTML = `<div class="dl-container" style="padding: 4rem 1.5rem;"><div class="dl-card" style="border-color: var(--dl-crimson);">Error loading transmission: ${err.message}</div></div>`;
    }
  },

  renderPostsList(posts) {
    if (!posts || posts.length === 0) {
      return `<div style="grid-column: 1 / -1; padding: 3rem; text-align: center; color: var(--dl-text-muted); font-family: var(--dl-font-mono);">// NO LETTER TRANSMISSIONS RECORDED IN THIS SECTOR //</div>`;
    }

    return posts.map(p => {
      const isReshare = p.post_type === 'reshare';
      const featImg = p.featured_image || '/uploads/deadplug_editorial_cover.jpg';

      return `
        <article class="dl-post-card ${isReshare ? 'dl-card-reshare' : ''}">
          <div style="position: relative; overflow: hidden; height: 220px; background: #000;">
            <img src="${featImg}" alt="${escapeHtml(p.post_title)}" style="width: 100%; height: 100%; object-fit: cover; opacity: 0.88; transition: transform 0.4s var(--dl-ease-out);" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'" />
            <div style="position: absolute; top: 12px; left: 12px; display: flex; gap: 6px;">
              <span class="dl-drop-badge">${p.drop_code || 'DL-DROP'}</span>
              ${isReshare ? '<span class="dl-badge dl-badge-cyan">RE-LETTER</span>' : ''}
            </div>
          </div>

          <div style="padding: 1.5rem; display: flex; flex-direction: column; flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted); margin-bottom: 0.75rem;">
              <span>// ${new Date(p.post_date).toLocaleDateString()}</span>
              <span>${p.reading_time || 3} MIN READ</span>
            </div>

            <h2 style="font-size: 1.35rem; margin-bottom: 0.75rem; line-height: 1.25;">
              <a href="#/letter/${p.post_name}">${escapeHtml(p.post_title)}</a>
            </h2>

            <p style="font-size: 0.9rem; color: var(--dl-text-muted); line-height: 1.5; margin-bottom: 1.5rem; flex: 1;">
              ${escapeHtml(p.post_excerpt || '')}
            </p>

            <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--dl-border); padding-top: 1rem; margin-top: auto;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <img src="${p.author_avatar || '/uploads/deadplug_operator_avatar.jpg'}" style="width: 24px; height: 24px; border-radius: 50%;" />
                <span style="font-size: 0.75rem; font-weight: 600;">${escapeHtml(p.author_name || 'Operator')}</span>
              </div>
              <div style="display: flex; gap: 8px;">
                <button class="dl-btn dl-btn-outline dl-btn-sm btn-open-reshare" data-id="${p.ID}" data-title="${escapeHtml(p.post_title)}" data-author="${escapeHtml(p.author_name || 'Operator')}" data-excerpt="${escapeHtml(p.post_excerpt || '')}">
                  ↻ RE-LETTER
                </button>
                <a href="#/letter/${p.post_name}" class="dl-btn dl-btn-ghost dl-btn-sm">READ →</a>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  },

  async renderSingle(container, slug) {
    try {
      const res = await API.get(`/api/v1/posts/${slug}`);
      const post = res.post;
      const commentsRes = await API.get(`/api/v1/comments/post/${post.ID}`);
      const comments = commentsRes.comments || [];

      container.innerHTML = `
        <header class="dl-header">
          <div class="dl-container dl-header-inner">
            <div class="dl-brand-group">
              <a href="#/" class="dl-brand-logo">DEADLETTERS</a>
              <span class="dl-drop-badge">${post.drop_code || 'DL-DROP'}</span>
            </div>
            <nav class="dl-nav-links">
              <a href="#/" class="dl-nav-link">← RETURN TO DISPATCHES</a>
            </nav>
            <div class="dl-header-actions">
              <button id="btn-single-reshare" class="dl-btn dl-btn-accent dl-btn-sm">↻ RE-LETTER THIS DROP</button>
            </div>
          </div>
        </header>

        <article class="dl-container" style="max-width: 860px; padding-top: 3.5rem; padding-bottom: 6rem;">
          <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">
            <span>DROP CODE: <strong style="color: var(--dl-accent);">${post.drop_code}</strong></span>
            <span>//</span>
            <span>TRANSMITTED: ${new Date(post.post_date).toLocaleDateString()}</span>
            <span>//</span>
            <span>READ TIME: ${post.reading_time || 3} MIN</span>
          </div>

          <h1 style="font-size: clamp(2.2rem, 5vw, 3.5rem); margin-bottom: 1.5rem; line-height: 1.1;">
            ${escapeHtml(post.post_title)}
          </h1>

          <div style="display: flex; align-items: center; gap: 1rem; padding-bottom: 2rem; border-bottom: 1px solid var(--dl-border); margin-bottom: 2.5rem;">
            <img src="${post.author_avatar || '/uploads/deadplug_operator_avatar.jpg'}" style="width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--dl-accent);" />
            <div>
              <div style="font-weight: 700; font-size: 0.95rem;">${escapeHtml(post.author_name || 'Operator')}</div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-text-muted);">${escapeHtml(post.author_bio || 'Deadplug Digital Atelier Operator')}</div>
            </div>
          </div>

          ${post.featured_image ? `
            <div style="margin-bottom: 3rem; border: 1px solid var(--dl-border);">
              <img src="${post.featured_image}" alt="${escapeHtml(post.post_title)}" style="width: 100%; max-height: 500px; object-fit: cover;" />
            </div>
          ` : ''}

          <!-- Post Rendered Content -->
          <div class="dl-post-body" style="font-size: 1.15rem; line-height: 1.8; color: #dce0e8;">
            ${post.post_content_rendered}
          </div>

          <!-- Reshare Action Banner -->
          <div style="margin-top: 4rem; padding: 2rem; background: var(--dl-surface); border: 1px solid var(--dl-border-strong); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-accent); margin-bottom: 0.25rem;">// ATELIER RESHARING MESH</div>
              <div style="font-weight: 700; font-size: 1.1rem;">Reshare & Append Editorial Marginalia</div>
              <div style="font-size: 0.85rem; color: var(--dl-text-muted);">Quoting this drop preserves cryptographic provenance back to ${escapeHtml(post.author_name || 'Operator')}.</div>
            </div>
            <button id="btn-banner-reshare" class="dl-btn dl-btn-accent">↻ RE-LETTER DROP</button>
          </div>

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
                <button id="btn-submit-comment" class="dl-btn dl-btn-outline dl-btn-sm" data-postid="${post.ID}">TRANSMIT COMMENT</button>
              </div>
            </div>

            <!-- Comments List -->
            <div id="comments-list" style="display: flex; flex-direction: column; gap: 1rem;">
              ${comments.map(c => `
                <div style="padding: 1.25rem; background: var(--dl-surface); border: 1px solid var(--dl-border);">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-family: var(--dl-font-mono); font-size: 0.75rem;">
                    <strong style="color: var(--dl-accent);">${escapeHtml(c.comment_author)}</strong>
                    <span style="color: var(--dl-text-muted);">${new Date(c.comment_date).toLocaleString()}</span>
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
            await API.post('/api/v1/comments', {
              postId: post.ID,
              authorName: author || 'Anonymous Operator',
              authorEmail: email || 'anonymous@node.null',
              content: content.trim()
            });

            App.showToast('Transmission received by node.');
            this.renderSingle(container, slug);
          } catch (err) {
            alert('Failed to transmit: ' + err.message);
          }
        });
      }

    } catch (err) {
      container.innerHTML = `<div class="dl-container" style="padding: 4rem 1.5rem;"><div class="dl-card" style="border-color: var(--dl-crimson);">Letter not located in archive: ${err.message}</div></div>`;
    }
  },

  bindReaderEvents(container) {
    // Quick Theme Picker
    const picker = container.querySelector('#quick-theme-picker');
    if (picker) {
      picker.addEventListener('change', async (e) => {
        const newTheme = e.target.value;
        document.documentElement.setAttribute('data-theme', newTheme);
        App.applyThemeTokens(newTheme);
        App.showToast(`Active Theme shifted to ${newTheme}`);
      });
    }

    // Filter Buttons
    const filterBtns = container.querySelectorAll('[data-filter]');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        this.currentFilter = btn.dataset.filter;
        let url = '/api/v1/posts?type=all&status=publish';
        if (this.currentFilter === 'reshare') url = '/api/v1/posts?type=reshare&status=publish';
        if (this.currentFilter === 'manifesto') url = '/api/v1/posts?category=manifesto&status=publish';

        const res = await API.get(url);
        const grid = container.querySelector('#posts-grid');
        grid.innerHTML = this.renderPostsList(res.posts || []);
        this.bindCardButtons(container);
      });
    });

    this.bindCardButtons(container);
  },

  bindCardButtons(container) {
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}
