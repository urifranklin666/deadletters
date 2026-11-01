const express = require('express');
const { getDb } = require('../core/db');
const { hashPassword, verifyPassword, signToken, findUserByLoginOrEmail, findUserById, requireAuth } = require('../core/auth');

const router = express.Router();

// POST /api/v1/auth/login
router.post('/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Operator login and credentials required.' });
  }

  const user = findUserByLoginOrEmail(login);
  if (!user) {
    return res.status(401).json({ error: 'Operator identity not recognized.' });
  }

  if (!verifyPassword(password, user.user_pass)) {
    return res.status(401).json({ error: 'Access credential invalid.' });
  }

  const token = signToken(user);
  res.cookie('deadletters_token', token, { httpOnly: false, maxAge: 30 * 24 * 3600 * 1000 });

  res.json({
    token,
    user: {
      id: user.ID,
      login: user.user_login,
      email: user.user_email,
      displayName: user.display_name,
      role: user.role,
      avatarUrl: user.avatar_url,
      bio: user.bio
    }
  });
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('deadletters_token');
  res.json({ message: 'Operator session terminated.' });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/v1/auth/profile
router.put('/profile', requireAuth, (req, res) => {
  const { displayName, email, bio, avatarUrl, password } = req.body;
  const db = getDb();

  let query = 'UPDATE dl_users SET display_name = ?, user_email = ?, bio = ?, avatar_url = ?';
  const params = [
    displayName || req.user.display_name,
    email || req.user.user_email,
    bio !== undefined ? bio : req.user.bio,
    avatarUrl || req.user.avatar_url
  ];

  if (password && password.trim().length >= 6) {
    query += ', user_pass = ?';
    params.push(hashPassword(password.trim()));
  }

  query += ' WHERE ID = ?';
  params.push(req.user.ID);

  db.prepare(query).run(...params);
  const updated = findUserById(req.user.ID);
  res.json({ user: updated, message: 'Operator profile updated.' });
});

// GET /api/v1/auth/users (List all operators - WP Users admin parity)
router.get('/users', requireAuth, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT ID, user_login, user_email, user_nicename, display_name, role, avatar_url, bio, user_registered FROM dl_users ORDER BY ID ASC').all();
  res.json({ users });
});

// POST /api/v1/auth/users (Create new operator / user)
router.post('/users', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin' && req.user.role !== 'art_director') {
    return res.status(403).json({ error: 'Clearance denied. Only Superadmin or Art Director can enroll operators.' });
  }

  const { login, email, password, displayName, role = 'author', bio = '', avatarUrl = '' } = req.body;
  if (!login || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username, valid email, and password (min 6 chars) required.' });
  }

  const db = getDb();
  try {
    const r = db.prepare(`
      INSERT INTO dl_users (user_login, user_pass, user_nicename, user_email, display_name, role, avatar_url, bio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      login.trim().toLowerCase(),
      hashPassword(password),
      login.trim(),
      email.trim(),
      displayName || login,
      role,
      avatarUrl || '/uploads/deadplug_operator_avatar.jpg',
      bio
    );

    res.status(201).json({
      message: `Operator "${login}" successfully commissioned with role "${role}".`,
      userId: r.lastInsertRowid
    });
  } catch (err) {
    res.status(400).json({ error: 'Failed to create operator: ' + err.message });
  }
});

// DELETE /api/v1/auth/users/:id
router.delete('/users/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only Superadmin can purge operator credentials.' });
  }
  if (parseInt(req.params.id, 10) === req.user.ID) {
    return res.status(400).json({ error: 'Cannot decommission your own active operator account.' });
  }

  const db = getDb();
  db.prepare('DELETE FROM dl_users WHERE ID = ?').run(req.params.id);
  res.json({ message: 'Operator credentials purged from node matrix.' });
});

module.exports = router;
