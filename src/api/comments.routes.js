const express = require('express');
const { getDb, getOption } = require('../core/db');
const { requireAuth, optionalAuth } = require('../core/auth');
const hooks = require('../core/hooks');

const router = express.Router();

// GET /api/v1/comments (Admin moderation)
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const status = req.query.status || 'all';

  let query = `
    SELECT c.*, p.post_title, p.post_name
    FROM dl_comments c
    JOIN dl_posts p ON c.comment_post_ID = p.ID
  `;
  const params = [];

  if (status !== 'all') {
    query += ' WHERE c.comment_approved = ?';
    params.push(status);
  }

  query += ' ORDER BY c.comment_date DESC LIMIT 100';
  const comments = db.prepare(query).all(...params);
  res.json({ comments });
});

// GET /api/v1/comments/post/:postId (Public thread)
router.get('/post/:postId', (req, res) => {
  const db = getDb();
  const comments = db.prepare(`
    SELECT comment_ID, comment_post_ID, comment_author, comment_author_url,
           comment_date, comment_content, comment_parent, user_id
    FROM dl_comments
    WHERE comment_post_ID = ? AND comment_approved = '1'
    ORDER BY comment_date ASC
  `).all(req.params.postId);

  res.json({ comments });
});

// POST /api/v1/comments (Submit comment)
router.post('/', optionalAuth, (req, res) => {
  const db = getDb();
  const { postId, content, authorName, authorEmail, authorUrl, parentId = 0 } = req.body;

  if (!postId || !content || !content.trim()) {
    return res.status(400).json({ error: 'Post ID and discussion thought required.' });
  }

  const post = db.prepare('SELECT ID, comment_status FROM dl_posts WHERE ID = ?').get(postId);
  if (!post || post.comment_status !== 'open') {
    return res.status(403).json({ error: 'Discussion is closed on this letter.' });
  }

  const defaultApproved = getOption('default_comment_approved', '1');
  const author = req.user ? req.user.display_name : (authorName || 'Anonymous Operator');
  const email = req.user ? req.user.user_email : (authorEmail || 'anonymous@node.null');
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

  const insertStmt = db.prepare(`
    INSERT INTO dl_comments (
      comment_post_ID, comment_author, comment_author_email, comment_author_url,
      comment_author_IP, comment_content, comment_approved, comment_parent, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    postId,
    author,
    email,
    authorUrl || '',
    ip,
    content.trim(),
    defaultApproved,
    parentId,
    req.user ? req.user.ID : 0
  );

  // Update post comment count
  db.prepare('UPDATE dl_posts SET comment_count = comment_count + 1 WHERE ID = ?').run(postId);

  const newComment = db.prepare('SELECT * FROM dl_comments WHERE comment_ID = ?').get(result.lastInsertRowid);
  hooks.doAction('comment_posted', newComment);

  res.status(201).json({
    comment: newComment,
    message: defaultApproved === '1' ? 'Comment dispatched to frequency.' : 'Comment queued for editorial clearance.'
  });
});

// PUT /api/v1/comments/:id/status (Moderate)
router.put('/:id/status', requireAuth, (req, res) => {
  const db = getDb();
  const { status } = req.body; // '1' (approved), '0' (pending), 'spam', 'trash'
  if (!['1', '0', 'spam', 'trash'].includes(status)) {
    return res.status(400).json({ error: 'Invalid moderation status.' });
  }

  db.prepare('UPDATE dl_comments SET comment_approved = ? WHERE comment_ID = ?').run(status, req.params.id);
  res.json({ message: `Comment status shifted to ${status}.` });
});

module.exports = router;
