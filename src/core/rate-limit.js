function createRateLimiter({
  windowMs,
  max,
  message = 'Too many requests. Please try again later.',
  keyGenerator = req => req.ip || req.socket?.remoteAddress || 'unknown',
  now = () => Date.now()
}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isInteger(max) || max < 1) {
    throw new Error('Rate limiter requires a positive window and request limit.');
  }

  const attempts = new Map();
  let lastSweep = 0;

  return (req, res, next) => {
    const timestamp = now();
    if (timestamp - lastSweep >= windowMs) {
      for (const [key, record] of attempts) {
        if (timestamp - record.startedAt >= windowMs) attempts.delete(key);
      }
      lastSweep = timestamp;
    }

    const key = String(keyGenerator(req));
    let record = attempts.get(key);
    if (!record || timestamp - record.startedAt >= windowMs) {
      record = { startedAt: timestamp, count: 0 };
      attempts.set(key, record);
    }

    if (record.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((record.startedAt + windowMs - timestamp) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    record.count += 1;
    next();
  };
}

module.exports = { createRateLimiter };
