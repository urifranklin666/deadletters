const assert = require('node:assert/strict');
const test = require('node:test');
const { createRateLimiter } = require('../src/core/rate-limit');

function invoke(middleware, ip = '127.0.0.1') {
  let status = 200;
  let body;
  let advanced = false;
  const headers = {};
  const res = {
    set(name, value) { headers[name] = value; },
    status(value) { status = value; return this; },
    json(value) { body = value; return this; }
  };
  middleware({ ip }, res, () => { advanced = true; });
  return { status, body, headers, advanced };
}

test('rate limits a key and resets it after the window', () => {
  let timestamp = 1000;
  const limiter = createRateLimiter({ windowMs: 100, max: 2, now: () => timestamp });
  assert.equal(invoke(limiter).advanced, true);
  assert.equal(invoke(limiter).advanced, true);
  const limited = invoke(limiter);
  assert.equal(limited.status, 429);
  assert.equal(limited.advanced, false);
  assert.equal(limited.headers['Retry-After'], '1');

  timestamp += 101;
  assert.equal(invoke(limiter).advanced, true);
});

test('different clients and expired entries are independent', () => {
  let timestamp = 0;
  const limiter = createRateLimiter({ windowMs: 50, max: 1, now: () => timestamp });
  assert.equal(invoke(limiter, 'one').advanced, true);
  assert.equal(invoke(limiter, 'two').advanced, true);
  assert.equal(invoke(limiter, 'one').status, 429);
  timestamp = 51;
  assert.equal(invoke(limiter, 'one').advanced, true);
});

test('invalid limiter configuration fails at startup', () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }));
  assert.throws(() => createRateLimiter({ windowMs: 100, max: 0 }));
});
