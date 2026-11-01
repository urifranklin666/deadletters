const express = require('express');
const { getDb } = require('../core/db');
const { requireAuth, optionalAuth } = require('../core/auth');
const hooks = require('../core/hooks');
const { generateDropCode } = require('../core/reshare-engine');

const router = express.Router();

function calculateReadingTime(text) {
  if (!text) return 1;
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

function makeSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `letter-${Date.now().toString(36)}`;
}

// GET /api/v1/posts
router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const type = req.query.type || 'post';
  const status = req.query.status || 'publish';
  const search = req.query.search || null;
  const category = req.query.category || null;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);

  let query = `
    SELECT p.*, u.display_name as author_name, u.avatar_url as author_avatar
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    WHERE 1=1
  `;
  const params = [];

  if (type !== 'all') {
    query += ' AND p.post_type = ?';
    params.push(type);
  }

  // If not authenticated admin/editor, only show published
  if (!req.user || (req.user.role !== 'superadmin' && req.user.role !== 'art_director')) {
    query += " AND p.post_status = 'publish'";
  } else if (status !== 'all') {
    query += ' AND p.post_status = ?';
    params.push(status);
  }

  if (search) {
    query += ' AND (p.post_title LIKE ? OR p.post_content LIKE ? OR p.drop_code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (category) {
    query += `
      AND p.ID IN (
        SELECT tr.object_id FROM dl_term_relationships tr
        JOIN dl_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
        JOIN dl_terms t ON tt.term_id = t.term_id
        WHERE t.slug = ?
      )
    `;
    params.push(category);
  }

  query += ' ORDER BY p.post_date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const posts = db.prepare(query).all(...params);

  // Attach categories to each post
  const enriched = posts.map(post => {
    const terms = db.prepare(`
      SELECT t.name, t.slug, tt.taxonomy
      FROM dl_terms t
      JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
      JOIN dl_term_relationships tr ON tt.term_taxonomy_id = tr.term_taxonomy_id
      WHERE tr.object_id = ?
    `).all(post.ID);

    return {
      ...post,
      categories: terms.filter(t => t.taxonomy === 'category'),
      tags: terms.filter(t => t.taxonomy === 'post_tag')
    };
  });

  res.json({ posts: enriched });
});

// GET /api/v1/posts/:idOrSlug
router.get('/:idOrSlug', optionalAuth, (req, res) => {
  const db = getDb();
  const param = req.params.idOrSlug;
  const isNumeric = /^\d+$/.test(param);

  let post = null;
  if (isNumeric) {
    post = db.prepare(`
      SELECT p.*, u.display_name as author_name, u.avatar_url as author_avatar, u.bio as author_bio
      FROM dl_posts p
      JOIN dl_users u ON p.post_author = u.ID
      WHERE p.ID = ?
    `).get(param);
  } else {
    post = db.prepare(`
      SELECT p.*, u.display_name as author_name, u.avatar_url as author_avatar, u.bio as author_bio
      FROM dl_posts p
      JOIN dl_users u ON p.post_author = u.ID
      WHERE p.post_name = ?
    `).get(param);
  }

  if (!post) {
    return res.status(404).json({ error: 'Letter not found in this node archive.' });
  }

  // Check draft permission
  if (post.post_status !== 'publish' && (!req.user || (req.user.role !== 'superadmin' && req.user.role !== 'art_director' && req.user.ID !== post.post_author))) {
    return res.status(403).json({ error: 'Letter has not been dropped to public frequency.' });
  }

  // Categories & Tags
  const terms = db.prepare(`
    SELECT t.name, t.slug, tt.taxonomy
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    JOIN dl_term_relationships tr ON tt.term_taxonomy_id = tr.term_taxonomy_id
    WHERE tr.object_id = ?
  `).all(post.ID);

  // If reshare, fetch reshare details
  let reshareDetails = null;
  if (post.post_type === 'reshare') {
    reshareDetails = db.prepare('SELECT * FROM dl_reshares WHERE post_id = ?').get(post.ID);
    if (reshareDetails) {
      reshareDetails.provenance_chain = JSON.parse(reshareDetails.provenance_chain || '[]');
    }
  }

  // Apply content filters (e.g. brutalist markdown, callouts, dropcaps)
  const renderedContent = hooks.applyFilters('the_content', post.post_content, post);

  let responseData = {
    ...post,
    post_content_rendered: renderedContent,
    categories: terms.filter(t => t.taxonomy === 'category'),
    tags: terms.filter(t => t.taxonomy === 'post_tag'),
    reshare_details: reshareDetails
  };

  responseData = hooks.applyFilters('api_post_response', responseData);
  res.json({ post: responseData });
});

// POST /api/v1/posts (Create)
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const {
    title,
    content,
    excerpt,
    status = 'publish',
    type = 'post',
    slug,
    featuredImage,
    categories = [],
    tags = [],
    contentFormat = 'standard'
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Letter title is required.' });
  }

  const generatedSlug = slug ? makeSlug(slug) : makeSlug(title);
  // Ensure unique slug
  let finalSlug = generatedSlug;
  const existing = db.prepare('SELECT ID FROM dl_posts WHERE post_name = ?').get(finalSlug);
  if (existing) {
    finalSlug = `${generatedSlug}-${Date.now().toString(36)}`;
  }

  const dropCode = generateDropCode('POST');
  const readingTime = calculateReadingTime(content);

  const insertStmt = db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, featured_image, reading_time, drop_code, content_format
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    req.user.ID,
    title,
    finalSlug,
    content || '',
    excerpt || (content ? content.substring(0, 160) : ''),
    status,
    type,
    featuredImage || null,
    readingTime,
    dropCode,
    contentFormat
  );

  const newId = result.lastInsertRowid;

  // Assign categories and tags
  savePostTaxonomies(db, newId, categories, 'category');
  savePostTaxonomies(db, newId, tags, 'post_tag');

  const createdPost = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(newId);
  hooks.doAction('post_published', createdPost);

  res.status(201).json({
    post: createdPost,
    message: 'Letter successfully dropped into deadletters index.'
  });
});

// PUT /api/v1/posts/:id (Update)
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);

  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }

  if (req.user.role !== 'superadmin' && req.user.role !== 'art_director' && req.user.ID !== post.post_author) {
    return res.status(403).json({ error: 'Clearance denied. Cannot modify this letter.' });
  }

  const {
    title,
    content,
    excerpt,
    status,
    featuredImage,
    categories,
    tags,
    contentFormat,
    isSticky
  } = req.body;

  // Record previous state as revision before updating
  try {
    db.prepare(`
      INSERT INTO dl_revisions (post_id, author_id, post_title, post_content, post_excerpt)
      VALUES (?, ?, ?, ?, ?)
    `).run(post.ID, post.post_author, post.post_title, post.post_content, post.post_excerpt);
  } catch {}

  const readingTime = content ? calculateReadingTime(content) : post.reading_time;

  const updateStmt = db.prepare(`
    UPDATE dl_posts SET
      post_title = COALESCE(?, post_title),
      post_content = COALESCE(?, post_content),
      post_excerpt = COALESCE(?, post_excerpt),
      post_status = COALESCE(?, post_status),
      featured_image = COALESCE(?, featured_image),
      reading_time = ?,
      content_format = COALESCE(?, content_format),
      is_sticky = COALESCE(?, is_sticky),
      post_modified = CURRENT_TIMESTAMP
    WHERE ID = ?
  `);

  updateStmt.run(
    title,
    content,
    excerpt,
    status,
    featuredImage,
    readingTime,
    contentFormat,
    isSticky !== undefined ? (isSticky ? 1 : 0) : post.is_sticky,
    id
  );

  if (categories) savePostTaxonomies(db, id, categories, 'category');
  if (tags) savePostTaxonomies(db, id, tags, 'post_tag');

  const updated = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);
  hooks.doAction('post_updated', updated);

  res.json({ post: updated, message: 'Letter updated.' });
});

// GET /api/v1/posts/:id/revisions
router.get('/:id/revisions', requireAuth, (req, res) => {
  const db = getDb();
  const revisions = db.prepare(`
    SELECT r.*, u.display_name as author_name
    FROM dl_revisions r
    JOIN dl_users u ON r.author_id = u.ID
    WHERE r.post_id = ?
    ORDER BY r.created_at DESC
  `).all(req.params.id);
  res.json({ revisions });
});

// POST /api/v1/posts/:id/revisions/:revId/restore
router.post('/:id/revisions/:revId/restore', requireAuth, (req, res) => {
  const db = getDb();
  const rev = db.prepare('SELECT * FROM dl_revisions WHERE revision_id = ? AND post_id = ?').get(req.params.revId, req.params.id);
  if (!rev) {
    return res.status(404).json({ error: 'Revision not found.' });
  }

  db.prepare(`
    UPDATE dl_posts SET
      post_title = ?,
      post_content = ?,
      post_excerpt = ?,
      post_modified = CURRENT_TIMESTAMP
    WHERE ID = ?
  `).run(rev.post_title, rev.post_content, rev.post_excerpt, req.params.id);

  res.json({ message: 'Letter restored to selected historical revision.' });
});

// PUT /api/v1/posts/:id/trash (Soft Delete / Move to Trash)
router.put('/:id/trash', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE dl_posts SET post_status = 'trash' WHERE ID = ?").run(req.params.id);
  res.json({ message: 'Letter moved to trash queue.' });
});

// PUT /api/v1/posts/:id/restore (Restore from Trash)
router.put('/:id/restore', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE dl_posts SET post_status = 'publish' WHERE ID = ?").run(req.params.id);
  res.json({ message: 'Letter restored from trash to active frequency.' });
});

// DELETE /api/v1/posts/:id (Hard Purge)
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);

  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }

  if (req.user.role !== 'superadmin' && req.user.role !== 'art_director' && req.user.ID !== post.post_author) {
    return res.status(403).json({ error: 'Clearance denied.' });
  }

  db.prepare('DELETE FROM dl_posts WHERE ID = ?').run(id);
  hooks.doAction('post_deleted', post);

  res.json({ message: 'Letter permanently purged from node registry.' });
});

function savePostTaxonomies(db, postId, termsList, taxonomy) {
  if (!termsList || !Array.isArray(termsList)) return;

  // Clear existing for this taxonomy
  db.prepare(`
    DELETE FROM dl_term_relationships
    WHERE object_id = ? AND term_taxonomy_id IN (
      SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE taxonomy = ?
    )
  `).run(postId, taxonomy);

  termsList.forEach(termName => {
    if (!termName || typeof termName !== 'string') return;
    const cleanName = termName.trim();
    const slug = makeSlug(cleanName);

    // Find or create term
    let term = db.prepare('SELECT term_id FROM dl_terms WHERE slug = ?').get(slug);
    if (!term) {
      const tResult = db.prepare('INSERT INTO dl_terms (name, slug) VALUES (?, ?)').run(cleanName, slug);
      term = { term_id: tResult.lastInsertRowid };
    }

    // Find or create term taxonomy
    let tt = db.prepare('SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE term_id = ? AND taxonomy = ?').get(term.term_id, taxonomy);
    if (!tt) {
      const ttResult = db.prepare('INSERT INTO dl_term_taxonomy (term_id, taxonomy, count) VALUES (?, ?, 1)').run(term.term_id, taxonomy);
      tt = { term_taxonomy_id: ttResult.lastInsertRowid };
    } else {
      db.prepare('UPDATE dl_term_taxonomy SET count = count + 1 WHERE term_taxonomy_id = ?').run(tt.term_taxonomy_id);
    }

    // Link relationship
    try {
      db.prepare('INSERT OR IGNORE INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)').run(postId, tt.term_taxonomy_id);
    } catch {}
  });
}

module.exports = router;
