const express = require('express');
const { requireAuth, optionalAuth } = require('../core/auth');
const { createReshare, getReshareStream } = require('../core/reshare-engine');
const { verifyReshareRecord } = require('../core/provenance');
const { importExternalMetadata } = require('../core/external-metadata');
const { getDb } = require('../core/db');
const { createRateLimiter } = require('../core/rate-limit');

const externalImportRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'External metadata import limit reached. Try again later.'
});

const router = express.Router();

// GET /api/v1/reshares/stream
router.get('/stream', optionalAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);
  const stream = getReshareStream(limit, offset);
  res.json({ reshares: stream });
});

// POST /api/v1/reshares (Create Re-letter)
router.post('/', requireAuth, (req, res) => {
  const {
    sourcePostId,
    sourceUrl,
    sourceNode,
    originalAuthor,
    originalTitle,
    originalExcerpt,
    curatorCommentary,
    featuredImage
  } = req.body;

  if (!sourcePostId && !sourceUrl) {
    return res.status(400).json({ error: 'Either sourcePostId (local) or sourceUrl (external) is required to re-letter.' });
  }

  try {
    const reshare = createReshare({
      userId: req.user.ID,
      sourcePostId: sourcePostId ? parseInt(sourcePostId, 10) : null,
      sourceUrl,
      sourceNode: sourceNode || (sourcePostId ? 'deadplug://local' : 'https://web.source'),
      originalAuthor: originalAuthor || 'Anonymous Creator',
      originalTitle: originalTitle || 'Untitled Letter',
      originalExcerpt: originalExcerpt || '',
      curatorCommentary: curatorCommentary || '',
      featuredImage
    });

    res.status(201).json({
      reshare,
      message: 'Letter reshared with editorial commentary.'
    });
  } catch (err) {
    console.error('[Reshares API] Failed to create reshare:', err);
    res.status(err.status || 500).json({ error: 'Failed to broadcast re-letter: ' + err.message });
  }
});

// POST /api/v1/reshares/import-external
router.post('/import-external', requireAuth, externalImportRateLimit, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'External URL required.' });
  }

  try {
    const data = await importExternalMetadata(url);
    res.json({ success: true, data });
  } catch (err) {
    res.status(422).json({
      error: 'Could not fetch external node metadata: ' + err.message,
      fallback: {
        sourceUrl: url,
        sourceNode: 'external-web',
        originalTitle: url,
        originalExcerpt: '',
        originalAuthor: 'External Node'
      }
    });
  }
});

// GET /api/v1/reshares/provenance/:id
router.get('/provenance/:id', (req, res) => {
  const db = getDb();
  const reshare = db.prepare('SELECT * FROM dl_reshares WHERE reshare_id = ? OR post_id = ?').get(req.params.id, req.params.id);
  if (!reshare) {
    return res.status(404).json({ error: 'Reshare provenance record not found.' });
  }

  let provenance = [];
  try {
    const parsed = JSON.parse(reshare.provenance_chain || '[]');
    if (Array.isArray(parsed)) provenance = parsed;
  } catch {}

  const verification = verifyReshareRecord(reshare);

  res.json({
    reshare_id: reshare.reshare_id,
    post_id: reshare.post_id,
    source_url: reshare.source_url,
    source_node: reshare.source_node,
    original_author: reshare.original_author,
    original_title: reshare.original_title,
    original_excerpt: reshare.original_excerpt,
    curator_commentary: reshare.curator_commentary,
    signature: reshare.signature,
    envelope_json: reshare.envelope_json || null,
    envelope_signature: reshare.envelope_signature || null,
    signature_algorithm: reshare.signature_algorithm || null,
    signed_at: reshare.signed_at || null,
    signature_valid: verification.signature_valid,
    hash_valid: verification.hash_valid,
    verification_status: verification.verification_status,
    verification_scope: verification.verification_scope,
    key_id: verification.key_id,
    envelope_hash: verification.envelope_hash,
    parent_envelope_hash: verification.parent_envelope_hash,
    public_key_url: verification.public_key_url,
    reason: verification.reason,
    provenance_chain: provenance
  });
});

module.exports = router;
