const assert = require('node:assert/strict');
const test = require('node:test');
const {
  initialRouteFromPathname,
  renderMetadata,
  injectAppShell,
  serializeJson
} = require('../src/core/public-shell');

const shell = '<!doctype html><head><!-- DL_METADATA_START --><title>Default</title><!-- DL_METADATA_END --></head><body><!-- DL_INITIAL_ROUTE --></body>';

test('canonical paths produce safe initial SPA routes', () => {
  assert.deepEqual(initialRouteFromPathname('/letter/hello-world'), {
    type: 'letter', slug: 'hello-world', hash: '#/letter/hello-world', publicPath: '/letter/hello-world'
  });
  assert.equal(initialRouteFromPathname('/page/about/').hash, '#/page/about');
  assert.equal(initialRouteFromPathname('/admin').hash, '#/admin');
  assert.equal(initialRouteFromPathname('/reshares').hash, '#/reshares');
  assert.equal(initialRouteFromPathname('/remote').hash, '#/remote');
  assert.equal(initialRouteFromPathname('/letter/bad%2Fslash'), null);
  assert.equal(initialRouteFromPathname('/unrelated'), null);
});

test('public metadata is escaped and JSON-LD cannot close its script element', () => {
  const metadata = renderMetadata({
    post: {
      post_title: 'Hello </title><script>alert(1)</script>',
      post_excerpt: 'A "quoted" <description>',
      post_content: '',
      post_type: 'post',
      post_name: 'hello',
      post_status: 'publish',
      post_date: '2026-01-01T00:00:00Z',
      post_modified: '2026-01-02T00:00:00Z',
      featured_image: 'javascript:alert(1)',
      author_name: 'Editor <script>'
    },
    route: initialRouteFromPathname('/letter/hello'),
    site: { title: 'Node & Co', tagline: 'Independent <letters>', url: 'https://node.example' },
    requestOrigin: 'https://request.example',
    hookEngine: { applyFilters: (_name, tags) => tags }
  });

  assert.doesNotMatch(metadata, /<script>alert/);
  assert.match(metadata, /&lt;\/title&gt;/);
  assert.match(metadata, /Node &amp; Co/);
  assert.match(metadata, /rel="canonical" href="https:\/\/node.example\/letter\/hello"/);
  assert.doesNotMatch(metadata, /javascript:alert/);
  assert.match(metadata, /application\/ld\+json/);
});

test('SEO filters run but malformed replacements retain required metadata', () => {
  let called = false;
  const metadata = renderMetadata({
    post: null,
    route: initialRouteFromPathname('/reshares'),
    site: { title: 'Node', tagline: 'Letters', url: 'https://node.example' },
    requestOrigin: 'https://request.example',
    hookEngine: {
      applyFilters(name, tags) {
        called = true;
        assert.equal(name, 'render_meta_tags');
        return [{ property: 'og:title', content: '' }, { name: 'description', content: null }];
      }
    }
  });
  assert.equal(called, true);
  assert.match(metadata, /property="og:title" content="Node"/);
  assert.match(metadata, /name="description" content="Letters"/);
});

test('remote exchange canonical metadata points at the public remote path', () => {
  const metadata = renderMetadata({
    post: null,
    route: initialRouteFromPathname('/remote'),
    site: { title: 'Node', tagline: 'Letters', url: 'https://node.example' },
    requestOrigin: 'https://request.example',
    hookEngine: { applyFilters: (_name, tags) => tags }
  });
  assert.match(metadata, /rel="canonical" href="https:\/\/node.example\/remote"/);
  assert.match(metadata, /<title>Node<\/title>/);
});

test('shell injection preserves markers for later renders and serializes the route', () => {
  const rendered = injectAppShell(shell, initialRouteFromPathname('/installer'), '<title>Install</title>');
  assert.match(rendered, /<title>Install<\/title>/);
  assert.match(rendered, /id="dl-initial-route"/);
  assert.match(rendered, /#\/installer/);
  assert.throws(() => injectAppShell('<html></html>', { hash: '#/' }, ''));
  assert.equal(serializeJson({ value: '</script>' }), '{"value":"\\u003c/script\\u003e"}');
});
