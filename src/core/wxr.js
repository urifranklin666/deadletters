'use strict';

const { XMLParser } = require('fast-xml-parser');
const { getDb, getOption } = require('./db');
const { generateDropCode } = require('./reshare-engine');
const { renderExcerpt } = require('./content-renderer');

const MAX_WXR_XML_BYTES = 20 * 1024 * 1024;
const MAX_WXR_ITEMS = 5000;
const MAX_WXR_TERMS = 10000;
const MAX_WXR_COMMENTS = 50000;
const SUPPORTED_POST_TYPES = new Set(['post', 'page']);
const SUPPORTED_TAXONOMIES = new Set(['category', 'post_tag']);

const NAMESPACE_URIS = {
  content: new Set([
    'http://purl.org/rss/1.0/modules/content/',
    'https://purl.org/rss/1.0/modules/content/'
  ]),
  dc: new Set([
    'http://purl.org/dc/elements/1.1/',
    'https://purl.org/dc/elements/1.1/'
  ])
};

/**
 * WordPress eXtended RSS (WXR) 1.x exporter/importer for standard posts/pages.
 * Only local XML strings and SQLite are used; DTDs and external entities are
 * rejected, and the parser never performs network or filesystem resolution.
 */

function migrationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD ||
    (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
    (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
    (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}

function cleanXmlValue(value) {
  let cleaned = '';
  for (const character of String(value ?? '')) {
    if (validXmlCodePoint(character.codePointAt(0))) cleaned += character;
  }
  return cleaned;
}

function escapeXml(value) {
  return cleanXmlValue(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[character]);
}

// Splitting the delimiter keeps arbitrary Markdown/comment text inside CDATA
// without changing it. XML parsers concatenate the adjacent CDATA sections.
function cdata(value) {
  return `<![CDATA[${cleanXmlValue(value).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function rssDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString();
}

function exportWxr(baseUrl = 'http://localhost:3000') {
  const db = getDb();
  const siteTitle = getOption('site_title', 'Deadletters');
  const siteDesc = getOption('site_tagline', 'the plug is dead. stay wired.');
  const siteUrl = String(getOption('site_url', baseUrl) || baseUrl).replace(/\/+$/, '');

  const users = db.prepare(`
    SELECT ID, user_login, user_email, user_nicename, user_url, display_name
    FROM dl_users ORDER BY ID ASC
  `).all();
  const categories = db.prepare(`
    SELECT t.term_id, t.name, t.slug, tt.description, parent.slug AS parent_slug
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    LEFT JOIN dl_terms parent ON parent.term_id = tt.parent
    WHERE tt.taxonomy = 'category'
    ORDER BY t.term_id ASC
  `).all();
  const tags = db.prepare(`
    SELECT t.term_id, t.name, t.slug, tt.description
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'post_tag'
    ORDER BY t.term_id ASC
  `).all();
  const posts = db.prepare(`
    SELECT p.*, u.user_login, u.display_name
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    WHERE p.post_type IN ('post', 'page')
    ORDER BY p.ID ASC
  `).all();

  const postTermsStatement = db.prepare(`
    SELECT t.name, t.slug, tt.taxonomy
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    JOIN dl_term_relationships tr ON tt.term_taxonomy_id = tr.term_taxonomy_id
    WHERE tr.object_id = ? AND tt.taxonomy IN ('category', 'post_tag')
    ORDER BY tt.taxonomy ASC, t.term_id ASC
  `);
  const commentsStatement = db.prepare(`
    SELECT * FROM dl_comments
    WHERE comment_post_ID = ? AND comment_approved IN ('1', '0')
    ORDER BY comment_ID ASC
  `);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- generator="Deadletters Engine" created="${new Date().toISOString()}" -->`,
    '<rss version="2.0"',
    '\txmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
    '\txmlns:content="http://purl.org/rss/1.0/modules/content/"',
    '\txmlns:wfw="http://wellformedweb.org/CommentAPI/"',
    '\txmlns:dc="http://purl.org/dc/elements/1.1/"',
    '\txmlns:wp="http://wordpress.org/export/1.2/">',
    '<channel>',
    `\t<title>${escapeXml(siteTitle)}</title>`,
    `\t<link>${escapeXml(siteUrl)}</link>`,
    `\t<description>${escapeXml(siteDesc)}</description>`,
    `\t<pubDate>${new Date().toUTCString()}</pubDate>`,
    '\t<language>en-US</language>',
    '\t<wp:wxr_version>1.2</wp:wxr_version>',
    `\t<wp:base_site_url>${escapeXml(siteUrl)}</wp:base_site_url>`,
    `\t<wp:base_blog_url>${escapeXml(siteUrl)}</wp:base_blog_url>`
  ];

  for (const user of users) {
    xml.push(
      '\t<wp:author>',
      `\t\t<wp:author_id>${Number(user.ID)}</wp:author_id>`,
      `\t\t<wp:author_login>${cdata(user.user_login)}</wp:author_login>`,
      `\t\t<wp:author_email>${cdata(user.user_email)}</wp:author_email>`,
      `\t\t<wp:author_display_name>${cdata(user.display_name || '')}</wp:author_display_name>`,
      `\t\t<wp:author_first_name>${cdata('')}</wp:author_first_name>`,
      `\t\t<wp:author_last_name>${cdata('')}</wp:author_last_name>`,
      '\t</wp:author>'
    );
  }

  for (const category of categories) {
    xml.push(
      '\t<wp:category>',
      `\t\t<wp:term_id>${Number(category.term_id)}</wp:term_id>`,
      `\t\t<wp:category_nicename>${cdata(category.slug)}</wp:category_nicename>`,
      `\t\t<wp:category_parent>${cdata(category.parent_slug || '')}</wp:category_parent>`,
      `\t\t<wp:cat_name>${cdata(category.name)}</wp:cat_name>`,
      `\t\t<wp:category_description>${cdata(category.description || '')}</wp:category_description>`,
      '\t</wp:category>'
    );
  }

  for (const tag of tags) {
    xml.push(
      '\t<wp:tag>',
      `\t\t<wp:term_id>${Number(tag.term_id)}</wp:term_id>`,
      `\t\t<wp:tag_slug>${cdata(tag.slug)}</wp:tag_slug>`,
      `\t\t<wp:tag_name>${cdata(tag.name)}</wp:tag_name>`,
      `\t\t<wp:tag_description>${cdata(tag.description || '')}</wp:tag_description>`,
      '\t</wp:tag>'
    );
  }

  for (const post of posts) {
    const postLink = `${siteUrl}/letter/${post.post_name}`;
    xml.push(
      '\t<item>',
      `\t\t<title>${cdata(post.post_title || '')}</title>`,
      `\t\t<link>${escapeXml(postLink)}</link>`,
      `\t\t<pubDate>${rssDate(post.post_date)}</pubDate>`,
      `\t\t<dc:creator>${cdata(post.user_login)}</dc:creator>`,
      `\t\t<guid isPermaLink="false">${escapeXml(`${siteUrl}/?p=${post.ID}`)}</guid>`,
      '\t\t<description></description>',
      `\t\t<content:encoded>${cdata(post.post_content || '')}</content:encoded>`,
      `\t\t<excerpt:encoded>${cdata(post.post_excerpt || '')}</excerpt:encoded>`,
      `\t\t<wp:post_id>${Number(post.ID)}</wp:post_id>`,
      `\t\t<wp:post_date>${cdata(post.post_date || '')}</wp:post_date>`,
      `\t\t<wp:post_date_gmt>${cdata(post.post_date_gmt || post.post_date || '')}</wp:post_date_gmt>`,
      `\t\t<wp:post_modified>${cdata(post.post_modified || post.post_date || '')}</wp:post_modified>`,
      `\t\t<wp:comment_status>${cdata(post.comment_status || 'open')}</wp:comment_status>`,
      `\t\t<wp:post_name>${cdata(post.post_name || '')}</wp:post_name>`,
      `\t\t<wp:status>${cdata(post.post_status || 'draft')}</wp:status>`,
      `\t\t<wp:post_parent>${Number(post.post_parent) || 0}</wp:post_parent>`,
      `\t\t<wp:menu_order>${Number(post.menu_order) || 0}</wp:menu_order>`,
      `\t\t<wp:post_type>${cdata(post.post_type)}</wp:post_type>`,
      `\t\t<wp:is_sticky>${post.is_sticky ? 1 : 0}</wp:is_sticky>`
    );

    for (const term of postTermsStatement.all(post.ID)) {
      xml.push(`\t\t<category domain="${escapeXml(term.taxonomy)}" nicename="${escapeXml(term.slug)}">${cdata(term.name)}</category>`);
    }

    for (const comment of commentsStatement.all(post.ID)) {
      xml.push(
        '\t\t<wp:comment>',
        `\t\t\t<wp:comment_id>${Number(comment.comment_ID)}</wp:comment_id>`,
        `\t\t\t<wp:comment_author>${cdata(comment.comment_author || '')}</wp:comment_author>`,
        `\t\t\t<wp:comment_author_email>${cdata(comment.comment_author_email || '')}</wp:comment_author_email>`,
        `\t\t\t<wp:comment_author_url>${escapeXml(comment.comment_author_url || '')}</wp:comment_author_url>`,
        `\t\t\t<wp:comment_author_IP>${cdata(comment.comment_author_IP || '')}</wp:comment_author_IP>`,
        `\t\t\t<wp:comment_date>${cdata(comment.comment_date || '')}</wp:comment_date>`,
        `\t\t\t<wp:comment_date_gmt>${cdata(comment.comment_date || '')}</wp:comment_date_gmt>`,
        `\t\t\t<wp:comment_content>${cdata(comment.comment_content || '')}</wp:comment_content>`,
        `\t\t\t<wp:comment_approved>${cdata(comment.comment_approved)}</wp:comment_approved>`,
        `\t\t\t<wp:comment_parent>${Number(comment.comment_parent) || 0}</wp:comment_parent>`,
        `\t\t\t<wp:comment_user_id>${Number(comment.user_id) || 0}</wp:comment_user_id>`,
        '\t\t</wp:comment>'
      );
    }
    xml.push('\t</item>');
  }

  xml.push('</channel>', '</rss>', '');
  return xml.join('\n');
}

const XML_ENTITY_VALUES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"'
});

function decodeXmlEntity(entity) {
  if (Object.hasOwn(XML_ENTITY_VALUES, entity)) return XML_ENTITY_VALUES[entity];

  let codePoint;
  if (/^#[0-9]+$/.test(entity)) {
    codePoint = Number(entity.slice(1));
  } else if (/^#x[0-9A-Fa-f]+$/.test(entity)) {
    codePoint = Number.parseInt(entity.slice(2), 16);
  } else {
    throw migrationError(`Unsupported XML entity "&${entity};".`);
  }

  if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint(codePoint)) {
    throw migrationError(`Invalid XML character reference "&${entity};".`);
  }
  return String.fromCodePoint(codePoint);
}

// fast-xml-parser's custom decoder hook lets us support exactly the five XML
// entities and numeric references. CDATA bypasses this hook, as required by XML.
const xmlEntityDecoder = {
  reset() {},
  setXmlVersion() {},
  setExternalEntities() {
    throw migrationError('External XML entities are not supported.');
  },
  addInputEntities(entities) {
    if (Object.keys(entities || {}).length > 0) {
      throw migrationError('DTD entity declarations are not supported.');
    }
  },
  decode(value) {
    return value.replace(/&([^;&<]*);/g, (reference, entity) => {
      return decodeXmlEntity(entity);
    });
  }
};

function containsDoctype(xml) {
  let offset = 0;
  while (offset < xml.length) {
    const start = xml.indexOf('<', offset);
    if (start === -1) return false;
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      offset = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      offset = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(xml.slice(start, start + 16))) return true;
    offset = start + 1;
  }
  return false;
}

function isXmlEpilogue(value) {
  let offset = 0;
  while (offset < value.length) {
    if (/\s/.test(value[offset])) {
      offset++;
    } else if (value.startsWith('<!--', offset)) {
      const end = value.indexOf('-->', offset + 4);
      if (end === -1) return false;
      offset = end + 3;
    } else if (value.startsWith('<?', offset)) {
      const end = value.indexOf('?>', offset + 2);
      if (end === -1) return false;
      offset = end + 2;
    } else {
      return false;
    }
  }
  return true;
}

function assertCompleteRssDocument(xml, rootName) {
  const closingTag = `</${rootName}>`;
  let closingIndex = xml.lastIndexOf(closingTag);
  while (closingIndex !== -1) {
    const rootEnd = closingIndex + closingTag.length;
    if (isXmlEpilogue(xml.slice(rootEnd))) return;
    closingIndex = xml.lastIndexOf(closingTag, closingIndex - 1);
  }
  throw migrationError('Malformed XML: unexpected content after the RSS root element.');
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return nodeText(value[0]);
  if (typeof value === 'object') {
    return Object.hasOwn(value, '#text') ? nodeText(value['#text']) : '';
  }
  return String(value);
}

function child(node, name) {
  if (!node || typeof node !== 'object' || !Object.hasOwn(node, name)) return undefined;
  return node[name];
}

function childText(node, name) {
  return nodeText(child(node, name));
}

function attribute(node, name) {
  return childText(node, `@_${name}`);
}

function namespaceKind(uri) {
  const value = String(uri || '');
  if (/^https?:\/\/wordpress\.org\/export\/[0-9.]+\/excerpt\/$/.test(value)) return 'excerpt';
  if (/^https?:\/\/wordpress\.org\/export\/[0-9.]+\/$/.test(value)) return 'wp';
  for (const [kind, uris] of Object.entries(NAMESPACE_URIS)) {
    if (uris.has(value)) return kind;
  }
  return null;
}

function namespacePrefixes(root, channel) {
  const prefixes = { wp: 'wp', content: 'content', excerpt: 'excerpt', dc: 'dc' };
  for (const node of [root, channel]) {
    if (!node || typeof node !== 'object') continue;
    for (const [name, uri] of Object.entries(node)) {
      if (!name.startsWith('@_xmlns:')) continue;
      const kind = namespaceKind(nodeText(uri));
      if (kind) prefixes[kind] = name.slice('@_xmlns:'.length);
    }
  }
  return prefixes;
}

function namespacedChild(node, localName, kind, prefixes) {
  const preferred = `${prefixes[kind]}:${localName}`;
  const preferredValue = child(node, preferred);
  if (preferredValue !== undefined) return preferredValue;
  return child(node, `${kind}:${localName}`);
}

function namespacedText(node, localName, kind, prefixes) {
  return nodeText(namespacedChild(node, localName, kind, prefixes));
}

function positiveInteger(value) {
  const number = Number(String(value).trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(String(value).trim());
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeDate(value, fallback) {
  const source = String(value || '').trim();
  const wordpressDate = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(source);
  if (wordpressDate && !source.startsWith('0000-')) {
    const candidate = `${wordpressDate[1]}-${wordpressDate[2]}-${wordpressDate[3]} ${wordpressDate[4]}:${wordpressDate[5]}:${wordpressDate[6]}`;
    if (!Number.isNaN(new Date(`${candidate.replace(' ', 'T')}Z`).getTime())) return candidate;
  }

  if (source && !source.startsWith('0000-')) {
    const parsed = new Date(source);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().replace('T', ' ').slice(0, 19);
  }
  return fallback;
}

function makeSlug(value, fallback = 'item') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function normalizeStatus(status) {
  const source = String(status || '').trim().toLowerCase();
  if (['publish', 'private', 'draft', 'trash'].includes(source)) return source;
  return 'draft';
}

function readingTime(content) {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 200));
}

function increment(map, key) {
  const safeKey = key || '(missing)';
  map.set(safeKey, (map.get(safeKey) || 0) + 1);
}

function normalizeAuthor(rawAuthor, wp) {
  return {
    sourceId: positiveInteger(wp(rawAuthor, 'author_id')),
    login: wp(rawAuthor, 'author_login').trim(),
    email: wp(rawAuthor, 'author_email').trim(),
    displayName: wp(rawAuthor, 'author_display_name')
  };
}

function normalizeTerm(rawTerm, taxonomy, wp, generic = false) {
  const nameField = generic ? 'term_name' : taxonomy === 'category' ? 'cat_name' : 'tag_name';
  const slugField = generic ? 'term_slug' : taxonomy === 'category' ? 'category_nicename' : 'tag_slug';
  const descriptionField = generic
    ? 'term_description'
    : taxonomy === 'category' ? 'category_description' : 'tag_description';
  const name = wp(rawTerm, nameField).trim();
  const slug = wp(rawTerm, slugField).trim();
  if (!name && !slug) return null;

  return {
    sourceId: positiveInteger(wp(rawTerm, 'term_id')),
    taxonomy,
    name: name || slug,
    slug: makeSlug(slug || name, 'term'),
    description: wp(rawTerm, descriptionField),
    parentSlug: taxonomy === 'category' && !generic ? wp(rawTerm, 'category_parent').trim() : '',
    parentSourceId: generic ? positiveInteger(wp(rawTerm, 'term_parent')) : null,
    result: null
  };
}

function normalizeItemTerm(rawTerm) {
  const taxonomy = (attribute(rawTerm, 'domain') || 'category').trim();
  const name = nodeText(rawTerm).trim();
  const slug = attribute(rawTerm, 'nicename').trim();
  if (!name && !slug) return null;
  return {
    sourceId: null,
    taxonomy,
    name: name || slug,
    slug: makeSlug(slug || name, 'term'),
    description: '',
    parentSlug: '',
    parentSourceId: null,
    result: null
  };
}

function normalizeComment(rawComment, wp, now) {
  return {
    sourceId: positiveInteger(wp(rawComment, 'comment_id')),
    sourceParentId: positiveInteger(wp(rawComment, 'comment_parent')) || 0,
    author: wp(rawComment, 'comment_author'),
    email: wp(rawComment, 'comment_author_email'),
    url: wp(rawComment, 'comment_author_url'),
    ip: wp(rawComment, 'comment_author_IP'),
    date: normalizeDate(wp(rawComment, 'comment_date'), now),
    content: wp(rawComment, 'comment_content'),
    approved: wp(rawComment, 'comment_approved').trim(),
    sourceUserId: positiveInteger(wp(rawComment, 'comment_user_id')) || 0
  };
}

function parseWxrDocument(xmlContent) {
  if (!Buffer.isBuffer(xmlContent) && typeof xmlContent !== 'string') {
    throw migrationError('WXR input must be UTF-8 XML text.');
  }
  const byteLength = Buffer.isBuffer(xmlContent)
    ? xmlContent.length
    : Buffer.byteLength(xmlContent, 'utf8');
  if (byteLength > MAX_WXR_XML_BYTES) {
    throw migrationError(`WXR XML exceeds the ${MAX_WXR_XML_BYTES / 1024 / 1024} MiB limit.`, 413);
  }
  const xml = Buffer.isBuffer(xmlContent) ? xmlContent.toString('utf8') : xmlContent;
  if (!xml.trim()) throw migrationError('The WXR file is empty.');
  if (containsDoctype(xml)) {
    throw migrationError('DTD and external-entity declarations are not allowed in WXR imports.');
  }

  let document;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      removeNSPrefix: false,
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      maxNestedTags: 64,
      processEntities: {
        enabled: true,
        maxEntityCount: 1,
        maxEntitySize: 1,
        maxExpansionDepth: 1,
        maxTotalExpansions: 1000,
        maxExpandedLength: MAX_WXR_XML_BYTES
      },
      entityDecoder: xmlEntityDecoder
    });
    document = parser.parse(xml, true);
  } catch (error) {
    if (error.status) throw error;
    throw migrationError(`Malformed XML: ${error.message}`);
  }

  const rootKeys = Object.keys(document || {});
  if (rootKeys.length !== 1 || !['rss', 'rss:rss'].includes(rootKeys[0]) && !rootKeys[0].endsWith(':rss')) {
    throw migrationError('A WXR document must have exactly one RSS root element.');
  }
  assertCompleteRssDocument(xml, rootKeys[0]);
  const root = document[rootKeys[0]];
  const channel = child(root, 'channel');
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw migrationError('The WXR RSS document is missing its channel.');
  }

  const prefixes = namespacePrefixes(root, channel);
  const wp = (node, name) => namespacedText(node, name, 'wp', prefixes);
  const rawItems = asArray(child(channel, 'item'));
  if (rawItems.length > MAX_WXR_ITEMS) {
    throw migrationError(`WXR contains more than ${MAX_WXR_ITEMS} items.`, 413);
  }

  const rawAuthors = asArray(namespacedChild(channel, 'author', 'wp', prefixes));
  const rawCategories = asArray(namespacedChild(channel, 'category', 'wp', prefixes));
  const rawTags = asArray(namespacedChild(channel, 'tag', 'wp', prefixes));
  const rawGenericTerms = asArray(namespacedChild(channel, 'term', 'wp', prefixes));
  if (rawAuthors.length > MAX_WXR_ITEMS || rawCategories.length + rawTags.length + rawGenericTerms.length > MAX_WXR_TERMS) {
    throw migrationError('WXR exceeds the author or term limit.', 413);
  }

  const skippedTypes = new Map();
  const skippedTaxonomies = new Map();
  const skippedCommentStatuses = new Map();
  const authors = rawAuthors.map(author => normalizeAuthor(author, wp));
  const terms = [];
  let skippedTerms = 0;
  let skippedComments = 0;
  let totalComments = 0;

  function addTerm(term) {
    if (!term || !SUPPORTED_TAXONOMIES.has(term.taxonomy)) {
      skippedTerms++;
      if (term?.taxonomy) increment(skippedTaxonomies, term.taxonomy);
      return;
    }
    terms.push(term);
  }

  for (const category of rawCategories) addTerm(normalizeTerm(category, 'category', wp));
  for (const tag of rawTags) addTerm(normalizeTerm(tag, 'post_tag', wp));
  for (const rawTerm of rawGenericTerms) {
    const taxonomy = wp(rawTerm, 'term_taxonomy').trim();
    if (!SUPPORTED_TAXONOMIES.has(taxonomy)) {
      skippedTerms++;
      increment(skippedTaxonomies, taxonomy);
      continue;
    }
    addTerm(normalizeTerm(rawTerm, taxonomy, wp, true));
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const items = [];
  for (const rawItem of rawItems) {
    const type = wp(rawItem, 'post_type').trim() || 'post';
    if (!SUPPORTED_POST_TYPES.has(type)) {
      increment(skippedTypes, type);
      continue;
    }

    const rawComments = asArray(namespacedChild(rawItem, 'comment', 'wp', prefixes));
    totalComments += rawComments.length;
    if (totalComments > MAX_WXR_COMMENTS) {
      throw migrationError(`WXR contains more than ${MAX_WXR_COMMENTS} supported-item comments.`, 413);
    }

    const itemTerms = [];
    for (const rawTerm of asArray(child(rawItem, 'category'))) {
      const term = normalizeItemTerm(rawTerm);
      if (!term || !SUPPORTED_TAXONOMIES.has(term.taxonomy)) {
        skippedTerms++;
        if (term?.taxonomy) increment(skippedTaxonomies, term.taxonomy);
      } else {
        itemTerms.push(term);
      }
    }

    const comments = [];
    for (const rawComment of rawComments) {
      const comment = normalizeComment(rawComment, wp, now);
      if (!['1', '0'].includes(comment.approved)) {
        skippedComments++;
        increment(skippedCommentStatuses, comment.approved);
      } else {
        comments.push(comment);
      }
    }

    const content = namespacedText(rawItem, 'encoded', 'content', prefixes);
    const sourceExcerpt = namespacedText(rawItem, 'encoded', 'excerpt', prefixes);
    const title = childText(rawItem, 'title').trim() || 'Untitled Transmission';
    const date = normalizeDate(wp(rawItem, 'post_date'), now);
    items.push({
      sourceId: positiveInteger(wp(rawItem, 'post_id')),
      sourceParentId: positiveInteger(wp(rawItem, 'post_parent')) || 0,
      title,
      content,
      excerpt: sourceExcerpt.trim() ? sourceExcerpt : renderExcerpt(content),
      slug: makeSlug(wp(rawItem, 'post_name').trim() || title, type),
      date,
      dateGmt: normalizeDate(wp(rawItem, 'post_date_gmt'), date),
      modified: normalizeDate(wp(rawItem, 'post_modified'), date),
      type,
      status: normalizeStatus(wp(rawItem, 'status')),
      sticky: wp(rawItem, 'is_sticky').trim() === '1' ? 1 : 0,
      commentStatus: wp(rawItem, 'comment_status').trim() === 'closed' ? 'closed' : 'open',
      menuOrder: nonNegativeInteger(wp(rawItem, 'menu_order')),
      authorLogin: namespacedText(rawItem, 'creator', 'dc', prefixes).trim(),
      terms: itemTerms,
      comments,
      importedId: null
    });
  }

  return {
    authors,
    terms,
    items,
    stats: {
      totalItems: rawItems.length,
      importedPosts: 0,
      importedPages: 0,
      importedTerms: 0,
      importedTaxonomies: 0,
      importedRelationships: 0,
      importedComments: 0,
      approvedComments: 0,
      pendingComments: 0,
      totalComments,
      skippedItems: rawItems.length - items.length,
      skippedTypes: Object.fromEntries(skippedTypes),
      skippedTerms,
      skippedTaxonomies: Object.fromEntries(skippedTaxonomies),
      skippedComments,
      skippedCommentStatuses: Object.fromEntries(skippedCommentStatuses),
      authorsMapped: 0,
      authorsDefaulted: 0
    }
  };
}

function uniquePostSlug(db, baseSlug, reservedSlugs) {
  const exists = db.prepare('SELECT 1 FROM dl_posts WHERE post_name = ?');
  let candidate = baseSlug;
  let suffix = 2;
  while (reservedSlugs.has(candidate) || exists.get(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix++;
  }
  reservedSlugs.add(candidate);
  return candidate;
}

function uniqueDropCode(db, type, reservedDropCodes) {
  const exists = db.prepare('SELECT 1 FROM dl_posts WHERE drop_code = ?');
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = generateDropCode(type === 'page' ? 'PAGE' : 'POST');
    if (!reservedDropCodes.has(candidate) && !exists.get(candidate)) {
      reservedDropCodes.add(candidate);
      return candidate;
    }
  }
  throw new Error('Unable to generate a unique drop code for the WXR import.');
}

function termTaxonomy(db, term, context) {
  const cacheKey = `${term.taxonomy}\0${term.slug}`;
  if (context.cache.has(cacheKey)) return context.cache.get(cacheKey);

  let termRow = db.prepare('SELECT term_id FROM dl_terms WHERE slug = ?').get(term.slug);
  let createdTerm = false;
  if (!termRow) {
    const inserted = db.prepare('INSERT INTO dl_terms (name, slug) VALUES (?, ?)').run(term.name, term.slug);
    termRow = { term_id: Number(inserted.lastInsertRowid) };
    createdTerm = true;
  }

  let taxonomyRow = db.prepare(`
    SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE term_id = ? AND taxonomy = ?
  `).get(termRow.term_id, term.taxonomy);
  let createdTaxonomy = false;
  if (!taxonomyRow) {
    const inserted = db.prepare(`
      INSERT INTO dl_term_taxonomy (term_id, taxonomy, description, parent, count)
      VALUES (?, ?, ?, 0, 0)
    `).run(termRow.term_id, term.taxonomy, term.description || '');
    taxonomyRow = { term_taxonomy_id: Number(inserted.lastInsertRowid) };
    createdTaxonomy = true;
  }

  const result = {
    termId: Number(termRow.term_id),
    termTaxonomyId: Number(taxonomyRow.term_taxonomy_id),
    createdTerm,
    createdTaxonomy
  };
  if (createdTerm) context.stats.importedTerms++;
  if (createdTaxonomy) context.stats.importedTaxonomies++;
  if (term.sourceId) context.sourceTermIds.set(term.sourceId, result.termId);
  term.result = result;
  context.cache.set(cacheKey, result);
  return result;
}

function recountTaxonomies(db) {
  db.exec(`
    UPDATE dl_term_taxonomy
    SET count = (
      SELECT COUNT(*) FROM dl_term_relationships tr
      WHERE tr.term_taxonomy_id = dl_term_taxonomy.term_taxonomy_id
    )
  `);
}

function importWxr(xmlContent, defaultUserId = 1) {
  const parsed = parseWxrDocument(xmlContent);
  const db = getDb();
  const defaultId = positiveInteger(defaultUserId);
  const defaultUser = defaultId
    ? db.prepare('SELECT ID, user_login, user_email FROM dl_users WHERE ID = ?').get(defaultId)
    : null;
  if (!defaultUser) throw migrationError('The supplied defaultUserId must identify an existing account.');

  const runImport = db.transaction(() => {
    const stats = parsed.stats;
    const authorsByLogin = new Map();
    const authorsBySourceId = new Map();
    for (const author of parsed.authors) {
      if (author.login) authorsByLogin.set(author.login.toLowerCase(), author);
      if (author.sourceId) authorsBySourceId.set(author.sourceId, author);
      author.existingUserId = null;
    }

    const findAccount = db.prepare(`
      SELECT ID FROM dl_users
      WHERE user_login = ? COLLATE NOCASE OR user_email = ? COLLATE NOCASE
      LIMIT 1
    `);
    function matchSourceAuthor(author) {
      let account = author.login ? findAccount.get(author.login, author.login) : null;
      if (!account && author.email) account = findAccount.get(author.email, author.email);
      author.existingUserId = account ? Number(account.ID) : null;
    }
    for (const author of parsed.authors) matchSourceAuthor(author);

    const authorCache = new Map();
    function resolvePostAuthor(login) {
      const key = login.toLowerCase();
      if (authorCache.has(key)) return authorCache.get(key);
      const sourceAuthor = authorsByLogin.get(key);
      let existingUserId = sourceAuthor?.existingUserId || null;
      if (!sourceAuthor && login) {
        existingUserId = Number(findAccount.get(login, login)?.ID || 0) || null;
      }
      const userId = existingUserId || defaultId;
      if (existingUserId) stats.authorsMapped++;
      else stats.authorsDefaulted++;
      authorCache.set(key, userId);
      return userId;
    }

    const termContext = {
      cache: new Map(),
      sourceTermIds: new Map(),
      stats
    };
    for (const term of parsed.terms) termTaxonomy(db, term, termContext);

    const insertPost = db.prepare(`
      INSERT INTO dl_posts (
        post_author, post_date, post_date_gmt, post_content, post_title,
        post_excerpt, post_status, comment_status, post_name, post_modified,
        post_type, comment_count, reading_time, drop_code, is_sticky,
        menu_order, post_parent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)
    `);
    const reservedSlugs = new Set();
    const reservedDropCodes = new Set();
    const sourcePostIds = new Map();

    for (const item of parsed.items) {
      const slug = uniquePostSlug(db, item.slug, reservedSlugs);
      const dropCode = uniqueDropCode(db, item.type, reservedDropCodes);
      const inserted = insertPost.run(
        resolvePostAuthor(item.authorLogin),
        item.date,
        item.dateGmt,
        item.content,
        item.title,
        item.excerpt,
        item.status,
        item.commentStatus,
        slug,
        item.modified,
        item.type,
        readingTime(item.content),
        dropCode,
        item.sticky,
        item.menuOrder
      );
      item.importedId = Number(inserted.lastInsertRowid);
      item.importedSlug = slug;
      if (item.sourceId && !sourcePostIds.has(item.sourceId)) sourcePostIds.set(item.sourceId, item.importedId);
      if (item.type === 'post') stats.importedPosts++;
      else stats.importedPages++;
    }

    const insertRelationship = db.prepare(`
      INSERT OR IGNORE INTO dl_term_relationships (object_id, term_taxonomy_id, term_order)
      VALUES (?, ?, 0)
    `);
    for (const item of parsed.items) {
      for (const term of item.terms) {
        const result = termTaxonomy(db, term, termContext);
        const relationship = insertRelationship.run(item.importedId, result.termTaxonomyId);
        stats.importedRelationships += relationship.changes;
      }
    }

    // Resolve category parents only after all top-level and per-item terms exist.
    for (const term of parsed.terms) {
      if (!term.result?.createdTaxonomy) continue;
      let parentId = null;
      if (term.parentSlug) {
        parentId = db.prepare('SELECT term_id FROM dl_terms WHERE slug = ?')
          .get(makeSlug(term.parentSlug, 'term'))?.term_id || null;
      } else if (term.parentSourceId) {
        parentId = termContext.sourceTermIds.get(term.parentSourceId) || null;
      }
      if (parentId && Number(parentId) !== term.result.termId) {
        db.prepare('UPDATE dl_term_taxonomy SET parent = ? WHERE term_taxonomy_id = ?')
          .run(parentId, term.result.termTaxonomyId);
      }
    }

    for (const item of parsed.items) {
      const parentId = sourcePostIds.get(item.sourceParentId) || 0;
      if (parentId) {
        db.prepare('UPDATE dl_posts SET post_parent = ? WHERE ID = ?').run(parentId, item.importedId);
      }
    }

    const insertComment = db.prepare(`
      INSERT INTO dl_comments (
        comment_post_ID, comment_author, comment_author_email, comment_author_url,
        comment_author_IP, comment_date, comment_content, comment_approved,
        comment_parent, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    const sourceCommentIds = new Map();
    const importedComments = [];
    const findAccountByEmail = db.prepare('SELECT ID FROM dl_users WHERE user_email = ? COLLATE NOCASE');

    for (const item of parsed.items) {
      for (const comment of item.comments) {
        const sourceAuthor = authorsBySourceId.get(comment.sourceUserId);
        let userId = sourceAuthor?.existingUserId || 0;
        if (!userId && comment.email) userId = Number(findAccountByEmail.get(comment.email)?.ID || 0);
        const inserted = insertComment.run(
          item.importedId,
          comment.author,
          comment.email,
          comment.url,
          comment.ip,
          comment.date,
          comment.content,
          comment.approved,
          userId
        );
        comment.importedId = Number(inserted.lastInsertRowid);
        if (comment.sourceId && !sourceCommentIds.has(comment.sourceId)) {
          sourceCommentIds.set(comment.sourceId, comment.importedId);
        }
        importedComments.push(comment);
        stats.importedComments++;
        if (comment.approved === '1') stats.approvedComments++;
        else stats.pendingComments++;
      }
    }

    for (const comment of importedComments) {
      const parentId = sourceCommentIds.get(comment.sourceParentId) || 0;
      if (parentId) {
        db.prepare('UPDATE dl_comments SET comment_parent = ? WHERE comment_ID = ?')
          .run(parentId, comment.importedId);
      }
    }

    const approvedCount = db.prepare(`
      SELECT COUNT(*) AS count FROM dl_comments
      WHERE comment_post_ID = ? AND comment_approved = '1'
    `);
    const updateCommentCount = db.prepare('UPDATE dl_posts SET comment_count = ? WHERE ID = ?');
    for (const item of parsed.items) {
      updateCommentCount.run(approvedCount.get(item.importedId).count, item.importedId);
    }
    recountTaxonomies(db);
    return stats;
  });

  return runImport();
}

module.exports = {
  exportWxr,
  importWxr,
  MAX_WXR_XML_BYTES,
  MAX_WXR_ITEMS,
  MAX_WXR_TERMS,
  MAX_WXR_COMMENTS
};
