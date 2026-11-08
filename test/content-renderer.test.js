'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderContent,
  renderExcerpt
} = require('../src/core/content-renderer');

test('exports a small API and handles empty input', () => {
  assert.equal(renderContent(''), '');
  assert.equal(renderContent(null), '');
  assert.equal(renderContent(undefined), '');
  assert.equal(renderExcerpt(''), '');
  assert.equal(renderExcerpt(null), '');
});

test('renders normal Markdown, links, images, lists, and code', () => {
  const html = renderContent([
    '# Heading',
    '',
    'A **bold** and *emphasized* [link](https://example.com "Example").',
    '',
    '- one',
    '- two',
    '',
    '![Alt text](/images/photo.jpg "Photo")',
    '',
    '```js',
    'const safe = true;',
    '```'
  ].join('\n'));

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>emphasized<\/em>/);
  assert.match(html, /<a href="https:\/\/example.com" title="Example">link<\/a>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<img src="\/images\/photo.jpg" alt="Alt text" title="Photo" \/>/);
  assert.match(html, /<pre><code>const safe = true;\n<\/code><\/pre>/);
});

test('rendering is deterministic and does not alter code samples', () => {
  const source = '`[glitch]inline[/glitch]`\n\n```md\n[callout type="alert"]code[/callout]\n```';
  const first = renderContent(source);

  assert.equal(first, renderContent(source));
  assert.match(first, /<code>\[glitch\]inline\[\/glitch\]<\/code>/);
  assert.match(first, /\[callout type="alert"\]code\[\/callout\]/);
  assert.doesNotMatch(first, /dl-glitch-text|dl-callout-alert/);
});

test('renders pullquotes with Markdown bodies and escaped authors', () => {
  const html = renderContent('[pullquote author="Ada & <Admin>"]A **bold** quote.[/pullquote]');

  assert.match(html, /^<figure class="dl-editorial-pullquote">/);
  assert.match(html, /<blockquote class="dl-quote-body"><p>A <strong>bold<\/strong> quote\.<\/p>/);
  assert.match(html, /<figcaption class="dl-quote-author">\/\/ Ada &amp; &lt;Admin&gt;<\/figcaption>/);
  assert.doesNotMatch(html, /<Admin>/);
});

test('renders multiline pullquotes and omits an absent author caption', () => {
  const html = renderContent('[pullquote]\nFirst paragraph.\n\nSecond *paragraph*.\n[/pullquote]');

  assert.match(html, /<p>First paragraph\.<\/p>/);
  assert.match(html, /<p>Second <em>paragraph<\/em>\.<\/p>/);
  assert.doesNotMatch(html, /dl-quote-author/);
});

test('renders every known callout type and defaults to notice', () => {
  for (const type of ['alert', 'notice', 'info', 'success', 'warning', 'error']) {
    const html = renderContent(`[callout type="${type}"]Important **body**.[/callout]`);
    assert.match(html, new RegExp(`class="dl-callout dl-callout-${type}"`));
    assert.match(html, new RegExp(`// SYSTEM NOTICE // ${type.toUpperCase()}`));
    assert.match(html, /<div class="dl-callout-body"><p>Important <strong>body<\/strong>\.<\/p>/);
  }

  const defaultHtml = renderContent('[callout]Default body.[/callout]');
  assert.match(defaultHtml, /class="dl-callout dl-callout-notice"/);
});

test('unknown callout types cannot inject arbitrary classes', () => {
  const html = renderContent('[callout type="alert evil onmouseover=alert(1)"]Body[/callout]');

  assert.match(html, /class="dl-callout dl-callout-notice"/);
  assert.doesNotMatch(html, /dl-callout-alert|dl-callout-evil|onmouseover=alert/);
});

test('renders glitch inline with Markdown and an escaped data attribute', () => {
  const html = renderContent('Before [glitch]LOUD **SIGNAL**[/glitch] after.');

  assert.match(html, /^<p>Before <span class="dl-glitch-text" data-text="LOUD \*\*SIGNAL\*\*">/);
  assert.match(html, /LOUD <strong>SIGNAL<\/strong><\/span> after\.<\/p>\n$/);
});

test('escapes glitch body text before placing it in data-text', () => {
  const html = renderContent('[glitch]BAD " onmouseover="alert(1) <img src=x>[/glitch]');

  assert.match(html, /data-text="BAD &quot; onmouseover=&quot;alert\(1\) &lt;img src=x&gt;"/);
  assert.match(html, /<img src="x" \/>/);
  assert.doesNotMatch(html, /onerror=|<script/i);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('renders dropcaps inline and supports inline Markdown', () => {
  const html = renderContent('[dropcap]T[/dropcap]est and [dropcap]**A**[/dropcap]gain.');

  assert.equal(html, '<p><span class="dl-dropcap">T</span>est and <span class="dl-dropcap"><strong>A</strong></span>gain.</p>\n');
});

test('removes scripts, styles, embeds, and event handlers from raw HTML', () => {
  const html = renderContent([
    '<script>alert(1)</script>',
    '<style>body { display: none }</style>',
    '<p onclick="alert(1)" style="color:red">Safe <em>markup</em></p>',
    '<svg onload="alert(1)"><script>alert(2)</script></svg>',
    '<iframe src="https://evil.example"></iframe>'
  ].join('\n'));

  assert.match(html, /<p>Safe <em>markup<\/em><\/p>/);
  assert.doesNotMatch(html, /<script|<style|<svg|<iframe|onclick=|onload=|style=/i);
  assert.doesNotMatch(html, /alert\(1\)|display: none/);
});

test('rejects a shortcode with unknown attributes instead of trusting it', () => {
  const html = renderContent('[pullquote author="Alice" onclick="alert(1)"]Quote <script>alert(2)</script>[/pullquote]');

  assert.doesNotMatch(html, /<figure|<script/i);
  assert.doesNotMatch(html, /alert\(2\)/);
  assert.match(html, /Quote/);
});

test('sanitizes raw component classes and their attributes', () => {
  const html = renderContent('<div class="dl-callout dl-callout-alert arbitrary" onclick="alert(1)">Body</div><span class="dl-dropcap other" data-x="bad">D</span>');

  assert.match(html, /<div class="dl-callout dl-callout-alert">Body<\/div>/);
  assert.match(html, /<span class="dl-dropcap">D<\/span>/);
  assert.doesNotMatch(html, /arbitrary|other|onclick=|data-x=/);
});

test('strips dangerous Markdown link protocols', () => {
  const sources = [
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](vbscript:msgbox(1))',
    '[click](data:text/html;base64,PHNjcmlwdD4=)',
    '[click](javascript&#58;alert(1))',
    '[click](//protocol-relative.example/path)',
    '[click](ftp://example.com/file)'
  ];

  for (const source of sources) {
    const html = renderContent(source);
    assert.match(html, /<a(?: title="[^"]*")?>click<\/a>/, source);
    assert.doesNotMatch(html, /href=/i, source);
  }
});

test('strips dangerous raw HTML links and obfuscated protocols', () => {
  const html = renderContent('<a href="java&#x73;cript&#58;alert(1)" onclick="alert(2)" target="_blank">click</a>');

  assert.equal(html, '<p><a>click</a></p>\n');
});

test('preserves safe HTTP, mail, telephone, root-relative, and fragment links', () => {
  const html = renderContent([
    '[web](https://example.com/path?q=1)',
    '[mail](mailto:editor@example.com)',
    '[phone](tel:+123456789)',
    '[local](/letters/one)',
    '[fragment](#section)'
  ].join(' '));

  assert.match(html, /href="https:\/\/example.com\/path\?q=1"/);
  assert.match(html, /href="mailto:editor@example.com"/);
  assert.match(html, /href="tel:\+123456789"/);
  assert.match(html, /href="\/letters\/one"/);
  assert.match(html, /href="#section"/);
});

test('preserves safe images and removes dangerous image URLs and handlers', () => {
  const safe = renderContent('![Safe](https://example.com/image.png) ![Local](images/local.png)');
  const dangerous = renderContent('![Data](data:image/png;base64,abc) ![Script](javascript:alert(1)) <img src="https://example.com/x.png" onerror="alert(1)" alt="Raw">');

  assert.match(safe, /<img src="https:\/\/example.com\/image.png" alt="Safe" \/>/);
  assert.match(safe, /<img src="images\/local.png" alt="Local" \/>/);
  assert.match(dangerous, /<img alt="Data" \/>/);
  assert.match(dangerous, /<img alt="Script" \/>/);
  assert.match(dangerous, /<img src="https:\/\/example.com\/x.png" alt="Raw" \/>/);
  assert.doesNotMatch(dangerous, /onerror=|data:image|javascript:/i);
});

test('malformed and unterminated shortcodes remain inert', () => {
  const source = [
    '[glitch]Unterminated <img src=x onerror=alert(1)>',
    '[dropcap onclick="alert(1)"]D[/dropcap]',
    '[pullquote author="unterminated]Quote',
    '[callout type=alert]Body[/callout]',
    '[unknown]<script>alert(2)</script>[/unknown]'
  ].join('\n\n');
  const html = renderContent(source);

  assert.doesNotMatch(html, /dl-glitch-text|dl-dropcap|dl-editorial-pullquote|dl-callout/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\s(?:onerror|onclick)=/i);
  assert.doesNotMatch(html, /alert\(2\)/);
});

test('excerpts are decoded plain text with structural whitespace', () => {
  const source = [
    '# Hello & goodbye',
    '',
    'A **bold** [link](https://example.com).',
    '',
    '[pullquote author="Ada"]A *quote*.[/pullquote]',
    '',
    '[callout type="alert"]Pay attention.[/callout]',
    '',
    '[glitch]SIGNAL[/glitch] [dropcap]T[/dropcap]est'
  ].join('\n');

  assert.equal(
    renderExcerpt(source),
    'Hello & goodbye A bold link. A quote. // Ada Pay attention. SIGNAL Test'
  );
});

test('excerpts discard unsafe raw HTML and preserve safe text', () => {
  const excerpt = renderExcerpt('<script>alert(1)</script><p>Safe &amp; sound<br>next &lt;line&gt;</p><style>x{}</style>');

  assert.equal(excerpt, 'Safe & sound next <line>');
  assert.doesNotMatch(excerpt, /alert\(|<p|<br|<style/);
});

test('excerpts include image alt text without losing surrounding text', () => {
  assert.equal(
    renderExcerpt('Before ![Alt & <caption>](https://example.com/x.png) after'),
    'Before Alt & <caption> after'
  );
});

test('excerpt limits are deterministic and default to 160 characters', () => {
  assert.equal(renderExcerpt('a'.repeat(200)).length, 160);
  assert.equal(renderExcerpt('abcdefghij', 5), 'abcde');
  assert.equal(renderExcerpt('short', 20), 'short');
  assert.equal(renderExcerpt('short', 0), '');
  assert.equal(renderExcerpt('short', -1), '');
});

test('excerpt truncation does not split Unicode surrogate pairs', () => {
  assert.equal(renderExcerpt('A😀B', 2), 'A😀');
  assert.equal(renderExcerpt('A😀B', 3), 'A😀B');
});
