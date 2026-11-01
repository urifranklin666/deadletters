const crypto = require('crypto');
const { getDb, getOption } = require('./db');
const hooks = require('./hooks');

/**
 * Deadletters Resharing & Mesh Federation Engine
 * Deadplug Digital Atelier Specification v1.0
 */

function generateDropCode(prefix = 'DL') {
  const year = new Date().getFullYear();
  const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${year}-${hex}`;
}

function generateSignature(payload, secret = 'deadplug-node-secret') {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

/**
 * Create a Reshare (Re-letter)
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

  // If local post, resolve details
  let targetPost = null;
  if (sourcePostId) {
    targetPost = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(sourcePostId);
    if (targetPost) {
      originalAuthor = db.prepare('SELECT display_name FROM dl_users WHERE ID = ?').get(targetPost.post_author)?.display_name || 'Deadplug Collective';
      originalTitle = targetPost.post_title;
      originalExcerpt = targetPost.post_excerpt || targetPost.post_content.substring(0, 160) + '...';
      if (!featuredImage) featuredImage = targetPost.featured_image;
    }
  }

  const dropCode = generateDropCode('RESHARE');
  const slug = `reshare-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;

  const provenance = [
    {
      action: 'original_drop',
      author: originalAuthor,
      node: sourceNode,
      timestamp: targetPost ? targetPost.post_date : new Date().toISOString()
    },
    {
      action: 're_lettered',
      curator_id: userId,
      node: getOption('site_node_handle', '@deadplug/main-node'),
      commentary: curatorCommentary,
      timestamp: new Date().toISOString()
    }
  ];

  const signature = generateSignature({ sourceUrl, originalAuthor, originalTitle, provenance });

  // 1. Create post entry in dl_posts
  const title = `Reshare: ${originalTitle}`;
  const insertPost = db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_type, post_status, drop_code, content_format, featured_image
    ) VALUES (?, ?, ?, ?, ?, 'reshare', 'publish', ?, 'reshare', ?)
  `);

  const result = insertPost.run(
    userId,
    title,
    slug,
    curatorCommentary,
    curatorCommentary.substring(0, 180),
    dropCode,
    featuredImage
  );

  const newPostId = result.lastInsertRowid;

  // 2. Insert into dl_reshares
  const insertReshare = db.prepare(`
    INSERT INTO dl_reshares (
      post_id, source_post_id, source_url, source_node, original_author,
      original_title, original_excerpt, curator_commentary, provenance_chain, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReshare.run(
    newPostId,
    sourcePostId,
    sourceUrl,
    sourceNode,
    originalAuthor,
    originalTitle,
    originalExcerpt,
    curatorCommentary,
    JSON.stringify(provenance),
    signature
  );

  // 3. Increment reshare count on original if local
  if (sourcePostId) {
    db.prepare('UPDATE dl_posts SET reshare_count = reshare_count + 1 WHERE ID = ?').run(sourcePostId);
  }

  const reshareRecord = {
    id: newPostId,
    dropCode,
    title,
    slug,
    originalTitle,
    originalAuthor,
    curatorCommentary,
    provenance,
    signature
  };

  hooks.doAction('post_reshared', reshareRecord);
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
      <description><![CDATA[${p.post_excerpt || p.post_content.substring(0, 240)}]]></description>
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
      content_html: p.post_content,
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
  createReshare,
  getReshareStream,
  generateRssFeed,
  generateJsonFeed
};
