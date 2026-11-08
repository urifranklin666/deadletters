const express = require('express');
const { getDb, getOption } = require('../core/db');
const { requireAuth, optionalAuth } = require('../core/auth');
const { CAPABILITIES, requireCapability } = require('../core/capabilities');
const hooks = require('../core/hooks');
const { createRateLimiter } = require('../core/rate-limit');

const commentRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Comment frequency limit reached. Try again later.'
});

const router = express.Router();

// GET /api/v1/comments (Admin moderation)
router.get('/', requireAuth, requireCapability(CAPABILITIES.COMMENTS_MODERATE), (req, res) => {
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
    SELECT c.comment_ID, c.comment_post_ID, c.comment_author, c.comment_author_url,
           c.comment_date, c.comment_content, c.comment_parent, c.user_id
    FROM dl_comments c
    JOIN dl_posts p ON p.ID = c.comment_post_ID
    WHERE c.comment_post_ID = ? AND c.comment_approved = '1' AND p.post_status = 'publish'
    ORDER BY c.comment_date ASC
  `).all(req.params.postId);

  res.json({ comments });
});

// POST /api/v1/comments (Submit comment)
router.post('/', optionalAuth, commentRateLimit, (req, res) => {
  const db = getDb();
  const { postId, content, authorName, authorEmail, authorUrl, parentId = 0 } = req.body;

  if (!postId || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Post ID and discussion thought required.' });
  }
  if (content.length > 10000) {
    return res.status(413).json({ error: 'Comments are limited to 10,000 characters.' });
  }

  const post = db.prepare('SELECT ID, comment_status, post_status FROM dl_posts WHERE ID = ?').get(postId);
  if (!post || post.post_status !== 'publish' || post.comment_status !== 'open') {
    return res.status(403).json({ error: 'Discussion is closed on this letter.' });
  }

  const defaultApproved = getOption('default_comment_approved', '0') === '1' ? '1' : '0';
  const author = req.user ? req.user.display_name : (authorName || 'Anonymous Operator');
  const email = req.user ? req.user.user_email : (authorEmail || 'anonymous@node.null');
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

  const createComment = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dl_comments (
        comment_post_ID, comment_author, comment_author_email, comment_author_url,
        comment_author_IP, comment_content, comment_approved, comment_parent, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      postId,
      String(author).slice(0, 200),
      String(email).slice(0, 320),
      typeof authorUrl === 'string' ? authorUrl.slice(0, 2048) : '',
      ip,
      content.trim(),
      defaultApproved,
      Number.isInteger(Number(parentId)) ? Number(parentId) : 0,
      req.user ? req.user.ID : 0
    );

    if (defaultApproved === '1') {
      db.prepare('UPDATE dl_posts SET comment_count = comment_count + 1 WHERE ID = ?').run(postId);
    }
    return db.prepare('SELECT * FROM dl_comments WHERE comment_ID = ?').get(result.lastInsertRowid);
  });

  const newComment = createComment();
  hooks.doAction('comment_posted', newComment);

  res.status(201).json({
    comment: newComment,
    message: defaultApproved === '1' ? 'Comment dispatched to frequency.' : 'Comment queued for editorial clearance.'
  });
});

// PUT /api/v1/comments/:id/status (Moderate)
router.put('/:id/status', requireAuth, requireCapability(CAPABILITIES.COMMENTS_MODERATE), (req, res) => {
  const db = getDb();
  const { status } = req.body; // '1' (approved), '0' (pending), 'spam', 'trash'
  if (!['1', '0', 'spam', 'trash'].includes(status)) {
    return res.status(400).json({ error: 'Invalid moderation status.' });
  }

  const comment = db.prepare('SELECT comment_post_ID, comment_approved FROM dl_comments WHERE comment_ID = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });

  const moderateComment = db.transaction(() => {
    db.prepare('UPDATE dl_comments SET comment_approved = ? WHERE comment_ID = ?').run(status, req.params.id);
    if (comment.comment_approved === '1' && status !== '1') {
      db.prepare('UPDATE dl_posts SET comment_count = MAX(comment_count - 1, 0) WHERE ID = ?').run(comment.comment_post_ID);
    } else if (comment.comment_approved !== '1' && status === '1') {
      db.prepare('UPDATE dl_posts SET comment_count = comment_count + 1 WHERE ID = ?').run(comment.comment_post_ID);
    }
  });
  moderateComment();
  res.json({ message: `Comment status shifted to ${status}.` });
});

module.exports = router;
