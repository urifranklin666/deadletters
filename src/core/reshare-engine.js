const crypto = require('crypto');
const config = require('../config');
const { getDb, getOption } = require('./db');
const { renderContent, renderExcerpt } = require('./content-renderer');
const provenanceCore = require('./provenance');
const hooks = require('./hooks');

/**
 * Deadletters Resharing & Mesh Federation Engine
 * Deadplug Digital Atelier Specification v1.0
 *
 * New re-letters are signed with the node's local Ed25519 identity envelope.
 * The HMAC helpers below remain only so pre-envelope records can still be
 * verified; new rows must never be HMAC-signed.
 */

function generateDropCode(prefix = 'DL') {
  const year = new Date().getFullYear();
  const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${year}-${hex}`;
}

function generateSignature(payload, secret = config.provenanceSecret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

function getSignaturePayload({ sourceUrl, originalAuthor, originalTitle, provenance }) {
  return { sourceUrl, originalAuthor, originalTitle, provenance };
}

function verifySignature(payload, signature) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = generateSignature(payload);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value, fallback, maximumLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maximumLength);
}

/**
 * Create a Reshare (Re-letter) and its local integrity envelope atomically.
 */
function createReshare({
  userId,
  sourcePostId = null,
  sourceUrl = null,
  sourceNode = 'deadplug://local-node',
  originalAuthor = 'Unknown Operator',
  originalTitle = 'Untitled Letter',
  originalExcerpt = '',
  curatorCommentary = '',
  featuredImage = null
}) {
  const db = getDb();
  if (String(getOption('reshares_enabled', '1')) === '0') {
    throw fail(403, 'Re-letters are disabled on this node.');
  }

  let targetPost = null;
  let parentReshare = null;
  if (sourcePostId) {
    targetPost = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(sourcePostId);
    if (!targetPost) throw fail(404, 'Source letter not found.');
    if (targetPost.post_status !== 'publish') throw fail(403, 'Only published source letters can be re-lettered.');

    if (targetPost.post_type === 'reshare') {
      parentReshare = db.prepare('SELECT * FROM dl_reshares WHERE post_id = ?').get(targetPost.ID) || null;
    }

    if (parentReshare) {
      // Re-lettering a re-letter must retain the original source metadata rather
      // than replacing it with the intermediate reshare post's wrapper fields.
      originalAuthor = parentReshare.original_author;
      originalTitle = parentReshare.original_title;
      originalExcerpt = parentReshare.original_excerpt;
      sourceUrl = parentReshare.source_url;
      sourceNode = parentReshare.source_node;
      if (!featuredImage) featuredImage = targetPost.featured_image;
    } else {
      originalAuthor = db.prepare('SELECT display_name FROM dl_users WHERE ID = ?')
        .get(targetPost.post_author)?.display_name || 'Deadplug Collective';
      originalTitle = targetPost.post_title;
      originalExcerpt = targetPost.post_excerpt || targetPost.post_content.substring(0, 160);
      if (!featuredImage) featuredImage = targetPost.featured_image;
      if (!sourceUrl) sourceUrl = `${getOption('site_url', 'http://localhost:3000')}/letter/${targetPost.post_name}`;
    }
  }

  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      sourceUrl = parsed.href;
    } catch {
      throw fail(400, 'Source URL must be a public HTTP(S) URL without credentials.');
    }
  }

  originalAuthor = cleanText(originalAuthor, 'Unknown Operator', 300);
  originalTitle = cleanText(originalTitle, 'Untitled Letter', 500);
  originalExcerpt = cleanText(originalExcerpt, '', 2000);
  curatorCommentary = cleanText(curatorCommentary, '', 100000);
  sourceNode = cleanText(sourceNode, 'external-web', 500);

  let provenance = [];
  if (parentReshare) {
    try {
      const parsed = JSON.parse(parentReshare.provenance_chain || '[]');
      if (Array.isArray(parsed)) provenance = parsed;
    } catch {}
  }
  if (provenance.length === 0) {
    provenance.push({
      action: 'original_drop',
      author: originalAuthor,
      node: sourceNode,
      timestamp: targetPost ? targetPost.post_date : new Date().toISOString()
    });
  }

  // Ensure the identity exists before opening the post/reshare transaction.
  const signingIdentity = provenanceCore.getPublicNodeIdentity();
  const signedAt = new Date().toISOString();
  provenance.push({
    action: 're_lettered',
    curator_id: userId,
    node: signingIdentity.handle,
    commentary: curatorCommentary,
    timestamp: signedAt
  });

  const source = {
    url: sourceUrl || null,
    node: sourceNode,
    author: originalAuthor,
    title: originalTitle,
    excerpt: originalExcerpt
  };
  let localSourcePostId = sourcePostId;
  if (parentReshare) {
    if (parentReshare.envelope_json) {
      // Carry the original local post id across generations. An external-only
      // source has no local post id and must not gain a reshare post id.
      let inheritedLocalPostId = null;
      try {
        inheritedLocalPostId = JSON.parse(parentReshare.envelope_json)?.source?.local_post_id ?? null;
      } catch {}
      localSourcePostId = Number.isInteger(inheritedLocalPostId) ? inheritedLocalPostId : null;
    } else {
      // Legacy parent: its immediate source id is the best available hint.
      localSourcePostId = parentReshare.source_post_id;
    }
  }
  if (Number.isInteger(localSourcePostId) && localSourcePostId > 0) {
    source.local_post_id = localSourcePostId;
  }

  const signed = provenanceCore.createSignedEnvelope({
    source,
    curator: {
      id: userId,
      commentary: curatorCommentary
    },
    createdAt: signedAt,
    parentEnvelopeHash: parentReshare?.envelope_hash || null,
    provenanceChain: provenance
  });

  const dropCode = generateDropCode('RESHARE');
  const slug = `reshare-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const title = `Reshare: ${originalTitle}`;

  const insertAtomically = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dl_posts (
        post_author, post_title, post_name, post_content, post_excerpt,
        post_type, post_status, drop_code, content_format, featured_image
      ) VALUES (?, ?, ?, ?, ?, 'reshare', 'publish', ?, 'reshare', ?)
    `).run(userId, title, slug, curatorCommentary, originalExcerpt.slice(0, 180), dropCode, featuredImage || null);

    const newPostId = result.lastInsertRowid;
    db.prepare(`
      INSERT INTO dl_reshares (
        post_id, source_post_id, source_url, source_node, original_author,
        original_title, original_excerpt, curator_commentary, provenance_chain,
        envelope_json, envelope_hash, envelope_signature, signature_algorithm,
        signing_key_id, parent_envelope_hash, signed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newPostId, sourcePostId || null, sourceUrl || null, sourceNode, originalAuthor,
      originalTitle, originalExcerpt, curatorCommentary, JSON.stringify(provenance),
      signed.envelope_json, signed.envelope_hash, signed.envelope_signature,
      signed.signature_algorithm, signed.signing_key_id,
      signed.envelope.parent_envelope_hash, signed.signed_at
    );

    if (sourcePostId) {
      db.prepare('UPDATE dl_posts SET reshare_count = reshare_count + 1 WHERE ID = ?').run(sourcePostId);
    }

    return {
      id: newPostId,
      dropCode,
      title,
      slug,
      originalTitle,
      originalAuthor,
      curatorCommentary,
      provenance,
      signature: null,
      envelope_hash: signed.envelope_hash,
      envelope_signature: signed.envelope_signature,
      signature_algorithm: signed.signature_algorithm,
      signing_key_id: signed.signing_key_id,
      parent_envelope_hash: signed.envelope.parent_envelope_hash,
      signed_at: signed.signed_at
    };
  });

  const reshareRecord = insertAtomically();
  // Legacy hooks expect a non-null `signature` string. Give them the Ed25519
  // envelope signature without changing the stored row (which has no HMAC).
  hooks.doAction('post_reshared', {
    ...reshareRecord,
    signature: reshareRecord.envelope_signature || ''
  });
  return reshareRecord;
}

/**
 * Fetch Reshares Stream
 */
function getReshareStream(limit = 20, offset = 0) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT r.*, p.post_date, p.post_name, p.drop_code, p.featured_image, u.display_name as curator_name, u.avatar_url as curator_avatar
    FROM dl_reshares r
    JOIN dl_posts p ON r.post_id = p.ID
    JOIN dl_users u ON p.post_author = u.ID
    WHERE p.post_status = 'publish'
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return rows.map(r => ({
    ...r,
    provenance_chain: JSON.parse(r.provenance_chain || '[]')
  }));
}

/**
 * Generate XML RSS 2.0 Feed
 */
function generateRssFeed() {
  const db = getDb();
  const siteTitle = getOption('site_title', 'Deadletters');
  const siteDesc = getOption('site_tagline', 'the plug is dead. stay wired.');
  const siteUrl = getOption('site_url', 'http://localhost:3000');

  const posts = db.prepare(`
    SELECT p.*, u.display_name as author_name
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    WHERE p.post_status = 'publish' AND p.post_type IN ('post', 'reshare')
    ORDER BY p.post_date DESC
    LIMIT 30
  `).all();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:deadletters="http://deadplug.digital/ns/deadletters">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(siteDesc)}</description>
    <language>en-us</language>
    <generator>Deadletters Engine v1.0 // deadplug.digital</generator>
    <atom:link href="${escapeXml(siteUrl)}/feed" rel="self" type="application/rss+xml" />
`;

  posts.forEach(p => {
    const postLink = `${siteUrl}/letter/${p.post_name}`;
    xml += `    <item>
      <title>${escapeXml(p.post_title)}</title>
      <link>${escapeXml(postLink)}</link>
      <guid isPermaLink="true">${escapeXml(postLink)}</guid>
      <pubDate>${new Date(p.post_date).toUTCString()}</pubDate>
      <author>${escapeXml(p.author_name)}</author>
      <description>${escapeXml(p.post_excerpt || renderExcerpt(p.post_content, 240))}</description>
      <deadletters:dropCode>${escapeXml(p.drop_code || '')}</deadletters:dropCode>
      <deadletters:type>${escapeXml(p.post_type)}</deadletters:type>
    </item>
`;
  });

  xml += `  </channel>
</rss>`;
  return xml;
}

/**
 * Generate JSON Feed 1.1
 */
function generateJsonFeed() {
  const db = getDb();
  const siteTitle = getOption('site_title', 'Deadletters');
  const siteDesc = getOption('site_tagline', 'the plug is dead. stay wired.');
  const siteUrl = getOption('site_url', 'http://localhost:3000');

  const posts = db.prepare(`
    SELECT p.*, u.display_name as author_name, u.avatar_url as author_avatar
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    WHERE p.post_status = 'publish' AND p.post_type IN ('post', 'reshare')
    ORDER BY p.post_date DESC
    LIMIT 30
  `).all();

  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: siteTitle,
    home_page_url: siteUrl,
    feed_url: `${siteUrl}/feed/json`,
    description: siteDesc,
    icon: `${siteUrl}/favicon.ico`,
    creator: {
      name: 'deadplug.digital',
      url: 'https://deadplug.digital'
    },
    items: posts.map(p => ({
      id: `${siteUrl}/letter/${p.post_name}`,
      url: `${siteUrl}/letter/${p.post_name}`,
      title: p.post_title,
      content_html: renderContent(p.post_content),
      summary: p.post_excerpt,
      image: p.featured_image,
      date_published: new Date(p.post_date).toISOString(),
      author: {
        name: p.author_name,
        avatar: p.author_avatar
      },
      _deadletters: {
        drop_code: p.drop_code,
        format: p.content_format,
        reshare_count: p.reshare_count
      }
    }))
  };
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

module.exports = {
  generateDropCode,
  generateSignature,
  verifySignature,
  getSignaturePayload,
  createReshare,
  getReshareStream,
  generateRssFeed,
  generateJsonFeed
};
