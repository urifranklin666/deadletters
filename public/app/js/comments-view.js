/**
 * DEADLETTERS COMMENT MODERATION QUEUE
 * Editorial moderation for operators with comments:moderate.
 *
 * The API returns up to 100 of the most recent comments. Filtering happens in
 * the browser so every status view is consistent with the same status=all read
 * and never sends an unsupported moderation filter value to the backend.
 */

const CommentsView = {
  status: 'all',
  comments: [],
  loaded: false,
  loadToken: 0,

  filterOptions: Object.freeze([
    { key: 'all', label: 'ALL' },
    { key: 'pending', label: 'PENDING' },
    { key: 'approved', label: 'APPROVED' },
    { key: 'spam', label: 'SPAM' },
    { key: 'trash', label: 'TRASH' }
  ]),

  statusInfo(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === '1' || raw === 'approved') {
      return { key: 'approved', label: 'APPROVED', color: 'var(--dl-emerald)' };
    }
    if (raw === '0' || raw === 'pending') {
      return { key: 'pending', label: 'PENDING', color: 'var(--dl-accent)' };
    }
    if (raw === 'spam') {
      return { key: 'spam', label: 'SPAM', color: 'var(--dl-crimson)' };
    }
    if (raw === 'trash') {
      return { key: 'trash', label: 'TRASH', color: 'var(--dl-crimson)' };
    }
    return {
      key: 'unknown',
      label: raw ? raw.toUpperCase() : 'UNKNOWN',
      color: 'var(--dl-text-muted)'
    };
  },

  dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  },

  styles() {
    return `
      <style>
        .dl-comments-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
          padding: 1rem 1.5rem;
          background: var(--dl-surface);
          border-bottom: 1px solid var(--dl-border);
        }
        .dl-comments-filters {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }
        .dl-comments-filter-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          background: var(--dl-black);
          border: 1px solid var(--dl-border-strong);
          color: var(--dl-text-muted);
          font-family: var(--dl-font-mono);
          font-size: 0.72rem;
          letter-spacing: 0.06em;
          padding: 0.42rem 0.7rem;
          cursor: pointer;
          transition: var(--dl-transition);
        }
        .dl-comments-filter-btn:hover {
          border-color: var(--dl-accent);
          color: var(--dl-text);
        }
        .dl-comments-filter-btn.active {
          border-color: var(--dl-accent);
          background: rgba(214, 255, 0, 0.12);
          color: var(--dl-accent);
        }
        .dl-comments-count {
          font-size: 0.66rem;
          color: var(--dl-text-faint);
        }
        .dl-comments-filter-btn.active .dl-comments-count {
          color: var(--dl-accent);
        }
        .dl-comments-table-wrap {
          width: 100%;
          overflow-x: auto;
        }
        .dl-comments-table {
          width: 100%;
          border-collapse: collapse;
          background: var(--dl-obsidian);
        }
        .dl-comments-table th,
        .dl-comments-table td {
          padding: 0.9rem 1rem;
          text-align: left;
          vertical-align: top;
          border-bottom: 1px solid var(--dl-border);
        }
        .dl-comments-table th {
          font-family: var(--dl-font-mono);
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--dl-text-muted);
          background: var(--dl-surface);
          white-space: nowrap;
        }
        .dl-comments-content-cell {
          min-width: 240px;
          max-width: 420px;
        }
        .dl-comments-body {
          max-height: 9rem;
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font-size: 0.88rem;
          line-height: 1.55;
        }
        .dl-comments-meta {
          font-family: var(--dl-font-mono);
          font-size: 0.7rem;
          color: var(--dl-text-muted);
          overflow-wrap: anywhere;
        }
        .dl-comments-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 0.35rem;
        }
        .dl-comments-state {
          padding: 3rem 1.5rem;
          text-align: center;
          font-family: var(--dl-font-mono);
          font-size: 0.82rem;
          color: var(--dl-text-muted);
          line-height: 1.7;
        }
        .dl-comments-error {
          margin: 1.25rem;
          padding: 1.25rem;
          border: 1px solid var(--dl-crimson);
          background: var(--dl-surface);
        }
        @media (max-width: 820px) {
          .dl-comments-table thead {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
          }
          .dl-comments-table,
          .dl-comments-table tbody,
          .dl-comments-table tr,
          .dl-comments-table td {
            display: block;
            width: 100%;
          }
          .dl-comments-table tr {
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--dl-border);
          }
          .dl-comments-table td {
            border: none;
            padding: 0.35rem 0;
          }
          .dl-comments-table td::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 0.2rem;
            font-family: var(--dl-font-mono);
            font-size: 0.65rem;
            letter-spacing: 0.08em;
            color: var(--dl-text-faint);
          }
          .dl-comments-content-cell {
            min-width: 0;
            max-width: none;
          }
          .dl-comments-actions {
            justify-content: flex-start;
            margin-top: 0.35rem;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .dl-comments-filter-btn,
          .dl-comments-table tr {
            transition: none !important;
          }
        }
      </style>
    `;
  },

  async render(container) {
    this.status = 'all';
    this.comments = [];
    this.loaded = false;
    this.renderShell(container);
    await this.load(container);
  },

  renderShell(container) {
    const filterButtons = this.filterOptions.map(option => `
      <button type="button"
        class="dl-comments-filter-btn ${option.key === this.status ? 'active' : ''}"
        data-status="${escapeHtml(option.key)}"
        aria-pressed="${option.key === this.status ? 'true' : 'false'}">
        ${escapeHtml(option.label)}
        <span class="dl-comments-count" data-count-for="${escapeHtml(option.key)}">0</span>
      </button>
    `).join('');

    container.innerHTML = `
      ${this.styles()}
      <div class="dl-admin-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
          <div>
            <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
              // EDITORIAL DISCUSSION CONTROL //
            </div>
            <h2 style="font-size: 1.8rem; font-weight: 800;">COMMENT MODERATION</h2>
            <p style="font-size: 0.82rem; color: var(--dl-text-muted); margin-top: 0.5rem; max-width: 760px; line-height: 1.6;">
              Review comments across every post on this node. The queue reads the most recent 100 comments; approve, return to pending, mark spam, or trash each record.
            </p>
          </div>
          <button id="btn-comments-refresh" class="dl-btn dl-btn-outline" type="button">↻ REFRESH QUEUE</button>
        </div>

        <div class="dl-card" style="padding: 0; overflow: hidden;">
          <div class="dl-comments-toolbar">
            <div class="dl-comments-filters" role="group" aria-label="Filter comments by moderation status">
              ${filterButtons}
            </div>
            <div id="comments-summary" class="dl-comments-meta" aria-live="polite">// LOADING //</div>
          </div>
          <div id="comments-list" aria-live="polite">
            <div class="dl-comments-state" role="status">// LOADING COMMENT QUEUE //</div>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#btn-comments-refresh').addEventListener('click', () => {
      this.load(container);
    });

    container.querySelectorAll('.dl-comments-filter-btn').forEach(button => {
      button.addEventListener('click', () => {
        if (!this.filterOptions.some(option => option.key === button.dataset.status)) return;
        this.status = button.dataset.status;
        this.updateFilterButtons(container);
        if (this.loaded) this.renderList(container);
      });
    });
  },

  updateFilterButtons(container) {
    container.querySelectorAll('.dl-comments-filter-btn').forEach(button => {
      const active = button.dataset.status === this.status;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  },

  async load(container) {
    const token = ++this.loadToken;
    const list = container.querySelector('#comments-list');
    const refreshButton = container.querySelector('#btn-comments-refresh');
    if (!list) return;

    this.loaded = false;
    list.innerHTML = '<div class="dl-comments-state" role="status">// LOADING COMMENT QUEUE //</div>';
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = '↻ LOADING...';
    }

    try {
      const res = await API.get('/api/v1/comments?status=all');
      if (token !== this.loadToken) return;

      this.comments = Array.isArray(res && res.comments) ? res.comments : [];
      this.loaded = true;
      this.renderList(container);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.comments = [];
      this.loaded = false;
      const summary = container.querySelector('#comments-summary');
      if (summary) summary.textContent = '// UNAVAILABLE //';
      list.innerHTML = `
        <div class="dl-comments-error" role="alert">
          <div class="dl-box-title" style="color: var(--dl-crimson);">// MODERATION FEED UNAVAILABLE //</div>
          <p style="font-size: 0.88rem; color: var(--dl-text-muted); line-height: 1.6; margin-bottom: 1rem;">
            ${escapeHtml(err.message || 'The comments endpoint did not respond.')}
          </p>
          <button id="btn-comments-retry" class="dl-btn dl-btn-outline dl-btn-sm" type="button">RETRY</button>
        </div>
      `;
      const retryButton = list.querySelector('#btn-comments-retry');
      if (retryButton) retryButton.addEventListener('click', () => this.load(container));
    } finally {
      if (token === this.loadToken && refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = '↻ REFRESH QUEUE';
      }
    }
  },

  filteredComments() {
    if (this.status === 'all') return this.comments;
    return this.comments.filter(comment => this.statusInfo(comment.comment_approved).key === this.status);
  },

  renderList(container) {
    const list = container.querySelector('#comments-list');
    if (!list) return;

    const counts = { all: this.comments.length, pending: 0, approved: 0, spam: 0, trash: 0 };
    this.comments.forEach(comment => {
      const key = this.statusInfo(comment.comment_approved).key;
      if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    });

    container.querySelectorAll('[data-count-for]').forEach(node => {
      const key = node.dataset.countFor;
      node.textContent = String(Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : 0);
    });

    const summary = container.querySelector('#comments-summary');
    const filtered = this.filteredComments();
    const activeLabel = (this.filterOptions.find(option => option.key === this.status) || { label: 'ALL' }).label;
    if (summary) {
      summary.textContent = `${filtered.length} SHOWN // ${counts.all} LOADED // FILTER: ${activeLabel}`;
    }

    if (this.comments.length === 0) {
      list.innerHTML = `
        <div class="dl-comments-state" role="status">
          // NO COMMENTS ON THIS NODE YET //<br />
          <span style="font-size: 0.74rem;">New discussions will appear here for moderation.</span>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      list.innerHTML = `
        <div class="dl-comments-state" role="status">
          // NO ${escapeHtml(activeLabel)} COMMENTS //<br />
          <span style="font-size: 0.74rem;">Select another moderation filter to review other records.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = `
      <div class="dl-comments-table-wrap">
        <table class="dl-comments-table">
          <thead>
            <tr>
              <th scope="col">AUTHOR</th>
              <th scope="col">CONTENT</th>
              <th scope="col">POST</th>
              <th scope="col">DATE</th>
              <th scope="col">STATUS</th>
              <th scope="col" style="text-align: right;">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(comment => this.renderRow(comment)).join('')}
          </tbody>
        </table>
      </div>
    `;

    list.querySelectorAll('.btn-comment-status').forEach(button => {
      button.addEventListener('click', () => this.moderate(container, button));
    });
  },

  renderRow(comment) {
    const info = this.statusInfo(comment.comment_approved);
    const author = comment.comment_author || 'Anonymous Operator';
    const email = comment.comment_author_email || '';
    const content = comment.comment_content || '';
    const postTitle = comment.post_title || `Post #${comment.comment_post_ID ?? 'unknown'}`;
    const postName = comment.post_name || '';
    const id = escapeHtml(String(comment.comment_ID ?? ''));

    const postLink = postName
      ? `<a href="#/letter/${escapeHtml(encodeURIComponent(postName))}" target="_blank" rel="noopener noreferrer">${escapeHtml(postTitle)}</a>`
      : escapeHtml(postTitle);

    return `
      <tr>
        <td data-label="AUTHOR">
          <div style="font-weight: 700; font-size: 0.9rem;">${escapeHtml(author)}</div>
          ${email ? `<div class="dl-comments-meta">${escapeHtml(email)}</div>` : ''}
        </td>
        <td class="dl-comments-content-cell" data-label="CONTENT">
          <div class="dl-comments-body">${escapeHtml(content)}</div>
        </td>
        <td data-label="POST">
          <div style="font-size: 0.88rem; line-height: 1.5;">${postLink}</div>
        </td>
        <td class="dl-comments-meta" data-label="DATE">${escapeHtml(this.dateText(comment.comment_date))}</td>
        <td data-label="STATUS">
          <span class="dl-badge" style="border-color: ${info.color}; color: ${info.color};">${escapeHtml(info.label)}</span>
        </td>
        <td data-label="ACTIONS">
          <div class="dl-comments-actions">
            ${this.renderActions(comment, info, id)}
          </div>
        </td>
      </tr>
    `;
  },

  renderActions(comment, info, id) {
    const actions = [];
    const add = (status, label, classes, destructive = false) => {
      actions.push(`
        <button type="button"
          class="dl-btn ${classes} dl-btn-sm btn-comment-status"
          data-id="${id}"
          data-status="${escapeHtml(status)}"
          data-destructive="${destructive ? 'true' : 'false'}"
          data-author="${escapeHtml(String(comment.comment_author || 'Anonymous Operator').slice(0, 120))}">
          ${escapeHtml(label)}
        </button>
      `);
    };

    if (info.key !== 'approved') add('1', 'APPROVE', 'dl-btn-accent');
    if (info.key !== 'pending') add('0', 'PENDING', 'dl-btn-outline');
    if (info.key !== 'spam') add('spam', 'SPAM', 'dl-btn-danger', true);
    if (info.key !== 'trash') add('trash', 'TRASH', 'dl-btn-danger', true);

    return actions.join('');
  },

  async moderate(container, button) {
    const nextStatus = button.dataset.status;
    const nextInfo = this.statusInfo(nextStatus);
    const author = button.dataset.author || 'Anonymous Operator';

    if (button.dataset.destructive === 'true') {
      const confirmed = await App.confirmAction({
        title: `MARK COMMENT AS ${nextInfo.label}`,
        message: `Mark this comment by ${author} as ${nextInfo.label}? This removes it from the approved public thread.`,
        confirmLabel: `MARK ${nextInfo.label}`,
        danger: true
      });
      if (!confirmed) return;
    }

    button.disabled = true;
    try {
      await API.put(`/api/v1/comments/${encodeURIComponent(button.dataset.id)}/status`, {
        status: nextStatus
      });
      const comment = this.comments.find(item => String(item.comment_ID) === String(button.dataset.id));
      if (comment) comment.comment_approved = nextStatus;
      App.showToast(`Comment moved to ${nextInfo.label.toLowerCase()}.`);
      this.renderList(container);
    } catch (err) {
      button.disabled = false;
      App.showToast(`Moderation failed: ${err.message}`);
    }
  }
};
