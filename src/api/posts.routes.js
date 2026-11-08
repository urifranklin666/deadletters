const express = require('express');
const { getDb, getOption } = require('../core/db');
const { requireAuth, optionalAuth } = require('../core/auth');
const {
  CAPABILITIES,
  hasCapability,
  requireCapability,
  canManagePost,
  canReadPost
} = require('../core/capabilities');
const hooks = require('../core/hooks');
const { generateDropCode } = require('../core/reshare-engine');
const { renderContent, renderExcerpt, sanitizeRenderedContent } = require('../core/content-renderer');

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
  const configuredLimit = Number.parseInt(getOption('posts_per_page', '12'), 10);
  const defaultLimit = Number.isFinite(configuredLimit) ? Math.min(Math.max(configuredLimit, 1), 100) : 12;
  const requestedLimit = Number.parseInt(req.query.limit || String(defaultLimit), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : defaultLimit;
  const requestedOffset = Number.parseInt(req.query.offset || '0', 10);
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

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

  // Public readers never receive non-public posts. Authors may list their own
  // non-public posts without gaining visibility into anyone else's letters.
  if (hasCapability(req.user, CAPABILITIES.POST_MANAGE_ALL)) {
    if (status !== 'all') {
      query += ' AND p.post_status = ?';
      params.push(status);
    }
  } else if (hasCapability(req.user, CAPABILITIES.POST_EDIT)) {
    if (status === 'all') {
      query += " AND (p.post_status = 'publish' OR p.post_author = ?)";
      params.push(req.user.ID);
    } else if (status === 'publish') {
      query += " AND p.post_status = 'publish'";
    } else {
      query += ' AND p.post_status = ? AND p.post_author = ?';
      params.push(status, req.user.ID);
    }
  } else {
    query += " AND p.post_status = 'publish'";
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

// POST /api/v1/posts/render-preview (Server-consistent safe editor preview)
router.post('/render-preview', requireAuth, requireCapability(CAPABILITIES.POST_CREATE), (req, res) => {
  const source = typeof req.body.content === 'string' ? req.body.content : '';
  if (source.length > 1024 * 1024) {
    return res.status(413).json({ error: 'Preview content exceeds the 1 MiB limit.' });
  }
  res.json({ html: renderContent(source) });
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

  if (!canReadPost(req.user, post)) {
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

  const filteredContent = hooks.applyFilters('the_content', renderContent(post.post_content), post);
  const renderedContent = sanitizeRenderedContent(filteredContent);

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
router.post('/', requireAuth, requireCapability(CAPABILITIES.POST_CREATE), (req, res) => {
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

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Letter title is required.' });
  }
  if (!['publish', 'draft', 'private'].includes(status) || !['post', 'page'].includes(type)) {
    return res.status(400).json({ error: 'Invalid post status or type.' });
  }
  if (!Array.isArray(categories) || !Array.isArray(tags)) {
    return res.status(400).json({ error: 'Categories and tags must be arrays.' });
  }

  const safeContent = typeof content === 'string' ? content : '';
  if (safeContent.length > 1024 * 1024) {
    return res.status(413).json({ error: 'Letter content exceeds the 1 MiB limit.' });
  }

  const generatedSlug = makeSlug(slug || title);
  const existing = db.prepare('SELECT ID FROM dl_posts WHERE post_name = ?').get(generatedSlug);
  const finalSlug = existing ? `${generatedSlug}-${Date.now().toString(36)}` : generatedSlug;
  const dropCode = generateDropCode(type === 'page' ? 'PAGE' : 'POST');

  const createPost = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dl_posts (
        post_author, post_title, post_name, post_content, post_excerpt,
        post_status, post_type, featured_image, reading_time, drop_code, content_format
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.ID,
      title.trim().slice(0, 500),
      finalSlug,
      safeContent,
      typeof excerpt === 'string' && excerpt.trim() ? excerpt.trim().slice(0, 2000) : renderExcerpt(safeContent),
      status,
      type,
      typeof featuredImage === 'string' ? featuredImage.slice(0, 2048) : null,
      calculateReadingTime(safeContent),
      dropCode,
      String(contentFormat || 'standard').slice(0, 50)
    );

    savePostTaxonomies(db, result.lastInsertRowid, categories, 'category');
    savePostTaxonomies(db, result.lastInsertRowid, tags, 'post_tag');
    recountTaxonomies(db);
    return db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(result.lastInsertRowid);
  });

  const createdPost = createPost();
  hooks.doAction(createdPost.post_status === 'publish' ? 'post_published' : 'post_created', createdPost);

  res.status(201).json({
    post: createdPost,
    message: 'Letter successfully dropped into deadletters index.'
  });
});

// PUT /api/v1/posts/:id (Update)
router.put('/:id', requireAuth, requireCapability(CAPABILITIES.POST_EDIT), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);

  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }

  if (!canManagePost(req.user, post, CAPABILITIES.POST_EDIT)) {
    return res.status(403).json({ error: 'Clearance denied. Cannot modify this letter.' });
  }

  const {
    title,
    content,
    excerpt,
    status,
    slug,
    featuredImage,
    categories,
    tags,
    contentFormat,
    isSticky
  } = req.body;

  if (status !== undefined && !['publish', 'draft', 'private', 'trash'].includes(status)) {
    return res.status(400).json({ error: 'Invalid post status.' });
  }
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
    return res.status(400).json({ error: 'Letter title cannot be empty.' });
  }
  if (content !== undefined && (typeof content !== 'string' || content.length > 1024 * 1024)) {
    return res.status(413).json({ error: 'Letter content must be a string no larger than 1 MiB.' });
  }
  if ((categories !== undefined && !Array.isArray(categories)) || (tags !== undefined && !Array.isArray(tags))) {
    return res.status(400).json({ error: 'Categories and tags must be arrays.' });
  }

  const nextSlug = slug !== undefined ? makeSlug(slug) : null;
  if (nextSlug && db.prepare('SELECT ID FROM dl_posts WHERE post_name = ? AND ID != ?').get(nextSlug, id)) {
    return res.status(409).json({ error: 'That slug is already in use.' });
  }

  const updatePost = db.transaction(() => {
    db.prepare(`
      INSERT INTO dl_revisions (post_id, author_id, post_title, post_content, post_excerpt)
      VALUES (?, ?, ?, ?, ?)
    `).run(post.ID, req.user.ID, post.post_title, post.post_content, post.post_excerpt);

    db.prepare(`
      UPDATE dl_posts SET
        post_title = COALESCE(?, post_title),
        post_content = COALESCE(?, post_content),
        post_excerpt = COALESCE(?, post_excerpt),
        post_status = COALESCE(?, post_status),
        post_name = COALESCE(?, post_name),
        featured_image = COALESCE(?, featured_image),
        reading_time = ?,
        content_format = COALESCE(?, content_format),
        is_sticky = COALESCE(?, is_sticky),
        post_modified = CURRENT_TIMESTAMP
      WHERE ID = ?
    `).run(
      title !== undefined ? title.trim().slice(0, 500) : null,
      content,
      excerpt !== undefined ? String(excerpt).slice(0, 2000) : (content !== undefined ? renderExcerpt(content) : null),
      status,
      nextSlug,
      featuredImage !== undefined ? String(featuredImage).slice(0, 2048) : null,
      content !== undefined ? calculateReadingTime(content) : post.reading_time,
      contentFormat !== undefined ? String(contentFormat).slice(0, 50) : null,
      isSticky !== undefined ? (isSticky ? 1 : 0) : post.is_sticky,
      id
    );

    if (categories) savePostTaxonomies(db, id, categories, 'category');
    if (tags) savePostTaxonomies(db, id, tags, 'post_tag');
    if (categories || tags) recountTaxonomies(db);
    return db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);
  });

  const updated = updatePost();
  hooks.doAction('post_updated', updated);
  if (post.post_status !== 'publish' && updated.post_status === 'publish') {
    hooks.doAction('post_published', updated);
  }

  res.json({ post: updated, message: 'Letter updated.' });
});

// GET /api/v1/posts/:id/revisions
router.get('/:id/revisions', requireAuth, requireCapability(CAPABILITIES.POST_REVISE), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }
  if (!canManagePost(req.user, post, CAPABILITIES.POST_REVISE)) {
    return res.status(403).json({ error: 'Clearance denied. Cannot inspect revisions for this letter.' });
  }

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
router.post('/:id/revisions/:revId/restore', requireAuth, requireCapability(CAPABILITIES.POST_REVISE), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }
  if (!canManagePost(req.user, post, CAPABILITIES.POST_REVISE)) {
    return res.status(403).json({ error: 'Clearance denied. Cannot restore revisions for this letter.' });
  }

  const rev = db.prepare('SELECT * FROM dl_revisions WHERE revision_id = ? AND post_id = ?').get(req.params.revId, req.params.id);
  if (!rev) {
    return res.status(404).json({ error: 'Revision not found.' });
  }

  const restoreRevision = db.transaction(() => {
    db.prepare(`
      INSERT INTO dl_revisions (post_id, author_id, post_title, post_content, post_excerpt)
      VALUES (?, ?, ?, ?, ?)
    `).run(post.ID, req.user.ID, post.post_title, post.post_content, post.post_excerpt);

    db.prepare(`
      UPDATE dl_posts SET
        post_title = ?,
        post_content = ?,
        post_excerpt = ?,
        post_modified = CURRENT_TIMESTAMP
      WHERE ID = ?
    `).run(rev.post_title, rev.post_content, rev.post_excerpt, req.params.id);
  });
  restoreRevision();

  res.json({ message: 'Letter restored to selected historical revision.' });
});

// PUT /api/v1/posts/:id/trash (Soft Delete / Move to Trash)
router.put('/:id/trash', requireAuth, requireCapability(CAPABILITIES.POST_TRASH), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }
  if (!canManagePost(req.user, post, CAPABILITIES.POST_TRASH)) {
    return res.status(403).json({ error: 'Clearance denied. Cannot trash this letter.' });
  }

  db.prepare("UPDATE dl_posts SET post_status = 'trash' WHERE ID = ?").run(req.params.id);
  res.json({ message: 'Letter moved to trash queue.' });
});

// PUT /api/v1/posts/:id/restore (Restore from Trash)
router.put('/:id/restore', requireAuth, requireCapability(CAPABILITIES.POST_RESTORE), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }
  if (!canManagePost(req.user, post, CAPABILITIES.POST_RESTORE)) {
    return res.status(403).json({ error: 'Clearance denied. Cannot restore this letter.' });
  }

  db.prepare("UPDATE dl_posts SET post_status = 'publish' WHERE ID = ?").run(req.params.id);
  res.json({ message: 'Letter restored from trash to active frequency.' });
});

// DELETE /api/v1/posts/:id (Hard Purge)
router.delete('/:id', requireAuth, requireCapability(CAPABILITIES.POST_DELETE), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const post = db.prepare('SELECT * FROM dl_posts WHERE ID = ?').get(id);

  if (!post) {
    return res.status(404).json({ error: 'Letter not found.' });
  }

  if (!canManagePost(req.user, post, CAPABILITIES.POST_DELETE)) {
    return res.status(403).json({ error: 'Clearance denied.' });
  }

  const deletePost = db.transaction(() => {
    const reshare = db.prepare('SELECT source_post_id FROM dl_reshares WHERE post_id = ?').get(id);
    if (reshare?.source_post_id) {
      db.prepare('UPDATE dl_posts SET reshare_count = MAX(reshare_count - 1, 0) WHERE ID = ?')
        .run(reshare.source_post_id);
    }
    db.prepare('UPDATE dl_reshares SET source_post_id = NULL WHERE source_post_id = ?').run(id);
    db.prepare('DELETE FROM dl_posts WHERE ID = ?').run(id);
    recountTaxonomies(db);
  });
  deletePost();
  hooks.doAction('post_deleted', post);

  res.json({ message: 'Letter permanently purged from node registry.' });
});

function savePostTaxonomies(db, postId, termsList, taxonomy) {
  if (!Array.isArray(termsList)) return;

  db.prepare(`
    DELETE FROM dl_term_relationships
    WHERE object_id = ? AND term_taxonomy_id IN (
      SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE taxonomy = ?
    )
  `).run(postId, taxonomy);

  const cleanTerms = [...new Set(termsList
    .filter(term => typeof term === 'string')
    .map(term => term.trim().slice(0, 200))
    .filter(Boolean))]
    .slice(0, 50);

  for (const cleanName of cleanTerms) {
    const slug = makeSlug(cleanName);
    let term = db.prepare('SELECT term_id FROM dl_terms WHERE slug = ?').get(slug);
    if (!term) {
      const result = db.prepare('INSERT INTO dl_terms (name, slug) VALUES (?, ?)').run(cleanName, slug);
      term = { term_id: result.lastInsertRowid };
    }

    let termTaxonomy = db.prepare('SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE term_id = ? AND taxonomy = ?')
      .get(term.term_id, taxonomy);
    if (!termTaxonomy) {
      const result = db.prepare('INSERT INTO dl_term_taxonomy (term_id, taxonomy, count) VALUES (?, ?, 0)')
        .run(term.term_id, taxonomy);
      termTaxonomy = { term_taxonomy_id: result.lastInsertRowid };
    }

    db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)')
      .run(postId, termTaxonomy.term_taxonomy_id);
  }
}

function recountTaxonomies(db) {
  db.exec(`
    UPDATE dl_term_taxonomy
    SET count = (
      SELECT COUNT(*)
      FROM dl_term_relationships tr
      WHERE tr.term_taxonomy_id = dl_term_taxonomy.term_taxonomy_id
    )
  `);
}

module.exports = router;
