'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { XMLValidator } = require('fast-xml-parser');

const sandbox = fs.mkdtempSync('/tmp/opencode/deadletters-wxr-test-');
process.env.DEADLETTERS_DATA_DIR = path.join(sandbox, 'data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(sandbox, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(sandbox, 'addons');
process.env.DB_PATH = path.join(sandbox, 'data', 'test.db');
process.env.JWT_SECRET = 'wxr-test-secret-that-is-long-enough-for-local-tests';
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const { closeDb, getDb, updateOption } = require('../src/core/db');
const { signToken } = require('../src/core/auth');
const {
  exportWxr,
  importWxr,
  MAX_WXR_XML_BYTES
} = require('../src/core/wxr');

function createUser(login, role = 'author') {
  const result = getDb().prepare(`
    INSERT INTO dl_users (user_login, user_pass, user_email, display_name, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(login, 'test-only-nonempty-password-hash', `${login}@example.test`, login, role);
  return Number(result.lastInsertRowid);
}

function clearContent({ includeUsers = true } = {}) {
  const db = getDb();
  db.exec(`
    DELETE FROM dl_comments;
    DELETE FROM dl_term_relationships;
    DELETE FROM dl_revisions;
    DELETE FROM dl_postmeta;
    DELETE FROM dl_reshares;
    DELETE FROM dl_posts;
    DELETE FROM dl_term_taxonomy;
    DELETE FROM dl_terms;
    DELETE FROM dl_options;
  `);
  if (includeUsers) db.exec('DELETE FROM dl_users;');
}

function standardWxr(items, definitions = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>${definitions}${items}</channel>
</rss>`;
}

function standardItem({
  id = 1,
  title = 'Imported letter',
  slug = 'imported-letter',
  type = 'post',
  status = 'publish',
  creator = 'missing-author',
  content = 'Raw **Markdown**',
  excerpt,
  terms = '',
  comments = ''
} = {}) {
  return `<item>
<title>${title}</title>
<dc:creator>${creator}</dc:creator>
<content:encoded><![CDATA[${content}]]></content:encoded>
${excerpt === undefined ? '' : `<excerpt:encoded><![CDATA[${excerpt}]]></excerpt:encoded>`}
<wp:post_id>${id}</wp:post_id>
<wp:post_date>2024-01-02 03:04:05</wp:post_date>
<wp:post_name>${slug}</wp:post_name>
<wp:status>${status}</wp:status>
<wp:post_type>${type}</wp:post_type>
${terms}${comments}
</item>`;
}

function temporaryFiles() {
  const directory = path.join(config.dataDir, 'temp_uploads');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

test.beforeEach(() => {
  clearContent();
});

test.after(() => {
  closeDb();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('imports WXR namespaces, XML entities, CDATA, author mapping, and explicit skips', () => {
  const defaultUserId = createUser('default-admin', 'superadmin');
  const authorId = createUser('ada');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:w="http://wordpress.org/export/1.2/"
  xmlns:c="http://purl.org/rss/1.0/modules/content/"
  xmlns:e="http://wordpress.org/export/1.2/excerpt/"
  xmlns:d="http://purl.org/dc/elements/1.1/">
<channel>
<w:author>
  <w:author_id>88</w:author_id>
  <w:author_login><![CDATA[ada]]></w:author_login>
  <w:author_email>ada@example.test</w:author_email>
</w:author>
<w:category>
  <w:term_id>10</w:term_id>
  <w:category_nicename>research</w:category_nicename>
  <w:cat_name>Research &amp; Development</w:cat_name>
</w:category>
<item>
  <title>Signals &amp; Science &#x1F600;</title>
  <d:creator><![CDATA[ada]]></d:creator>
  <c:encoded><![CDATA[# Heading

**bold** &amp; &#38; <tag> <!DOCTYPE html>]]></c:encoded>
  <e:encoded>Explicit &amp; &lt;excerpt&gt;</e:encoded>
  <w:post_id>42</w:post_id>
  <w:post_date><![CDATA[2024-03-04 05:06:07]]></w:post_date>
  <w:post_name>signals</w:post_name>
  <w:status>private</w:status>
  <w:post_type>post</w:post_type>
  <w:is_sticky>1</w:is_sticky>
  <category domain="category" nicename="research"><![CDATA[Research & Development]]></category>
</item>
<item>
  <title>Media attachment</title>
  <w:post_id>43</w:post_id>
  <w:post_type>attachment</w:post_type>
</item>
</channel>
</rss>`;

  const result = importWxr(xml, defaultUserId);
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE post_name = ?').get('signals');

  assert.equal(result.totalItems, 2);
  assert.equal(result.importedPosts, 1);
  assert.equal(result.importedPages, 0);
  assert.equal(result.skippedItems, 1);
  assert.deepEqual(result.skippedTypes, { attachment: 1 });
  assert.equal(result.authorsMapped, 1);
  assert.equal(result.importedRelationships, 1);
  assert.equal(post.post_author, authorId);
  assert.equal(post.post_title, 'Signals & Science 😀');
  assert.equal(post.post_content, '# Heading\n\n**bold** &amp; &#38; <tag> <!DOCTYPE html>');
  assert.equal(post.post_excerpt, 'Explicit & <excerpt>');
  assert.equal(post.post_date, '2024-03-04 05:06:07');
  assert.equal(post.post_status, 'private');
  assert.equal(post.is_sticky, 1);
  assert.match(post.drop_code, /^POST-\d{4}-[A-F0-9]{6}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_users').get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dl_posts WHERE post_type = 'attachment'").get().count, 0);
  assert.deepEqual(db.prepare(`
    SELECT t.name, t.slug, tt.taxonomy, tt.count
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
  `).all(), [{ name: 'Research & Development', slug: 'research', taxonomy: 'category', count: 1 }]);
});

test('malformed XML, unknown entities, and DTDs never partially import content', () => {
  const defaultUserId = createUser('default-admin', 'superadmin');
  const db = getDb();
  const category = '<wp:category><wp:category_nicename>rollback</wp:category_nicename><wp:cat_name>Rollback</wp:cat_name></wp:category>';
  const malformed = standardWxr(
    standardItem({ title: 'Would be inserted', slug: 'rollback-post' }) +
    '<item><title>Broken</item>',
    category
  );

  const before = {
    posts: db.prepare('SELECT COUNT(*) AS count FROM dl_posts').get().count,
    terms: db.prepare('SELECT COUNT(*) AS count FROM dl_terms').get().count,
    users: db.prepare('SELECT COUNT(*) AS count FROM dl_users').get().count
  };
  assert.throws(() => importWxr(malformed, defaultUserId), /Malformed XML|Expected closing tag/);
  assert.throws(
    () => importWxr(standardWxr(standardItem({ slug: 'trailing-junk' })) + 'trailing-junk', defaultUserId),
    /Malformed XML: (?:Extra text|unexpected content)/
  );
  assert.throws(() => importWxr(standardWxr(standardItem({ title: '&undefined;' })), defaultUserId), /Unsupported XML entity/);
  assert.throws(() => importWxr(
    '<!DOCTYPE rss [<!ENTITY external SYSTEM "https://example.test/entity">]>' +
      standardWxr(standardItem({ title: '&external;' })),
    defaultUserId
  ), /DTD and external-entity/);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_posts').get().count, before.posts);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_terms').get().count, before.terms);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_users').get().count, before.users);
  assert.throws(() => importWxr(standardWxr(standardItem()), 999999), /existing account/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_users').get().count, before.users);
});

test('duplicate slugs and drop codes are unique, statuses survive, and excerpts use the shared renderer', () => {
  const defaultUserId = createUser('default-admin', 'superadmin');
  const db = getDb();
  db.prepare(`
    INSERT INTO dl_posts (post_author, post_title, post_name, post_content, drop_code)
    VALUES (?, 'Existing', 'same-slug', '', 'POST-2026-AAAAAA')
  `).run(defaultUserId);

  const result = importWxr(standardWxr([
    standardItem({ id: 1, title: 'First', slug: 'same-slug', content: '# Hello\n\nA **bold** signal.', status: 'publish' }),
    standardItem({ id: 2, title: 'Second', slug: 'same-slug', type: 'page', status: 'private' }),
    standardItem({ id: 3, title: 'Third', slug: 'same-slug', status: 'draft' })
  ].join('')), defaultUserId);

  const imported = db.prepare("SELECT * FROM dl_posts WHERE post_title IN ('First', 'Second', 'Third') ORDER BY ID").all();
  assert.equal(result.importedPosts, 2);
  assert.equal(result.importedPages, 1);
  assert.deepEqual(imported.map(post => post.post_name), ['same-slug-2', 'same-slug-3', 'same-slug-4']);
  assert.deepEqual(imported.map(post => post.post_status), ['publish', 'private', 'draft']);
  assert.equal(imported[0].post_excerpt, 'Hello A bold signal.');
  assert.equal(new Set(imported.map(post => post.drop_code)).size, 3);
  assert.equal(imported.some(post => post.drop_code === 'POST-2026-AAAAAA'), false);
  assert.equal(imported.every(post => post.post_author === defaultUserId), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dl_users').get().count, 1);
});

test('export safely splits CDATA and round-trips posts, pages, terms, parents, and approved/pending comments', () => {
  const db = getDb();
  const defaultUserId = createUser('default-admin', 'superadmin');
  const authorId = createUser('ada');
  updateOption('site_title', 'WXR & Roundtrip');
  updateOption('site_tagline', 'Raw <Markdown>');
  updateOption('site_url', 'https://example.test');

  const newsId = Number(db.prepare("INSERT INTO dl_terms (name, slug) VALUES ('News', 'news')").run().lastInsertRowid);
  const researchId = Number(db.prepare("INSERT INTO dl_terms (name, slug) VALUES ('Research', 'research')").run().lastInsertRowid);
  const tagId = Number(db.prepare("INSERT INTO dl_terms (name, slug) VALUES ('XML & Data', 'xml-data')").run().lastInsertRowid);
  const newsTaxonomy = Number(db.prepare("INSERT INTO dl_term_taxonomy (term_id, taxonomy, description) VALUES (?, 'category', 'News description')").run(newsId).lastInsertRowid);
  const researchTaxonomy = Number(db.prepare("INSERT INTO dl_term_taxonomy (term_id, taxonomy, description, parent) VALUES (?, 'category', 'Research description', ?)").run(researchId, newsId).lastInsertRowid);
  const tagTaxonomy = Number(db.prepare("INSERT INTO dl_term_taxonomy (term_id, taxonomy, description) VALUES (?, 'post_tag', 'Tag description')").run(tagId).lastInsertRowid);

  const markdown = 'Raw **Markdown** with ]]> and &amp; <xml> 😀';
  const excerpt = 'Excerpt & <raw> ]]>.';
  const postId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_date, post_date_gmt, post_content, post_title,
      post_excerpt, post_status, comment_status, post_name, post_modified,
      post_type, comment_count, drop_code, is_sticky, menu_order
    ) VALUES (?, ?, ?, ?, 'Roundtrip post', ?, 'private', 'open', 'roundtrip-post', ?,
      'post', 99, 'POST-2024-BBBBBB', 1, 7)
  `).run(authorId, '2024-02-03 04:05:06', '2024-02-03 04:05:06', markdown, excerpt, '2024-02-04 04:05:06').lastInsertRowid);
  const pageId = Number(db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_date, post_content, post_title, post_excerpt,
      post_status, post_name, post_type, post_parent, drop_code
    ) VALUES (?, '2024-03-01 00:00:00', 'Page **body**', 'Roundtrip page', 'Page excerpt',
      'draft', 'roundtrip-page', 'page', ?, 'PAGE-2024-CCCCCC')
  `).run(defaultUserId, postId).lastInsertRowid);
  db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)').run(postId, newsTaxonomy);
  db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)').run(postId, tagTaxonomy);
  db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)').run(pageId, researchTaxonomy);

  const approvedId = Number(db.prepare(`
    INSERT INTO dl_comments (
      comment_post_ID, comment_author, comment_author_email, comment_author_url,
      comment_author_IP, comment_date, comment_content, comment_approved, user_id
    ) VALUES (?, 'Reader & Co', 'reader@example.test', 'https://reader.example/?a=1&b=2',
      '127.0.0.1', '2024-02-05 00:00:00', 'Approved ]]> &amp; <text>', '1', ?)
  `).run(postId, authorId).lastInsertRowid);
  db.prepare(`
    INSERT INTO dl_comments (
      comment_post_ID, comment_author, comment_author_email, comment_date,
      comment_content, comment_approved, comment_parent
    ) VALUES (?, 'Pending reader', 'pending@example.test', '2024-02-06 00:00:00',
      'Pending **comment**', '0', ?)
  `).run(postId, approvedId);
  db.prepare(`
    INSERT INTO dl_comments (comment_post_ID, comment_author, comment_content, comment_approved)
    VALUES (?, 'Spammer', 'Do not export spam', 'spam')
  `).run(postId);

  db.prepare("INSERT INTO dl_posts (post_author, post_title, post_name, post_type) VALUES (?, 'secret-reshare', 'secret-reshare', 'reshare')").run(defaultUserId);
  db.prepare("INSERT INTO dl_revisions (post_id, author_id, post_content) VALUES (?, ?, 'revision-secret')").run(postId, authorId);
  db.prepare("INSERT INTO dl_postmeta (post_id, meta_key, meta_value) VALUES (?, 'arbitrary', 'meta-secret')").run(postId);

  const xml = exportWxr();
  assert.equal(XMLValidator.validate(xml), true);
  assert.match(xml, /\]\]\]\]><!\[CDATA\[>/);
  assert.doesNotMatch(xml, /user_pass|test-only-nonempty-password-hash|secret-reshare|revision-secret|meta-secret|Do not export spam/);
  assert.match(xml, /<category domain="category" nicename="news">/);
  assert.match(xml, /<category domain="post_tag" nicename="xml-data">/);

  clearContent({ includeUsers: false });
  const result = importWxr(xml, defaultUserId);
  const importedPost = db.prepare("SELECT * FROM dl_posts WHERE post_name = 'roundtrip-post'").get();
  const importedPage = db.prepare("SELECT * FROM dl_posts WHERE post_name = 'roundtrip-page'").get();

  assert.equal(result.importedPosts, 1);
  assert.equal(result.importedPages, 1);
  assert.equal(result.importedComments, 2);
  assert.equal(result.approvedComments, 1);
  assert.equal(result.pendingComments, 1);
  assert.equal(result.importedRelationships, 3);
  assert.equal(importedPost.post_content, markdown);
  assert.equal(importedPost.post_excerpt, excerpt);
  assert.equal(importedPost.post_author, authorId);
  assert.equal(importedPost.post_status, 'private');
  assert.equal(importedPost.post_date, '2024-02-03 04:05:06');
  assert.equal(importedPost.post_modified, '2024-02-04 04:05:06');
  assert.equal(importedPost.is_sticky, 1);
  assert.equal(importedPost.menu_order, 7);
  assert.equal(importedPost.comment_count, 1);
  assert.equal(importedPage.post_status, 'draft');
  assert.equal(importedPage.post_parent, importedPost.ID);

  const terms = db.prepare(`
    SELECT t.slug, tt.taxonomy, tt.description, tt.parent, tt.count
    FROM dl_terms t JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    ORDER BY t.slug
  `).all();
  assert.deepEqual(terms.map(term => ({ slug: term.slug, taxonomy: term.taxonomy, count: term.count })), [
    { slug: 'news', taxonomy: 'category', count: 1 },
    { slug: 'research', taxonomy: 'category', count: 1 },
    { slug: 'xml-data', taxonomy: 'post_tag', count: 1 }
  ]);
  const research = terms.find(term => term.slug === 'research');
  assert.equal(research.parent, db.prepare("SELECT term_id FROM dl_terms WHERE slug = 'news'").get().term_id);
  assert.equal(research.description, 'Research description');

  const comments = db.prepare('SELECT * FROM dl_comments ORDER BY comment_ID').all();
  assert.equal(comments.length, 2);
  assert.equal(comments[0].comment_content, 'Approved ]]> &amp; <text>');
  assert.equal(comments[0].comment_approved, '1');
  assert.equal(comments[0].user_id, authorId);
  assert.equal(comments[1].comment_approved, '0');
  assert.equal(comments[1].comment_parent, comments[0].comment_ID);
  assert.equal(XMLValidator.validate(exportWxr()), true, 're-exported XML must remain parseable');
});

test('WXR settings route enforces upload limits and always cleans temporary files', async () => {
  const userId = createUser('default-admin', 'superadmin');
  const user = getDb().prepare('SELECT * FROM dl_users WHERE ID = ?').get(userId);
  const token = signToken(user);
  const app = express();
  app.use('/settings', require('../src/api/settings.routes'));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function upload(form) {
    const response = await fetch(`${baseUrl}/settings/import-wxr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    return { status: response.status, body: await response.json() };
  }

  function formWith(files) {
    const form = new FormData();
    for (const file of files) {
      form.append('wxr_file', new Blob([file.content], { type: 'application/xml' }), file.name || 'import.xml');
    }
    return form;
  }

  try {
    const malformed = await upload(formWith([{ content: '<rss><channel></rss>' }]));
    assert.equal(malformed.status, 400);
    assert.match(malformed.body.error, /Malformed XML/);
    assert.deepEqual(temporaryFiles(), []);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM dl_posts').get().count, 0);

    const skipped = await upload(formWith([{ content: standardWxr(standardItem({ type: 'attachment' })) }]));
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    assert.equal(skipped.body.stats.skippedItems, 1);
    assert.deepEqual(skipped.body.stats.skippedTypes, { attachment: 1 });
    assert.deepEqual(temporaryFiles(), []);

    const multiple = await upload(formWith([
      { content: standardWxr(''), name: 'one.xml' },
      { content: standardWxr(''), name: 'two.xml' }
    ]));
    assert.equal(multiple.status, 400);
    assert.deepEqual(temporaryFiles(), []);

    const oversized = await upload(formWith([{ content: Buffer.alloc(MAX_WXR_XML_BYTES + 1) }]));
    assert.equal(oversized.status, 413);
    assert.match(oversized.body.error, /File too large/);
    assert.deepEqual(temporaryFiles(), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
