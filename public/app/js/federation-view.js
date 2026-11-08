/**
 * DEADLETTERS FEDERATION CONTROL SURFACE
 * Superadmin-only peer trust anchors and delivery-only outbox/inbox audit.
 *
 * This view intentionally describes the narrow delivery MVP: peers are trusted
 * from out-of-band key material, the inbox is an audit store, and no remote post
 * is ever fabricated from a received envelope.
 */

const FederationView = {
  data: null,
  errors: {},
  loading: false,

  async render(container) {
    if (!App.isSuperadmin()) {
      container.innerHTML = `
        <div class="dl-admin-content">
          <div class="dl-card" style="border-color: var(--dl-crimson);">
            <div class="dl-box-title" style="color: var(--dl-crimson);">// ACCESS DENIED //</div>
            <p style="font-size: 0.9rem; color: var(--dl-text-muted); line-height: 1.6; margin-bottom: 1.25rem;">
              Federation trust anchors and delivery controls are restricted to the superadmin role.
            </p>
            <a href="${escapeHtml(App.getAdminLandingRoute())}" class="dl-btn dl-btn-accent dl-btn-sm">GO TO YOUR ADMIN HOME</a>
          </div>
        </div>
      `;
      return;
    }

    this.data = null;
    this.errors = {};
    this.renderLoading(container);
    await this.load(container);
  },

  styles() {
    return `
      <style>
        .dl-federation-form-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
          gap: 1rem;
        }
        .dl-federation-table-wrap {
          width: 100%;
          overflow-x: auto;
        }
        .dl-federation-table {
          width: 100%;
          border-collapse: collapse;
          background: var(--dl-obsidian);
        }
        .dl-federation-table th,
        .dl-federation-table td {
          padding: 0.85rem 1rem;
          text-align: left;
          vertical-align: top;
          border-bottom: 1px solid var(--dl-border);
        }
        .dl-federation-table th {
          font-family: var(--dl-font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--dl-text-muted);
          background: var(--dl-surface);
          white-space: nowrap;
        }
        .dl-federation-mono {
          font-family: var(--dl-font-mono);
          font-size: 0.72rem;
          color: var(--dl-text-muted);
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .dl-federation-key {
          font-family: var(--dl-font-mono);
          font-size: 0.7rem;
          overflow-wrap: anywhere;
          word-break: break-all;
        }
        .dl-federation-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 0.35rem;
        }
        .dl-federation-note {
          font-size: 0.82rem;
          color: var(--dl-text-muted);
          line-height: 1.65;
        }
        .dl-federation-note ul {
          margin: 0.5rem 0 0 1.1rem;
          padding: 0;
        }
        .dl-federation-note li {
          margin-bottom: 0.45rem;
        }
        .dl-federation-error {
          margin: 0 0 1rem;
          padding: 1rem 1.1rem;
          border: 1px solid var(--dl-crimson);
          background: var(--dl-surface);
          font-size: 0.84rem;
          color: var(--dl-text-muted);
          line-height: 1.6;
        }
        .dl-federation-empty {
          padding: 2rem 1.25rem;
          text-align: center;
          font-family: var(--dl-font-mono);
          font-size: 0.8rem;
          color: var(--dl-text-muted);
          line-height: 1.7;
        }
        .dl-federation-section-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 1rem;
          flex-wrap: wrap;
          margin-bottom: 1rem;
        }
        .dl-federation-enqueue-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
          gap: 1rem;
          align-items: end;
        }
        .dl-federation-checkline {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          font-family: var(--dl-font-mono);
          font-size: 0.72rem;
          color: var(--dl-text-muted);
        }
        @media (max-width: 980px) {
          .dl-federation-form-grid { grid-template-columns: 1fr; }
          .dl-federation-enqueue-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 780px) {
          .dl-federation-table thead {
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
          .dl-federation-table,
          .dl-federation-table tbody,
          .dl-federation-table tr,
          .dl-federation-table td {
            display: block;
            width: 100%;
          }
          .dl-federation-table tr {
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--dl-border);
          }
          .dl-federation-table td {
            border: none;
            padding: 0.35rem 0;
          }
          .dl-federation-table td::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 0.2rem;
            font-family: var(--dl-font-mono);
            font-size: 0.65rem;
            letter-spacing: 0.08em;
            color: var(--dl-text-faint);
          }
          .dl-federation-actions { justify-content: flex-start; margin-top: 0.35rem; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dl-federation-table tr { transition: none !important; }
        }
      </style>
    `;
  },

  renderLoading(container) {
    container.innerHTML = `
      ${this.styles()}
      <div class="dl-admin-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
          <div>
            <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
              // MESH TRANSPORT & TRUST //
            </div>
            <h2 style="font-size: 1.8rem; font-weight: 800;">FEDERATION & PEERS</h2>
          </div>
        </div>
        <div class="dl-card">
          <div class="dl-federation-empty" role="status">
            // LOADING FEDERATION CONTROL SURFACE //<br />
            <span style="font-size: 0.72rem;">Reading peer trust anchors, outbox deliveries, and inbox audit rows.</span>
          </div>
        </div>
      </div>
    `;
  },

  async load(container) {
    if (this.loading) return;
    this.loading = true;
    this.renderLoading(container);

    const requests = [
      API.get('/api/v1/federation/status'),
      API.get('/api/v1/federation/peers'),
      API.get('/api/v1/federation/outbox?limit=12'),
      API.get('/api/v1/federation/inbox?limit=12')
    ];
    const keys = ['status', 'peers', 'outbox', 'inbox'];
    const settled = await Promise.allSettled(requests);
    const loaded = {};
    const errors = {};

    settled.forEach((result, index) => {
      const key = keys[index];
      if (result.status === 'fulfilled') {
        loaded[key] = result.value;
      } else {
        errors[key] = result.reason && result.reason.message
          ? result.reason.message
          : 'The federation endpoint did not respond.';
      }
    });

    const peersResponse = loaded.peers;
    const outboxResponse = loaded.outbox;
    const inboxResponse = loaded.inbox;

    this.data = {
      status: loaded.status || null,
      peers: peersResponse && Array.isArray(peersResponse.peers) ? peersResponse.peers : [],
      outbox: outboxResponse && Array.isArray(outboxResponse.items) ? outboxResponse.items : [],
      outboxStatus: outboxResponse && outboxResponse.status ? outboxResponse.status : null,
      inbox: inboxResponse && Array.isArray(inboxResponse.items) ? inboxResponse.items : [],
      inboxStatus: inboxResponse && inboxResponse.status ? inboxResponse.status : null
    };
    this.errors = errors;
    this.loading = false;
    this.renderContent(container);
  },

  sectionError(key, label) {
    if (!this.errors[key]) return '';
    return `
      <div class="dl-federation-error" role="alert">
        <strong style="color: var(--dl-crimson); font-family: var(--dl-font-mono); font-size: 0.75rem;">
          // ${escapeHtml(label)} UNAVAILABLE //
        </strong>
        <div style="margin-top: 0.4rem;">${escapeHtml(this.errors[key])}</div>
      </div>
    `;
  },

  count(value) {
    const number = Number(value);
    return escapeHtml(Number.isFinite(number) && number >= 0 ? number : 0);
  },

  dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  },

  short(value, max = 26) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  },

  statusBadge(status) {
    const raw = String(status || '').toLowerCase();
    if (raw === 'delivered' || raw === 'accepted') {
      return `<span class="dl-badge dl-badge-accent">${escapeHtml(raw.toUpperCase())}</span>`;
    }
    if (raw === 'dead' || raw === 'failed' || raw === 'rejected') {
      return `<span class="dl-badge" style="border-color: var(--dl-crimson); color: var(--dl-crimson);">${escapeHtml(raw.toUpperCase())}</span>`;
    }
    return `<span class="dl-badge">${escapeHtml(raw ? raw.toUpperCase() : 'UNKNOWN')}</span>`;
  },

  renderContent(container) {
    const data = this.data || {};
    const status = data.status || {};
    const peers = Array.isArray(data.peers) ? data.peers : [];
    const outboxItems = Array.isArray(data.outbox) ? data.outbox : [];
    const inboxItems = Array.isArray(data.inbox) ? data.inbox : [];
    const outboxStatus = data.outboxStatus || status.outbox || {};
    const inboxStatus = data.inboxStatus || status.inbox || {};
    const peerStatus = status.peers || {};
    const worker = status.worker || {};
    const delivery = status.delivery || {};
    const limitations = status.limitations || {};

    container.innerHTML = `
      ${this.styles()}
      <div class="dl-admin-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
          <div>
            <div style="font-family: var(--dl-font-mono); font-size: 0.72rem; color: var(--dl-accent); letter-spacing: 0.12em; margin-bottom: 0.4rem;">
              // MESH TRANSPORT & TRUST // SUPERADMIN ONLY //
            </div>
            <h2 style="font-size: 1.8rem; font-weight: 800;">FEDERATION & PEERS</h2>
            <p style="font-size: 0.82rem; color: var(--dl-text-muted); margin-top: 0.5rem; max-width: 820px; line-height: 1.6;">
              Delivery-only peer trust anchors, signed outbox delivery, and inbox audit records. This surface does not discover peers, fetch remote keys, or publish remote content.
            </p>
          </div>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button id="btn-federation-refresh" class="dl-btn dl-btn-outline" type="button">↻ REFRESH</button>
            <button class="dl-btn dl-btn-accent btn-process-due" type="button">▶ PROCESS DUE OUTBOX</button>
          </div>
        </div>

        ${this.sectionError('status', 'STATUS')}
        ${this.errors.status ? '' : `
          <div class="dl-metrics-grid">
            <div class="dl-metric-card">
              <div class="dl-metric-label">PEER TRUST ANCHORS</div>
              <div class="dl-metric-val">${this.count(peerStatus.enabled)}<span style="font-size: 1rem; color: var(--dl-text-muted);"> / ${this.count(peerStatus.total)}</span></div>
              <div class="dl-metric-meta"><span>ENABLED / TOTAL REGISTERED</span></div>
            </div>
            <div class="dl-metric-card">
              <div class="dl-metric-label">OUTBOX DUE</div>
              <div class="dl-metric-val">${this.count(outboxStatus.due)}</div>
              <div class="dl-metric-meta">
                <span>${this.count(outboxStatus.pending)} PENDING · ${this.count(outboxStatus.failed)} FAILED · ${this.count(outboxStatus.dead)} DEAD</span>
              </div>
            </div>
            <div class="dl-metric-card">
              <div class="dl-metric-label">INBOX AUDIT</div>
              <div class="dl-metric-val">${this.count(inboxStatus.accepted)}</div>
              <div class="dl-metric-meta">
                <span>ACCEPTED · ${this.count(inboxStatus.rejected)} REJECTED · ${this.count(inboxStatus.total)} TOTAL</span>
              </div>
            </div>
            <div class="dl-metric-card">
              <div class="dl-metric-label">DELIVERY WORKER</div>
              <div class="dl-metric-val" style="font-size: 1.15rem; word-break: break-word;">${worker.running ? 'RUNNING' : 'STOPPED'}</div>
              <div class="dl-metric-meta">
                <span>${delivery.interval_ms ? `EVERY ${this.count(Math.round(Number(delivery.interval_ms) / 1000))}S` : 'MANUAL PROCESSING AVAILABLE'}</span>
              </div>
            </div>
          </div>
        `}

        <div class="dl-card" style="border-color: var(--dl-cyan); margin-bottom: 1.5rem;">
          <div class="dl-box-title" style="color: var(--dl-cyan);">// TRUST, DELIVERY & LIMITS //</div>
          <div class="dl-federation-note">
            <ul>
              <li><strong>Out-of-band peer key trust.</strong> Register only an HTTP(S) endpoint, node handle, and Ed25519 SPKI public key that you obtained through a trusted channel. This node does not fetch remote keys, follow discovery documents, or auto-enroll peers.</li>
              <li><strong>Delivery-only inbox audit.</strong> Accepted inbox rows retain a signed envelope for audit only. The engine never fabricates a local post or reshare from remote content.</li>
              <li><strong>No automatic peer or key discovery.</strong> Every trust anchor is an explicit superadmin action; deleting one stops trust and removes pending outbox rows.</li>
              <li><strong>Accepted is not proof of facts.</strong> “Accepted” means the signed envelope matched a registered key and was retained for audit. It is not factual source proof, a trusted timestamp, or cross-node verification of the remote claim.</li>
              <li><strong>No confidentiality beyond HTTPS.</strong> Delivery bodies are not application-layer encrypted. Use HTTPS and treat peer registration as a security-sensitive act.</li>
              <li><strong>Disabled peers and audit history.</strong> Disabling a peer stops new enqueues and due delivery attempts. Deleting a peer clears its pending outbox rows; inbox audit rows remain with the peer link cleared.</li>
            </ul>
            <p style="margin-top: 0.75rem; font-size: 0.74rem; color: var(--dl-text-faint);">
              Delivery spec: ${escapeHtml(delivery.spec || 'deadletters-federation-delivery-v1')} ·
              max attempts: ${this.count(delivery.max_attempts || 5)} ·
              body cap: ${this.count(delivery.max_body_bytes ? Math.round(Number(delivery.max_body_bytes) / 1024) : 256)} KiB ·
              remote key discovery: ${limitations.remote_key_discovery ? 'ENABLED' : 'DISABLED'} ·
              remote post creation: ${limitations.remote_post_creation ? 'ENABLED' : 'DISABLED'}
            </p>
          </div>
        </div>

        <!-- Peer trust anchors -->
        <div class="dl-card" style="padding: 0; overflow: hidden; margin-bottom: 1.5rem;">
          <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border);">
            <div class="dl-federation-section-head" style="margin-bottom: 0;">
              <div>
                <div class="dl-box-title" style="border: none; padding: 0; margin: 0;">// PEER TRUST ANCHORS //</div>
                <div class="dl-federation-mono" style="margin-top: 0.35rem;">${peers.length} REGISTERED</div>
              </div>
              <div class="dl-federation-note" style="max-width: 520px; font-size: 0.75rem;">
                Keys must be obtained out-of-band. The public key must be canonical base64url Ed25519 SPKI DER; the optional key ID must match the derived fingerprint.
              </div>
            </div>
          </div>
          <div style="padding: 1.5rem;">
            <form id="federation-peer-form" novalidate>
              <div class="dl-federation-form-grid">
                <div class="dl-form-group">
                  <label class="dl-label" for="federation-peer-endpoint">Peer Endpoint URL</label>
                  <input id="federation-peer-endpoint" class="dl-input" type="url" placeholder="https://peer.example" autocomplete="off" required />
                </div>
                <div class="dl-form-group">
                  <label class="dl-label" for="federation-peer-handle">Node Handle</label>
                  <input id="federation-peer-handle" class="dl-input" type="text" placeholder="@peer/main-node" maxlength="100" autocomplete="off" required />
                </div>
              </div>
              <div class="dl-form-group">
                <label class="dl-label" for="federation-peer-public-key">Ed25519 Public Key (SPKI DER, base64url)</label>
                <textarea id="federation-peer-public-key" class="dl-textarea" style="min-height: 76px;" placeholder="Paste the trusted public key obtained out-of-band" spellcheck="false" required></textarea>
              </div>
              <div class="dl-federation-form-grid">
                <div class="dl-form-group">
                  <label class="dl-label" for="federation-peer-key-id">Key ID (optional)</label>
                  <input id="federation-peer-key-id" class="dl-input" type="text" placeholder="ed25519-0123456789abcdef" autocomplete="off" />
                </div>
                <div class="dl-form-group" style="justify-content: flex-end;">
                  <label class="dl-federation-checkline" for="federation-peer-enabled">
                    <input id="federation-peer-enabled" type="checkbox" checked />
                    ENABLE THIS PEER AFTER REGISTRATION
                  </label>
                </div>
              </div>
              <div style="display: flex; justify-content: flex-end; gap: 0.75rem; flex-wrap: wrap;">
                <button id="btn-register-peer" class="dl-btn dl-btn-accent" type="submit">+ REGISTER TRUSTED PEER</button>
              </div>
            </form>
          </div>

          ${this.sectionError('peers', 'PEER LIST')}
          ${this.errors.peers ? '' : this.renderPeerTable(peers)}
        </div>

        <!-- Outbox -->
        <div class="dl-card" style="padding: 0; overflow: hidden; margin-bottom: 1.5rem;">
          <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border);">
            <div class="dl-federation-section-head" style="margin-bottom: 0;">
              <div>
                <div class="dl-box-title" style="border: none; padding: 0; margin: 0;">// OUTBOX //</div>
                <div class="dl-federation-mono" style="margin-top: 0.35rem;">
                  ${this.count(outboxStatus.pending)} PENDING · ${this.count(outboxStatus.delivered)} DELIVERED · ${this.count(outboxStatus.failed)} FAILED · ${this.count(outboxStatus.dead)} DEAD · ${this.count(outboxStatus.due)} DUE
                </div>
              </div>
              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <button class="dl-btn dl-btn-accent dl-btn-sm btn-process-due" type="button">▶ PROCESS DUE</button>
                <button class="dl-btn dl-btn-outline dl-btn-sm btn-force-outbox" type="button">FORCE RETRY UNSCHEDULED</button>
              </div>
            </div>
          </div>
          <div style="padding: 1.5rem; border-bottom: 1px solid var(--dl-border);">
            <div class="dl-federation-note" style="margin-bottom: 1rem;">
              Manually enqueue one local reshare for every enabled peer. Repeated enqueue calls are idempotent; at least one of reshare ID or post ID is required.
            </div>
            <form id="federation-enqueue-form" class="dl-federation-enqueue-grid" novalidate>
              <div class="dl-form-group" style="margin-bottom: 0;">
                <label class="dl-label" for="federation-reshare-id">Reshare ID</label>
                <input id="federation-reshare-id" class="dl-input" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. 12" />
              </div>
              <div class="dl-form-group" style="margin-bottom: 0;">
                <label class="dl-label" for="federation-post-id">Post ID</label>
                <input id="federation-post-id" class="dl-input" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. 8" />
              </div>
              <button id="btn-enqueue-outbox" class="dl-btn dl-btn-outline" type="submit" style="margin-bottom: 1px;">⚡ ENQUEUE FOR ENABLED PEERS</button>
            </form>
          </div>
          ${this.sectionError('outbox', 'OUTBOX')}
          ${this.errors.outbox ? '' : this.renderOutboxTable(outboxItems)}
        </div>

        <!-- Inbox -->
        <div class="dl-card" style="padding: 0; overflow: hidden;">
          <div style="padding: 1.25rem 1.5rem; background: var(--dl-surface); border-bottom: 1px solid var(--dl-border);">
            <div class="dl-federation-section-head" style="margin-bottom: 0;">
              <div>
                <div class="dl-box-title" style="border: none; padding: 0; margin: 0;">// INBOX AUDIT //</div>
                <div class="dl-federation-mono" style="margin-top: 0.35rem;">
                  ${this.count(inboxStatus.accepted)} ACCEPTED · ${this.count(inboxStatus.rejected)} REJECTED · ${this.count(inboxStatus.total)} TOTAL
                </div>
                <div class="dl-federation-mono" style="margin-top: 0.35rem; color: var(--dl-cyan);">
                  REMOTE EXCHANGE: ${this.count(status.remote_exchange?.public_count)} PUBLIC · ${this.count(status.remote_exchange?.hidden)} HIDDEN · ${this.count(status.remote_exchange?.removed)} REMOVED
                </div>
              </div>
              <div style="display: flex; flex-direction: column; gap: 0.65rem; align-items: flex-end;">
                <div class="dl-federation-note" style="max-width: 560px; font-size: 0.75rem; text-align: right;">
                  Accepted means the signed envelope matched a registered enabled peer key and was retained for audit. Promotion publishes it only in the labeled remote exchange—never as a local post, author, or factual source proof.
                </div>
                <a href="/remote" target="_blank" rel="noopener" class="dl-btn dl-btn-outline dl-btn-sm">OPEN PUBLIC EXCHANGE ↗</a>
              </div>
            </div>
          </div>
          ${this.sectionError('inbox', 'INBOX')}
          ${this.errors.inbox ? '' : this.renderInboxTable(inboxItems)}
        </div>
      </div>
    `;

    this.bindEvents(container);
  },

  renderPeerTable(peers) {
    if (peers.length === 0) {
      return `
        <div class="dl-federation-empty" role="status">
          // NO PEER TRUST ANCHORS REGISTERED //<br />
          <span style="font-size: 0.72rem;">Register a peer above with a key obtained out-of-band.</span>
        </div>
      `;
    }

    return `
      <div class="dl-federation-table-wrap">
        <table class="dl-federation-table">
          <thead>
            <tr>
              <th scope="col">NODE HANDLE</th>
              <th scope="col">ENDPOINT</th>
              <th scope="col">KEY ID</th>
              <th scope="col">STATUS</th>
              <th scope="col">UPDATED</th>
              <th scope="col" style="text-align: right;">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${peers.map(peer => {
              const endpoint = safeUrl(peer.endpoint_url);
              const endpointCell = endpoint
                ? `<a href="${escapeHtml(endpoint)}" target="_blank" rel="noopener noreferrer">${escapeHtml(peer.endpoint_url)}</a>`
                : escapeHtml(peer.endpoint_url || '—');
              return `
                <tr>
                  <td data-label="NODE HANDLE"><strong>${escapeHtml(peer.node_handle || '—')}</strong></td>
                  <td class="dl-federation-mono" data-label="ENDPOINT">${endpointCell}</td>
                  <td class="dl-federation-key" data-label="KEY ID">${escapeHtml(peer.key_id || '—')}</td>
                  <td data-label="STATUS">
                    ${peer.enabled
                      ? '<span class="dl-badge dl-badge-accent">ENABLED</span>'
                      : '<span class="dl-badge">DISABLED</span>'}
                  </td>
                  <td class="dl-federation-mono" data-label="UPDATED">${escapeHtml(this.dateText(peer.updated_at || peer.created_at))}</td>
                  <td data-label="ACTIONS">
                    <div class="dl-federation-actions">
                      <button type="button"
                        class="dl-btn dl-btn-outline dl-btn-sm btn-peer-toggle"
                        data-id="${escapeHtml(String(peer.peer_id ?? ''))}"
                        data-enabled="${peer.enabled ? 'true' : 'false'}">
                        ${peer.enabled ? 'DISABLE' : 'ENABLE'}
                      </button>
                      <button type="button"
                        class="dl-btn dl-btn-danger dl-btn-sm btn-peer-delete"
                        data-id="${escapeHtml(String(peer.peer_id ?? ''))}"
                        data-handle="${escapeHtml(String(peer.node_handle || 'peer'))}">
                        DELETE
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  renderOutboxTable(items) {
    if (items.length === 0) {
      return `
        <div class="dl-federation-empty" role="status">
          // NO OUTBOX DELIVERIES RECORDED //<br />
          <span style="font-size: 0.72rem;">Create a reshare or enqueue one explicitly above.</span>
        </div>
      `;
    }

    return `
      <div class="dl-federation-table-wrap">
        <table class="dl-federation-table">
          <thead>
            <tr>
              <th scope="col">CREATED</th>
              <th scope="col">PEER</th>
              <th scope="col">STATUS</th>
              <th scope="col">ATTEMPTS</th>
              <th scope="col">NEXT ATTEMPT</th>
              <th scope="col">DELIVERY</th>
              <th scope="col">LAST ERROR</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => `
              <tr>
                <td class="dl-federation-mono" data-label="CREATED">${escapeHtml(this.dateText(item.created_at))}</td>
                <td data-label="PEER">
                  <div>${escapeHtml(item.node_handle || `Peer #${item.peer_id ?? 'unknown'}`)}</div>
                  <div class="dl-federation-key">${escapeHtml(item.endpoint_url || '')}</div>
                </td>
                <td data-label="STATUS">${this.statusBadge(item.status)}</td>
                <td class="dl-federation-mono" data-label="ATTEMPTS">${this.count(item.attempts)}</td>
                <td class="dl-federation-mono" data-label="NEXT ATTEMPT">${escapeHtml(this.dateText(item.next_attempt_at))}</td>
                <td class="dl-federation-key" data-label="DELIVERY" title="${escapeHtml(item.delivery_id || '')}">${escapeHtml(this.short(item.delivery_id))}</td>
                <td class="dl-federation-mono" data-label="LAST ERROR">${escapeHtml(item.last_error || '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  renderInboxTable(items) {
    if (items.length === 0) {
      return `
        <div class="dl-federation-empty" role="status">
          // NO INBOX AUDIT ROWS //<br />
          <span style="font-size: 0.72rem;">Accepted signed envelopes are retained here for audit only; no local post is created.</span>
        </div>
      `;
    }

    return `
      <div class="dl-federation-table-wrap">
        <table class="dl-federation-table">
          <thead>
            <tr>
              <th scope="col">RECEIVED</th>
              <th scope="col">SOURCE NODE</th>
              <th scope="col">STATUS</th>
              <th scope="col">DELIVERY</th>
              <th scope="col">REMOTE EXCHANGE</th>
              <th scope="col">LOCAL POST</th>
              <th scope="col">REASON</th>
              <th scope="col" style="text-align: right;">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const accepted = String(item.status || '').toLowerCase() === 'accepted';
              const source = item.source_node || (item.source_peer_id ? `Peer #${item.source_peer_id}` : 'Deleted or unknown peer');
              const remoteStatus = String(item.remote_status || '').toLowerCase();
              const remoteBadge = remoteStatus === 'promoted'
                ? '<span class="dl-badge dl-badge-cyan">PUBLIC REMOTE</span>'
                : remoteStatus === 'hidden'
                  ? '<span class="dl-badge">HIDDEN</span>'
                  : remoteStatus === 'removed'
                    ? '<span class="dl-badge">REMOVED</span>'
                    : '<span class="dl-badge">NOT PUBLISHED</span>';
              const nextRemoteStatus = remoteStatus === 'promoted' ? 'hidden' : 'promoted';
              return `
                <tr>
                  <td class="dl-federation-mono" data-label="RECEIVED">${escapeHtml(this.dateText(item.received_at))}</td>
                  <td data-label="SOURCE NODE">
                    <div>${escapeHtml(source)}</div>
                    <div class="dl-federation-key">${escapeHtml(item.key_id || '')}</div>
                    ${item.source_title ? `<div class="dl-federation-mono" style="margin-top: 0.35rem;">${escapeHtml(this.short(item.source_title, 70))}</div>` : ''}
                  </td>
                  <td data-label="STATUS">
                    ${accepted
                      ? '<span class="dl-badge dl-badge-accent">ACCEPTED · AUDIT RETAINED</span>'
                      : this.statusBadge(item.status)}
                  </td>
                  <td class="dl-federation-key" data-label="DELIVERY" title="${escapeHtml(item.delivery_id || '')}">${escapeHtml(this.short(item.delivery_id))}</td>
                  <td data-label="REMOTE EXCHANGE">${remoteBadge}</td>
                  <td class="dl-federation-mono" data-label="LOCAL POST">${item.local_post_created ? 'CREATED' : 'NONE'}</td>
                  <td class="dl-federation-mono" data-label="REASON">${escapeHtml(item.reason || (accepted ? 'Signed envelope retained; not factual source proof.' : '—'))}</td>
                  <td data-label="ACTIONS">
                    ${accepted ? `
                      <div class="dl-federation-actions">
                        <button type="button"
                          class="dl-btn ${remoteStatus === 'promoted' ? 'dl-btn-outline' : 'dl-btn-accent'} dl-btn-sm btn-remote-status"
                          data-inbox-id="${escapeHtml(String(item.inbox_id ?? ''))}"
                          data-status="${nextRemoteStatus}"
                          data-title="${escapeHtml(item.source_title || source)}">
                          ${remoteStatus === 'promoted' ? 'HIDE FROM PUBLIC' : 'PUBLISH REMOTE'}
                        </button>
                      </div>
                    ` : '—'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  bindEvents(container) {
    const refreshButton = container.querySelector('#btn-federation-refresh');
    if (refreshButton) {
      refreshButton.addEventListener('click', () => this.load(container));
    }

    container.querySelectorAll('.btn-process-due').forEach(button => {
      button.addEventListener('click', () => this.processOutbox(container, false));
    });

    const forceButton = container.querySelector('.btn-force-outbox');
    if (forceButton) {
      forceButton.addEventListener('click', () => this.processOutbox(container, true));
    }

    container.querySelectorAll('.btn-peer-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const enable = button.dataset.enabled !== 'true';
        this.togglePeer(container, button.dataset.id, enable);
      });
    });

    container.querySelectorAll('.btn-peer-delete').forEach(button => {
      button.addEventListener('click', () => {
        this.deletePeer(container, button.dataset.id, button.dataset.handle || 'peer');
      });
    });

    container.querySelectorAll('.btn-remote-status').forEach(button => {
      button.addEventListener('click', () => {
        this.setRemoteStatus(container, button.dataset.inboxId, button.dataset.status, button.dataset.title);
      });
    });

    const peerForm = container.querySelector('#federation-peer-form');
    if (peerForm) {
      peerForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.registerPeer(container, peerForm);
      });
    }

    const enqueueForm = container.querySelector('#federation-enqueue-form');
    if (enqueueForm) {
      enqueueForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.enqueue(container, enqueueForm);
      });
    }
  },

  async registerPeer(container, form) {
    const endpointInput = form.querySelector('#federation-peer-endpoint');
    const handleInput = form.querySelector('#federation-peer-handle');
    const keyInput = form.querySelector('#federation-peer-public-key');
    const keyIdInput = form.querySelector('#federation-peer-key-id');
    const enabledInput = form.querySelector('#federation-peer-enabled');
    const submitButton = form.querySelector('#btn-register-peer');

    const endpoint = endpointInput ? endpointInput.value.trim() : '';
    const handle = handleInput ? handleInput.value.trim() : '';
    const publicKey = keyInput ? keyInput.value.trim() : '';
    const keyId = keyIdInput ? keyIdInput.value.trim() : '';

    if (!endpoint || !handle || !publicKey) {
      App.showToast('Endpoint URL, node handle, and public key are required.');
      if (!endpoint && endpointInput) endpointInput.focus();
      else if (!handle && handleInput) handleInput.focus();
      else if (keyInput) keyInput.focus();
      return;
    }

    const payload = {
      endpoint_url: endpoint,
      node_handle: handle,
      public_key: publicKey,
      enabled: Boolean(enabledInput && enabledInput.checked)
    };
    if (keyId) payload.key_id = keyId;

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'REGISTERING...';
    }

    try {
      const result = await API.post('/api/v1/federation/peers', payload);
      App.showToast(result && result.message ? result.message : 'Federation peer registered.');
      await this.load(container);
    } catch (err) {
      App.showToast(`Peer registration failed: ${err.message}`);
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = '+ REGISTER TRUSTED PEER';
      }
    }
  },

  async togglePeer(container, peerId, enabled) {
    if (!peerId) return;
    try {
      await API.request(`/api/v1/federation/peers/${encodeURIComponent(peerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      });
      App.showToast(`Federation peer ${enabled ? 'enabled' : 'disabled'}.`);
      await this.load(container);
    } catch (err) {
      App.showToast(`Peer update failed: ${err.message}`);
    }
  },

  async deletePeer(container, peerId, handle) {
    if (!peerId) return;
    const confirmed = await App.confirmAction({
      title: 'DELETE TRUSTED PEER',
      message: `Delete trusted peer "${handle}"? Pending outbox deliveries are removed and cannot be undone. Inbox audit history is retained without the peer link.`,
      confirmLabel: 'DELETE PEER',
      danger: true
    });
    if (!confirmed) return;

    try {
      await API.del(`/api/v1/federation/peers/${encodeURIComponent(peerId)}`);
      App.showToast('Federation peer deleted.');
      await this.load(container);
    } catch (err) {
      App.showToast(`Peer deletion failed: ${err.message}`);
    }
  },

  async processOutbox(container, force) {
    if (force) {
      const confirmed = await App.confirmAction({
        title: 'FORCE OUTBOX RETRY',
        message: 'Force a retry of unscheduled pending and failed outbox rows now? This bypasses the normal backoff schedule.',
        confirmLabel: 'FORCE RETRY',
        danger: false
      });
      if (!confirmed) return;
    }

    try {
      const result = await API.post('/api/v1/federation/outbox/process', force ? { force: true } : {});
      App.showToast(
        `Outbox processed: ${result.processed ?? 0} processed, ${result.delivered ?? 0} delivered, ${result.failed ?? 0} failed, ${result.dead ?? 0} dead.`
      );
      await this.load(container);
    } catch (err) {
      App.showToast(`Outbox processing failed: ${err.message}`);
    }
  },

  async setRemoteStatus(container, inboxId, status, title) {
    if (!inboxId || (status !== 'promoted' && status !== 'hidden' && status !== 'removed')) return;

    const promoting = status === 'promoted';
    const confirmed = await App.confirmAction({
      title: promoting ? 'PUBLISH REMOTE ENVELOPE' : 'HIDE REMOTE ENVELOPE',
      message: promoting
        ? `Publish the signed envelope "${title || 'remote transmission'}" into the labeled public remote exchange? This does not create a local post or transfer local authorship, and the current peer key must still verify.`
        : `Hide "${title || 'this remote envelope'}" from the public remote exchange? The federation inbox audit record is retained.`,
      confirmLabel: promoting ? 'PUBLISH REMOTE' : 'HIDE FROM PUBLIC',
      danger: !promoting
    });
    if (!confirmed) return;

    try {
      const result = await API.post(
        `/api/v1/federation/inbox/${encodeURIComponent(inboxId)}/status`,
        { status }
      );
      App.showToast(result?.item?.status === 'promoted'
        ? 'Remote envelope published to the labeled exchange.'
        : 'Remote envelope removed from public view; audit retained.');
      await this.load(container);
    } catch (error) {
      App.showToast(`Remote exchange update failed: ${error.message}`);
    }
  },

  async enqueue(container, form) {
    const reshareInput = form.querySelector('#federation-reshare-id');
    const postInput = form.querySelector('#federation-post-id');
    const submitButton = form.querySelector('#btn-enqueue-outbox');
    const reshareValue = reshareInput ? reshareInput.value.trim() : '';
    const postValue = postInput ? postInput.value.trim() : '';
    const positiveInteger = value => /^[1-9]\d*$/.test(value);

    if (!reshareValue && !postValue) {
      App.showToast('Enter a positive reshare ID or post ID.');
      if (reshareInput) reshareInput.focus();
      return;
    }
    if (reshareValue && !positiveInteger(reshareValue)) {
      App.showToast('Reshare ID must be a positive integer.');
      if (reshareInput) reshareInput.focus();
      return;
    }
    if (!reshareValue && postValue && !positiveInteger(postValue)) {
      App.showToast('Post ID must be a positive integer.');
      if (postInput) postInput.focus();
      return;
    }

    const payload = reshareValue
      ? { reshare_id: Number(reshareValue) }
      : { post_id: Number(postValue) };

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'ENQUEUEING...';
    }

    try {
      const result = await API.post('/api/v1/federation/outbox/enqueue', payload);
      App.showToast(
        `Enqueued ${result.enqueued ?? 0} new delivery row(s); ${result.existing ?? 0} already existed across ${result.peer_count ?? 0} enabled peer(s).`
      );
      await this.load(container);
    } catch (err) {
      App.showToast(`Outbox enqueue failed: ${err.message}`);
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = '⚡ ENQUEUE FOR ENABLED PEERS';
      }
    }
  }
};
