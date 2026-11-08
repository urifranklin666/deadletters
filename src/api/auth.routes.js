const express = require('express');
const { getDb } = require('../core/db');
const { hashPassword, verifyPassword, signToken, findUserByLoginOrEmail, findUserById, requireAuth } = require('../core/auth');
const { createRateLimiter } = require('../core/rate-limit');

const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Try again later.',
  keyGenerator: req => `${req.ip || req.socket.remoteAddress}:${String(req.body.login || '').toLowerCase().slice(0, 320)}`
});
const {
  ROLES,
  CAPABILITIES,
  requireCapability,
  canAssignRole,
  validateNewUser
} = require('../core/capabilities');

const router = express.Router();

function serializeUser(user) {
  return {
    id: user.ID,
    login: user.user_login,
    email: user.user_email,
    displayName: user.display_name,
    role: user.role,
    avatarUrl: user.avatar_url,
    bio: user.bio
  };
}

// POST /api/v1/auth/login
router.post('/login', loginRateLimit, (req, res) => {
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

  res.json({
    token,
    user: serializeUser(user)
  });
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
  res.json({ message: 'Operator session terminated. Remove the local bearer token.' });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.user) });
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

  if (password !== undefined && password !== '') {
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'New password must be at least 12 characters.' });
    }
    query += ', user_pass = ?, token_version = token_version + 1';
    params.push(hashPassword(password));
  }

  query += ' WHERE ID = ?';
  params.push(req.user.ID);

  db.prepare(query).run(...params);
  const updated = findUserById(req.user.ID);
  const response = { user: serializeUser(updated), message: 'Operator profile updated.' };
  if (password) response.token = signToken(updated);
  res.json(response);
});

// GET /api/v1/auth/users (List all operators - WP Users admin parity)
router.get('/users', requireAuth, requireCapability(CAPABILITIES.USERS_LIST), (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT ID, user_login, user_email, user_nicename, display_name, role, avatar_url, bio, user_registered FROM dl_users ORDER BY ID ASC').all();
  res.json({ users });
});

// POST /api/v1/auth/users (Create new operator / user)
router.post('/users', requireAuth, requireCapability(CAPABILITIES.USERS_CREATE), (req, res) => {
  const { login, email, password, displayName, role = ROLES.AUTHOR, bio = '', avatarUrl = '' } = req.body;
  const validationError = validateNewUser({ login, email, password, role });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  if (!canAssignRole(req.user, role)) {
    return res.status(403).json({ error: 'Clearance denied. You cannot assign that operator role.' });
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
router.delete('/users/:id', requireAuth, requireCapability(CAPABILITIES.USERS_DELETE), (req, res) => {
  if (parseInt(req.params.id, 10) === req.user.ID) {
    return res.status(400).json({ error: 'Cannot decommission your own active operator account.' });
  }

  const db = getDb();
  db.prepare('DELETE FROM dl_users WHERE ID = ?').run(req.params.id);
  res.json({ message: 'Operator credentials purged from node matrix.' });
});

module.exports = router;
