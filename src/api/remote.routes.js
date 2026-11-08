'use strict';

const express = require('express');
const { createRateLimiter } = require('../core/rate-limit');
const federation = require('../core/federation');

const router = express.Router();

// Public read-only projection of explicitly superadmin-promoted remote
// envelopes. It is deliberately modest: no authentication, no payloads, and a
// short shared-cache lifetime.
const remoteRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Remote exchange rate limit reached. Try again later.'
});

function parseBoundedInteger(value, defaultValue, minimum, maximum) {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return { error: true };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return { error: true };
  }
  return { value: parsed };
}

// GET /api/v1/remote?limit=&offset= — promoted remote exchange items only.
router.get('/', remoteRateLimit, (req, res) => {
  const limit = parseBoundedInteger(
    req.query.limit,
    federation.DEFAULT_REMOTE_LIMIT,
    1,
    federation.MAX_REMOTE_LIMIT
  );
  if (limit.error) {
    return res.status(400).json({
      error: `Remote exchange limit must be an integer between 1 and ${federation.MAX_REMOTE_LIMIT}.`
    });
  }

  const offset = parseBoundedInteger(
    req.query.offset,
    0,
    0,
    federation.MAX_REMOTE_OFFSET
  );
  if (offset.error) {
    return res.status(400).json({
      error: `Remote exchange offset must be an integer between 0 and ${federation.MAX_REMOTE_OFFSET}.`
    });
  }

  try {
    const result = federation.listPromotedRemote({ limit: limit.value, offset: offset.value });
    // Promotion and hiding must take effect immediately. This small public feed
    // is cheap to query and should not be browser-cached across moderation.
    res.set('Cache-Control', 'no-store');
    res.json({
      remote: result.items,
      total: result.total,
      limit: limit.value,
      offset: offset.value
    });
  } catch (error) {
    console.error('[Remote API] Listing failed:', error.message);
    return res.status(500).json({ error: 'Remote exchange listing failed.' });
  }
});

module.exports = router;
