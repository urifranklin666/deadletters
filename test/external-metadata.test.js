const test = require('node:test');
const assert = require('node:assert/strict');

const { importExternalMetadata } = require('../src/core/external-metadata');

const PUBLIC_IPV4 = '93.184.216.34';

function publicLookup(address = PUBLIC_IPV4) {
  return async hostname => [{ address, family: address.includes(':') ? 6 : 4 }];
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: init.status || 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

test('imports metadata, decodes entities, and resolves canonical and image URLs', async () => {
  const html = `<!doctype html>
    <html><head>
      <title>Fallback title</title>
      <meta content="A &quot;title&quot; &amp; more" property="og:title">
      <meta name="description" content="Fallback description">
      <meta content="OG &hellip; excerpt" property="og:description">
      <meta name="author" content="By &copy; Ada &#x2014; Editor">
      <meta content="/images/hero.jpg?a=1&amp;b=2" property="og:image">
      <link href="/canonical" rel="alternate canonical">
      <script>const fake = '<meta property="og:title" content="Wrong">';</script>
    </head></html>`;

  let fetchOptions;
  const result = await importExternalMetadata('https://example.com/articles/original', {
    lookup: publicLookup(),
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.com/articles/original');
      fetchOptions = options;
      return htmlResponse(html);
    }
  });

  assert.deepEqual(result, {
    sourceUrl: 'https://example.com/canonical',
    sourceNode: 'example.com',
    originalTitle: 'A "title" & more',
    originalExcerpt: 'OG … excerpt',
    originalAuthor: 'By © Ada — Editor',
    featuredImage: 'https://example.com/images/hero.jpg?a=1&b=2'
  });
  assert.equal(fetchOptions.redirect, 'manual');
  assert.ok(fetchOptions.signal instanceof AbortSignal);
});

test('rejects private, loopback, link-local, multicast, reserved, and unspecified addresses', async t => {
  const addresses = [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.1.1',
    '224.0.0.1',
    '240.0.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::',
    '::ffff:127.0.0.1'
  ];

  for (const address of addresses) {
    await t.test(address, async () => {
      let fetched = false;
      await assert.rejects(
        importExternalMetadata('https://destination.test/', {
          lookup: publicLookup(address),
          fetch: async () => {
            fetched = true;
            return htmlResponse('<title>Must not load</title>');
          }
        }),
        /unsafe address/
      );
      assert.equal(fetched, false);
    });
  }
});

test('checks IP literals directly and rejects a mixed public/private DNS answer', async () => {
  let fetched = false;
  const fetch = async () => {
    fetched = true;
    return htmlResponse('ok');
  };

  await assert.rejects(
    importExternalMetadata('http://127.0.0.1/', {
      lookup: async () => [{ address: PUBLIC_IPV4, family: 4 }],
      fetch
    }),
    /unsafe address/
  );
  await assert.rejects(
    importExternalMetadata('https://destination.test/', {
      lookup: async () => [
        { address: PUBLIC_IPV4, family: 4 },
        { address: '192.168.1.20', family: 4 }
      ],
      fetch
    }),
    /unsafe address/
  );
  assert.equal(fetched, false);
});

test('revalidates every redirect and blocks a redirect to a private address', async () => {
  const lookups = [];
  const fetched = [];

  await assert.rejects(
    importExternalMetadata('https://public.test/start', {
      lookup: async hostname => {
        lookups.push(hostname);
        return [{
          address: hostname === 'private.test' ? '172.16.0.8' : PUBLIC_IPV4,
          family: 4
        }];
      },
      fetch: async url => {
        fetched.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://private.test/landing' }
        });
      }
    }),
    /unsafe address/
  );

  assert.deepEqual(lookups, ['public.test', 'private.test']);
  assert.deepEqual(fetched, ['https://public.test/start']);
});

test('allows at most three redirects and validates each redirect URL', async () => {
  let calls = 0;
  await assert.rejects(
    importExternalMetadata('https://example.com/0', {
      lookup: publicLookup(),
      fetch: async url => {
        calls += 1;
        const number = Number(new URL(url).pathname.slice(1));
        return new Response(null, {
          status: 301,
          headers: { location: `/${number + 1}` }
        });
      }
    }),
    /maximum of 3 redirects/
  );
  assert.equal(calls, 4);
});

test('rejects invalid protocols, credentials, and nonstandard ports before fetching', async () => {
  const invalidUrls = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'http://example.com:8080/'
  ];

  for (const url of invalidUrls) {
    await assert.rejects(
      importExternalMetadata(url, {
        lookup: publicLookup(),
        fetch: async () => {
          throw new Error('fetch must not be called');
        }
      })
    );
  }
});

test('requires a successful HTML response', async () => {
  await assert.rejects(
    importExternalMetadata('https://example.com/json', {
      lookup: publicLookup(),
      fetch: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }),
    /HTML response/
  );

  await assert.rejects(
    importExternalMetadata('https://example.com/missing', {
      lookup: publicLookup(),
      fetch: async () => htmlResponse('missing', { status: 404 })
    }),
    /HTTP 404/
  );
});

test('caps the response body at 1 MiB', async () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1, 65);
  await assert.rejects(
    importExternalMetadata('https://example.com/large', {
      lookup: publicLookup(),
      fetch: async () => htmlResponse(oversized)
    }),
    /1 MiB body limit/
  );
});

test('tolerates malformed HTML and retains safe fallbacks', async () => {
  const result = await importExternalMetadata('https://example.com/malformed', {
    lookup: publicLookup(),
    fetch: async () => htmlResponse(
      '<html><head><title>Fallback &amp; title</title><meta name="description" content="unterminated'
    )
  });

  assert.deepEqual(result, {
    sourceUrl: 'https://example.com/malformed',
    sourceNode: 'example.com',
    originalTitle: 'Fallback & title',
    originalExcerpt: 'unterminated',
    originalAuthor: 'example.com',
    featuredImage: null
  });
});

test('drops unsafe metadata URLs instead of returning them', async () => {
  const result = await importExternalMetadata('https://example.com/safe', {
    lookup: publicLookup(),
    fetch: async () => htmlResponse(`
      <link rel="canonical" href="https://user:pass@canonical.test/private">
      <meta property="og:image" content="javascript:alert(1)">
      <meta property="og:title" content="Safe title">
    `)
  });

  assert.equal(result.sourceUrl, 'https://example.com/safe');
  assert.equal(result.featuredImage, null);
});

test('aborts a stalled request at the configured timeout', async () => {
  await assert.rejects(
    importExternalMetadata('https://example.com/slow', {
      timeoutMs: 20,
      lookup: publicLookup(),
      fetch: async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    }),
    /timed out/
  );
});
