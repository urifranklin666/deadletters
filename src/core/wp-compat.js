const express = require('express');
const { getDb, getOption } = require('./db');
const router = express.Router();

/**
 * WordPress REST API v2 Compatibility Bridge
 * Emulates the standard WP-JSON endpoints for headless frontends, mobile clients, and integrations.
 */

// WP Index discovery
router.get('/', (req, res) => {
  const siteUrl = getOption('site_url', `${req.protocol}://${req.get('host')}`);
  res.json({
    name: getOption('site_title', 'Deadletters'),
    description: getOption('site_tagline', 'the plug is dead. stay wired.'),
    url: siteUrl,
    home: siteUrl,
    namespaces: ['wp/v2', 'deadletters/v1'],
    authentication: {},
    routes: {
      '/wp/v2/posts': { namespace: 'wp/v2', methods: ['GET', 'POST'] },
      '/wp/v2/posts/(?P<id>[\\d]+)': { namespace: 'wp/v2', methods: ['GET', 'PUT', 'DELETE'] },
      '/wp/v2/pages': { namespace: 'wp/v2', methods: ['GET'] },
      '/wp/v2/categories': { namespace: 'wp/v2', methods: ['GET'] },
      '/wp/v2/tags': { namespace: 'wp/v2', methods: ['GET'] },
      '/wp/v2/users': { namespace: 'wp/v2', methods: ['GET'] },
      '/wp/v2/comments': { namespace: 'wp/v2', methods: ['GET', 'POST'] }
    }
  });
});

// Format post in WP schema
function formatWpPost(row, req) {
  const siteUrl = getOption('site_url', `${req.protocol}://${req.get('host')}`);
  return {
    id: row.ID,
    date: row.post_date,
    date_gmt: row.post_date_gmt,
    guid: { rendered: `${siteUrl}/letter/${row.post_name}` },
    modified: row.post_modified,
    slug: row.post_name,
    status: row.post_status,
    type: row.post_type,
    link: `${siteUrl}/letter/${row.post_name}`,
    title: { rendered: row.post_title },
    content: { rendered: row.post_content, protected: false },
    excerpt: { rendered: `<p>${row.post_excerpt || ''}</p>`, protected: false },
    author: row.post_author,
    featured_media: row.featured_image ? 1 : 0,
    featured_image_url: row.featured_image,
    comment_status: row.comment_status,
    ping_status: 'open',
    sticky: false,
    format: row.content_format || 'standard',
    meta: {
      drop_code: row.drop_code,
      reshare_count: row.reshare_count,
      reading_time: row.reading_time
    },
    categories: [],
    tags: []
  };
}

// GET /wp-json/wp/v2/posts
router.get('/wp/v2/posts', (req, res) => {
  const db = getDb();
  const perPage = Math.min(parseInt(req.query.per_page || '10', 10), 100);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const offset = (page - 1) * perPage;

  let query = "SELECT * FROM dl_posts WHERE post_type = 'post' AND post_status = 'publish'";
  const params = [];

  if (req.query.search) {
    query += ' AND (post_title LIKE ? OR post_content LIKE ?)';
    params.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }

  query += ' ORDER BY post_date DESC LIMIT ? OFFSET ?';
  params.push(perPage, offset);

  const posts = db.prepare(query).all(...params);
  const totalCount = db.prepare("SELECT COUNT(*) as count FROM dl_posts WHERE post_type = 'post' AND post_status = 'publish'").get().count;

  res.set('X-WP-Total', totalCount);
  res.set('X-WP-TotalPages', Math.ceil(totalCount / perPage));
  res.json(posts.map(p => formatWpPost(p, req)));
});

// GET /wp-json/wp/v2/posts/:id
router.get('/wp/v2/posts/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } });
  }
  res.json(formatWpPost(post, req));
});

// GET /wp-json/wp/v2/pages
router.get('/wp/v2/pages', (req, res) => {
  const db = getDb();
  const pages = db.prepare("SELECT * FROM dl_posts WHERE post_type = 'page' AND post_status = 'publish' ORDER BY post_date DESC").all();
  res.json(pages.map(p => formatWpPost(p, req)));
});

// GET /wp-json/wp/v2/categories
router.get('/wp/v2/categories', (req, res) => {
  const db = getDb();
  const cats = db.prepare(`
    SELECT t.term_id as id, t.name, t.slug, tt.description, tt.count, tt.parent
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'category'
  `).all();
  res.json(cats);
});

// GET /wp-json/wp/v2/tags
router.get('/wp/v2/tags', (req, res) => {
  const db = getDb();
  const tags = db.prepare(`
    SELECT t.term_id as id, t.name, t.slug, tt.description, tt.count
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'post_tag'
  `).all();
  res.json(tags);
});

// GET /wp-json/wp/v2/users
router.get('/wp/v2/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT ID as id, user_nicename as name, user_url as url, display_name, avatar_url, bio as description FROM dl_users').all();
  res.json(users);
});

// GET /wp-json/wp/v2/comments
router.get('/wp/v2/comments', (req, res) => {
  const db = getDb();
  const comments = db.prepare(`
    SELECT comment_ID as id, comment_post_ID as post, comment_author as author_name,
           comment_date as date, comment_content as content, comment_parent as parent
    FROM dl_comments WHERE comment_approved = '1' ORDER BY comment_date DESC LIMIT 50
  `).all();
  res.json(comments.map(c => ({
    ...c,
    content: { rendered: `<p>${c.content}</p>` }
  })));
});

module.exports = router;
