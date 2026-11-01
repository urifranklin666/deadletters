const { getDb, getOption } = require('./db');
const { generateDropCode } = require('./reshare-engine');

/**
 * WordPress eXtended RSS (WXR) 1.2 Exporter & Importer
 * Enables seamless two-way migration between WordPress and Deadletters.
 */

function exportWxr(baseUrl = 'http://localhost:3000') {
  const db = getDb();
  const siteTitle = getOption('site_title', 'Deadletters');
  const siteDesc = getOption('site_tagline', 'the plug is dead. stay wired.');
  const siteUrl = getOption('site_url', baseUrl);

  const users = db.prepare('SELECT * FROM dl_users').all();
  const categories = db.prepare(`
    SELECT t.name, t.slug, tt.description
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'category'
  `).all();
  const tags = db.prepare(`
    SELECT t.name, t.slug
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'post_tag'
  `).all();

  const posts = db.prepare(`
    SELECT p.*, u.user_login, u.display_name
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    ORDER BY p.ID ASC
  `).all();

  let xml = `<?xml version="1.0" encoding="UTF-8" ?>
<!-- generator="Deadletters Engine v1.0 // deadplug.digital" created="${new Date().toISOString()}" -->
<rss version="2.0"
	xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
	<title>${escapeXml(siteTitle)}</title>
	<link>${escapeXml(siteUrl)}</link>
	<description>${escapeXml(siteDesc)}</description>
	<pubDate>${new Date().toUTCString()}</pubDate>
	<language>en-US</language>
	<wp:wxr_version>1.2</wp:wxr_version>
	<wp:base_site_url>${escapeXml(siteUrl)}</wp:base_site_url>
	<wp:base_blog_url>${escapeXml(siteUrl)}</wp:base_blog_url>
`;

  // Authors
  users.forEach(u => {
    xml += `	<wp:author>
		<wp:author_id>${u.ID}</wp:author_id>
		<wp:author_login>${escapeXml(u.user_login)}</wp:author_login>
		<wp:author_email>${escapeXml(u.user_email)}</wp:author_email>
		<wp:author_display_name><![CDATA[${u.display_name}]]></wp:author_display_name>
	</wp:author>
`;
  });

  // Categories
  categories.forEach(c => {
    xml += `	<wp:category>
		<wp:term_id>0</wp:term_id>
		<wp:category_nicename>${escapeXml(c.slug)}</wp:category_nicename>
		<wp:category_parent></wp:category_parent>
		<wp:cat_name><![CDATA[${c.name}]]></wp:cat_name>
	</wp:category>
`;
  });

  // Tags
  tags.forEach(t => {
    xml += `	<wp:tag>
		<wp:term_id>0</wp:term_id>
		<wp:tag_slug>${escapeXml(t.slug)}</wp:tag_slug>
		<wp:tag_name><![CDATA[${t.name}]]></wp:tag_name>
	</wp:tag>
`;
  });

  // Posts & Pages
  posts.forEach(p => {
    const postLink = `${siteUrl}/letter/${p.post_name}`;
    xml += `	<item>
		<title>${escapeXml(p.post_title)}</title>
		<link>${escapeXml(postLink)}</link>
		<pubDate>${new Date(p.post_date).toUTCString()}</pubDate>
		<dc:creator><![CDATA[${p.user_login}]]></dc:creator>
		<description></description>
		<content:encoded><![CDATA[${p.post_content || ''}]]></content:encoded>
		<excerpt:encoded><![CDATA[${p.post_excerpt || ''}]]></excerpt:encoded>
		<wp:post_id>${p.ID}</wp:post_id>
		<wp:post_date><![CDATA[${p.post_date}]]></wp:post_date>
		<wp:post_name><![CDATA[${p.post_name}]]></wp:post_name>
		<wp:status><![CDATA[${p.post_status}]]></wp:status>
		<wp:post_type><![CDATA[${p.post_type}]]></wp:post_type>
		<wp:is_sticky>${p.is_sticky || 0}</wp:is_sticky>
	</item>
`;
  });

  xml += `</channel>
</rss>`;
  return xml;
}

function importWxr(xmlContent, defaultUserId = 1) {
  const db = getDb();
  let importedPosts = 0;
  let importedPages = 0;

  // Simple robust parser for <item> nodes in WXR
  const itemMatches = xmlContent.match(/<item>([\s\S]*?)<\/item>/gi) || [];

  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const contentMatch = itemXml.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i);
    const excerptMatch = itemXml.match(/<excerpt:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/excerpt:encoded>/i);
    const slugMatch = itemXml.match(/<wp:post_name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/wp:post_name>/i);
    const dateMatch = itemXml.match(/<wp:post_date>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/wp:post_date>/i);
    const typeMatch = itemXml.match(/<wp:post_type>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/wp:post_type>/i);
    const statusMatch = itemXml.match(/<wp:status>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/wp:status>/i);

    const title = titleMatch ? titleMatch[1].trim() : 'Untitled Transmission';
    const content = contentMatch ? contentMatch[1].trim() : '';
    const excerpt = excerptMatch ? excerptMatch[1].trim() : '';
    let slug = slugMatch ? slugMatch[1].trim() : '';
    const date = dateMatch ? dateMatch[1].trim() : new Date().toISOString();
    const type = typeMatch ? typeMatch[1].trim() : 'post';
    const status = statusMatch ? statusMatch[1].trim() : 'publish';

    // Only import standard posts and pages
    if (!['post', 'page'].includes(type)) continue;

    if (!slug) {
      slug = title.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-');
    }

    // Ensure unique slug
    let finalSlug = slug;
    const exists = db.prepare('SELECT ID FROM dl_posts WHERE post_name = ?').get(finalSlug);
    if (exists) {
      finalSlug = `${slug}-${Date.now().toString(36)}`;
    }

    const dropCode = generateDropCode(type.toUpperCase());

    db.prepare(`
      INSERT INTO dl_posts (
        post_author, post_title, post_name, post_content, post_excerpt,
        post_date, post_type, post_status, drop_code, reading_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaultUserId,
      title,
      finalSlug,
      content,
      excerpt || content.substring(0, 160),
      date,
      type,
      status === 'publish' ? 'publish' : 'draft',
      dropCode,
      Math.max(1, Math.ceil(content.split(/\s+/).length / 200))
    );

    if (type === 'post') importedPosts++;
    if (type === 'page') importedPages++;
  }

  return { importedPosts, importedPages, totalItems: itemMatches.length };
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

module.exports = { exportWxr, importWxr };
