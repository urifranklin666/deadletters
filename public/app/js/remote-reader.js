/**
 * Deadletters public remote exchange.
 *
 * Only superadmin-promoted envelopes from trusted federation peers are shown.
 * These items are not local posts and never claim local authorship.
 */

const RemoteReader = {
  async render(container) {
    try {
      const [remoteRes, settingsRes, themesRes] = await Promise.all([
        API.get('/api/v1/remote?limit=50'),
        API.get('/api/v1/settings'),
        API.get('/api/v1/themes')
      ]);
      const items = Array.isArray(remoteRes.remote) ? remoteRes.remote : [];
      const site = settingsRes || {};
      const activeTheme = themesRes.activeTheme;

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
                <span>REMOTE // ${escapeHtml(String(remoteRes.total || items.length))} CURATED</span>
              </div>
            </div>

            <nav class="dl-nav-links" aria-label="Public navigation">
              <a href="/" class="dl-nav-link">DISPATCHES</a>
              <a href="/reshares" class="dl-nav-link">RESHARE STREAM</a>
              <a href="/remote" class="dl-nav-link active" aria-current="page">REMOTE EXCHANGE</a>
              <a href="/feed" target="_blank" rel="noopener" class="dl-nav-link">RSS</a>
              <a href="/admin" class="dl-nav-link" style="color: var(--dl-accent);">CONTROL PANEL →</a>
            </nav>

            <div class="dl-header-actions">
              <select id="quick-theme-picker" class="dl-select dl-btn-sm" aria-label="Preview installed theme">
                <option value="deadplug-editorial" ${activeTheme === 'deadplug-editorial' ? 'selected' : ''}>DEADPLUG EDITORIAL</option>
                <option value="monolith-cyberpunk" ${activeTheme === 'monolith-cyberpunk' ? 'selected' : ''}>MONOLITH MATRIX</option>
                <option value="suisse-minimal" ${activeTheme === 'suisse-minimal' ? 'selected' : ''}>SUISSE MINIMAL</option>
              </select>
            </div>
          </div>
        </header>

        <main class="dl-container" style="padding-top: 3.5rem; padding-bottom: 5rem;">
          <section style="margin-bottom: 3rem; border-bottom: 1px solid var(--dl-border); padding-bottom: 2rem;">
            <div style="font-family: var(--dl-font-mono); font-size: 0.75rem; color: var(--dl-cyan); letter-spacing: 0.15em; margin-bottom: 0.6rem;">
              // FEDERATION EXCHANGE // EXPLICITLY CURATED //
            </div>
            <h1 class="dl-hero-title" style="font-size: clamp(2.2rem, 5vw, 3.4rem);">REMOTE EXCHANGE</h1>
            <p style="max-width: 760px; margin-top: 1rem; color: var(--dl-text-muted); line-height: 1.7;">
              Signed re-letters delivered by explicitly trusted peer nodes and manually promoted by this node's superadmin.
              Remote items are not local posts, do not transfer local authorship, and are not factual verification of an external source.
            </p>
          </section>

          <section aria-label="Curated remote envelopes" style="display: flex; flex-direction: column; gap: 1.5rem;">
            ${items.length === 0 ? this.renderEmpty() : items.map(item => this.renderItem(item)).join('')}
          </section>
        </main>

        <footer style="border-top: 1px solid var(--dl-border); padding: 2.5rem 0; background: var(--dl-obsidian);">
          <div class="dl-container" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
            <span style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">
              REMOTE ENVELOPES RETAIN THEIR SOURCE NODE AND SIGNING KEY ID.
            </span>
            <a href="/" class="dl-btn dl-btn-ghost dl-btn-sm">← RETURN TO LOCAL DISPATCHES</a>
          </div>
        </footer>
      `;

      this.bindEvents(container);
    } catch (error) {
      container.innerHTML = `
        <div class="dl-container" style="padding: 4rem 1.5rem;">
          <div class="dl-card" style="border-color: var(--dl-crimson);">
            <div class="dl-box-title" style="color: var(--dl-crimson);">// REMOTE EXCHANGE UNAVAILABLE //</div>
            <p style="color: var(--dl-text-muted); line-height: 1.6;">${escapeHtml(error.message)}</p>
            <a href="/" class="dl-btn dl-btn-outline dl-btn-sm" style="margin-top: 1rem;">RETURN TO DISPATCHES</a>
          </div>
        </div>
      `;
    }
  },

  renderEmpty() {
    return `
      <div class="dl-card" style="padding: 3rem; text-align: center; font-family: var(--dl-font-mono); color: var(--dl-text-muted); line-height: 1.8;">
        // NO REMOTE ENVELOPES HAVE BEEN PROMOTED TO THE PUBLIC EXCHANGE //<br />
        <span style="font-size: 0.75rem;">A superadmin can promote accepted federation inbox records from the control panel.</span>
      </div>
    `;
  },

  renderItem(item) {
    const sourceUrl = safeUrl(item.source_url);
    const verification = item.verification || {};
    const chain = Array.isArray(item.provenance_chain) ? item.provenance_chain : [];
    const verificationLabel = verification.peer_enabled
      ? 'SIGNED PEER // CURRENTLY TRUSTED'
      : (verification.peer_registered ? 'SIGNED PEER // CURRENTLY DISABLED' : 'SIGNED PEER // REGISTRY ENTRY MISSING');

    return `
      <article class="dl-card" style="padding: 0; overflow: hidden;" data-remote-id="${escapeHtml(item.remote_post_id)}">
        <div style="padding: 1rem 1.4rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border); display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;">
          <div>
            <span class="dl-badge dl-badge-cyan">REMOTE ENVELOPE</span>
            <span class="dl-badge">NOT A LOCAL POST</span>
          </div>
          <span style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-text-muted);">
            ${escapeHtml(verificationLabel)}
          </span>
        </div>

        <div style="padding: 1.5rem;">
          <div style="display: flex; gap: 1rem; justify-content: space-between; flex-wrap: wrap; margin-bottom: 1rem;">
            <div>
              <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-cyan); margin-bottom: 0.35rem;">
                SOURCE NODE // ${escapeHtml(item.source_node || item.signing_node_handle || 'unknown')}
              </div>
              <h2 style="font-size: 1.35rem; line-height: 1.25;">${escapeHtml(item.source_title || 'Untitled remote transmission')}</h2>
              <div style="font-size: 0.82rem; color: var(--dl-text-muted); margin-top: 0.35rem;">
                Source author: ${escapeHtml(item.source_author || 'Unknown source author')}
              </div>
            </div>
            <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-text-muted); text-align: right;">
              <div>PROMOTED: ${escapeHtml(item.promoted_at ? new Date(item.promoted_at).toLocaleString() : 'unknown')}</div>
              <div>KEY: ${escapeHtml(item.key_id || 'unknown')}</div>
            </div>
          </div>

          <p style="color: var(--dl-text-muted); line-height: 1.65; margin-bottom: 1.25rem;">
            ${escapeHtml(item.source_excerpt || 'No source excerpt was preserved.')}
          </p>

          ${sourceUrl ? `
            <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="dl-btn dl-btn-ghost dl-btn-sm" style="margin-bottom: 1.25rem;">
              OPEN ORIGINAL SOURCE ↗
            </a>
          ` : ''}

          <div style="padding: 1.25rem; border-left: 3px solid var(--dl-accent); background: var(--dl-surface); margin-bottom: 1rem;">
            <div style="font-family: var(--dl-font-mono); font-size: 0.7rem; color: var(--dl-accent); margin-bottom: 0.65rem;">
              // REMOTE CURATOR COMMENTARY // ${escapeHtml(item.signing_node_handle || item.source_node || 'peer node')}
            </div>
            <div style="white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7;">
              ${escapeHtml(item.curator_commentary || 'No curator commentary was preserved.')}
            </div>
          </div>

          <details style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-text-muted);">
            <summary style="cursor: pointer; color: var(--dl-text);">PROVENANCE & PEER VERIFICATION</summary>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.65rem; margin-top: 1rem; overflow-wrap: anywhere;">
              <span>CHAIN ENTRIES: ${escapeHtml(item.chain_length || 0)}</span>
              <span>ENVELOPE: ${escapeHtml(item.envelope_hash || '—')}</span>
              <span>PARENT: ${escapeHtml(item.parent_envelope_hash || 'none')}</span>
              <span>SCOPE: ${escapeHtml(verification.scope || 'unavailable')}</span>
            </div>
            <p style="line-height: 1.6; margin-top: 0.8rem;">${escapeHtml(verification.note || 'Peer verification metadata is unavailable.')}</p>
            <pre style="background: var(--dl-black); border: 1px solid var(--dl-border); padding: 0.9rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(JSON.stringify(chain, null, 2))}</pre>
          </details>
        </div>
      </article>
    `;
  },

  bindEvents(container) {
    const picker = container.querySelector('#quick-theme-picker');
    if (!picker) return;
    picker.addEventListener('change', async event => {
      try {
        const theme = await App.previewTheme(event.target.value);
        if (!theme) throw new Error('Theme is not installed.');
        App.showToast(`Theme preview: ${event.target.value} (not saved)`);
      } catch (error) {
        App.showToast('Theme preview failed: ' + error.message);
      }
    });
  }
};
