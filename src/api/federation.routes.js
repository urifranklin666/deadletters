'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../core/auth');
const { createRateLimiter } = require('../core/rate-limit');
const federation = require('../core/federation');

const router = express.Router();
const superadminOnly = [requireAuth, requireRole('superadmin')];

// Public inbox abuse bounds. The global express.json parser caps the whole app
// at 2 MiB; federation deliveries receive a much tighter route-level cap.
const inboxRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Federation inbox rate limit reached. Try again later.'
});

function deliveryBodyCap(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Federation deliveries must use application/json.' });
  }

  const declaredLength = Number(req.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > federation.MAX_DELIVERY_BYTES) {
    return res.status(413).json({ error: 'Federation delivery exceeds the size limit.' });
  }

  try {
    const actualLength = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
    if (actualLength > federation.MAX_DELIVERY_BYTES) {
      return res.status(413).json({ error: 'Federation delivery exceeds the size limit.' });
    }
  } catch {
    return res.status(400).json({ error: 'Federation delivery cannot be inspected.' });
  }

  return next();
}

function parsePositiveInteger(value) {
  const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePeerId(value) {
  return parsePositiveInteger(value);
}

function safeFailure(res, status, message) {
  return res.status(status).json({ error: message });
}

// POST /api/v1/federation/peers — register an explicitly trusted peer.
router.post('/peers', superadminOnly, (req, res) => {
  try {
    const peer = federation.registerPeer(req.body);
    res.status(201).json({ peer, message: 'Federation peer registered from out-of-band trusted key material.' });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Peer registration failed:', error.message);
    return safeFailure(res, 500, 'Federation peer registration failed.');
  }
});

// GET /api/v1/federation/peers
router.get('/peers', superadminOnly, (req, res) => {
  res.json({ peers: federation.listPeers() });
});

// PATCH /api/v1/federation/peers/:id — enable/disable without deleting history.
router.patch('/peers/:id', superadminOnly, (req, res) => {
  const peerId = parsePeerId(req.params.id);
  if (!peerId) return safeFailure(res, 400, 'Invalid federation peer id.');

  const enabled = req.body && req.body.enabled;
  if (!(enabled === true || enabled === false || enabled === 1 || enabled === 0 ||
    enabled === '1' || enabled === '0')) {
    return safeFailure(res, 400, 'A boolean enabled value is required.');
  }

  try {
    const peer = federation.setPeerEnabled(peerId, enabled === true || enabled === 1 || enabled === '1');
    res.json({ peer });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Peer update failed:', error.message);
    return safeFailure(res, 500, 'Federation peer update failed.');
  }
});

// POST /api/v1/federation/peers/:id/disable — compatibility convenience.
router.post('/peers/:id/disable', superadminOnly, (req, res) => {
  const peerId = parsePeerId(req.params.id);
  if (!peerId) return safeFailure(res, 400, 'Invalid federation peer id.');

  try {
    res.json({ peer: federation.setPeerEnabled(peerId, false) });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Peer disable failed:', error.message);
    return safeFailure(res, 500, 'Federation peer update failed.');
  }
});

// DELETE /api/v1/federation/peers/:id — removes the trust anchor and pending
// outbox rows. Inbox audit rows survive with source_peer_id set to NULL.
router.delete('/peers/:id', superadminOnly, (req, res) => {
  const peerId = parsePeerId(req.params.id);
  if (!peerId) return safeFailure(res, 400, 'Invalid federation peer id.');

  try {
    res.json(federation.deletePeer(peerId));
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Peer deletion failed:', error.message);
    return safeFailure(res, 500, 'Federation peer deletion failed.');
  }
});

// POST /api/v1/federation/outbox/enqueue — manually enqueue one local reshare
// for every currently enabled peer. Repeats are idempotent.
router.post('/outbox/enqueue', superadminOnly, (req, res) => {
  const reshareId = parsePositiveInteger(req.body && (req.body.reshare_id ?? req.body.reshareId));
  const postId = parsePositiveInteger(req.body && (req.body.post_id ?? req.body.postId));

  if (!reshareId && !postId) {
    return safeFailure(res, 400, 'A positive reshare_id or post_id is required.');
  }

  try {
    const result = federation.enqueueReshareForAllPeers({
      reshareId: reshareId || null,
      postId: postId || null
    });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Outbox enqueue failed:', error.message);
    return safeFailure(res, 500, 'Federation outbox enqueue failed.');
  }
});

// POST /api/v1/federation/outbox/process — process due deliveries once.
// `force` is an explicitly superadmin-authorized manual retry of unscheduled rows.
router.post('/outbox/process', superadminOnly, async (req, res) => {
  const bodyForce = req.body && (req.body.force === true || req.body.force === 'true' || req.body.force === 1);
  const queryForce = req.query.force === '1' || req.query.force === 'true';
  const limit = parsePositiveInteger(req.body && req.body.limit) || undefined;

  try {
    const result = await federation.processOutboxDue({
      force: bodyForce || queryForce,
      limit
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[Federation API] Outbox processing failed:', error.message);
    return safeFailure(res, 500, 'Federation outbox processing failed.');
  }
});

// GET /api/v1/federation/outbox — status and, optionally, signed payloads.
router.get('/outbox', superadminOnly, (req, res) => {
  const includePayload = req.query.include_payload === '1' || req.query.include_payload === 'true';
  res.json({
    status: federation.getOutboxStatus(),
    items: federation.listOutbox({ limit: req.query.limit, includePayload })
  });
});

// GET /api/v1/federation/inbox — auditable exchange records (no local posts).
router.get('/inbox', superadminOnly, (req, res) => {
  const includePayload = req.query.include_payload === '1' || req.query.include_payload === 'true';
  res.json({
    status: federation.getInboxStatus(),
    items: federation.listInbox({ limit: req.query.limit, includePayload })
  });
});

// POST /api/v1/federation/inbox/:id/status — explicitly promote, hide, or
// remove an accepted audit row from the public read-only remote exchange.
// Promotion re-verifies the retained envelope against the current peer key.
router.post('/inbox/:id/status', superadminOnly, (req, res) => {
  const inboxId = parsePositiveInteger(req.params.id);
  if (!inboxId) return safeFailure(res, 400, 'Invalid federation inbox id.');

  const status = req.body && req.body.status;
  if (!federation.REMOTE_STATUSES.includes(status)) {
    return safeFailure(res, 400, 'Remote exchange status must be promoted, hidden, or removed.');
  }

  try {
    const item = federation.setInboxRemoteStatus({
      inboxId,
      status,
      actorUserId: req.user.ID
    });
    res.json({ item });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('[Federation API] Remote exchange status update failed:', error.message);
    return safeFailure(res, 500, 'Remote exchange status update failed.');
  }
});

// GET /api/v1/federation/status — aggregate superadmin counts.
router.get('/status', superadminOnly, (req, res) => {
  res.json(federation.getFederationStatus());
});

// POST /api/v1/federation/inbox — public, rate-limited, body-capped delivery
// endpoint. It verifies a registered peer's signed envelope and stores an audit
// record. It deliberately never fabricates a local post from remote content.
router.post('/inbox', inboxRateLimit, deliveryBodyCap, (req, res) => {
  try {
    const result = federation.receiveDelivery(req.body);
    const body = result.body;
    if (result.httpStatus >= 200 && result.httpStatus < 300 && body.status === 'accepted') {
      res.set('Cache-Control', 'no-store');
    }
    res.status(result.httpStatus).json(body);
  } catch (error) {
    console.error('[Federation API] Inbox processing failed:', error.message);
    safeFailure(res, 500, 'Federation inbox processing failed.');
  }
});

module.exports = router;
