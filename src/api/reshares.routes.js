const express = require('express');
const { requireAuth, optionalAuth } = require('../core/auth');
const { createReshare, getReshareStream } = require('../core/reshare-engine');
const { getDb } = require('../core/db');

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
    res.status(500).json({ error: 'Failed to broadcast re-letter: ' + err.message });
  }
});

// POST /api/v1/reshares/import-external
router.post('/import-external', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'External URL required.' });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Deadletters-Bot/1.0 (+https://deadplug.digital)' },
      signal: AbortSignal.timeout(5000)
    });
    const html = await response.text();

    // Basic regex extraction of metadata
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<title>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    const authorMatch = html.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i);

    const title = titleMatch ? titleMatch[1].trim() : url;
    const excerpt = descMatch ? descMatch[1].trim() : '';
    const image = imageMatch ? imageMatch[1].trim() : null;
    const author = authorMatch ? authorMatch[1].trim() : new URL(url).hostname;

    res.json({
      success: true,
      data: {
        sourceUrl: url,
        sourceNode: new URL(url).hostname,
        originalTitle: title,
        originalExcerpt: excerpt,
        originalAuthor: author,
        featuredImage: image
      }
    });
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

  res.json({
    reshare_id: reshare.reshare_id,
    post_id: reshare.post_id,
    source_url: reshare.source_url,
    source_node: reshare.source_node,
    signature: reshare.signature,
    provenance_chain: JSON.parse(reshare.provenance_chain || '[]')
  });
});

module.exports = router;
