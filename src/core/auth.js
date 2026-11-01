const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('./db');

const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hashed) {
  return bcrypt.compareSync(plain, hashed);
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.ID,
      login: user.user_login,
      email: user.user_email,
      role: user.role,
      displayName: user.display_name
    },
    config.jwtSecret,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

function findUserByLoginOrEmail(identifier) {
  const db = getDb();
  return db.prepare('SELECT * FROM dl_users WHERE user_login = ? OR user_email = ?').get(identifier, identifier);
}

function findUserById(id) {
  const db = getDb();
  return db.prepare('SELECT ID, user_login, user_nicename, user_email, user_url, user_registered, display_name, role, avatar_url, bio FROM dl_users WHERE ID = ?').get(id);
}

// Express Auth Middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.deadletters_token) {
    token = req.cookies.deadletters_token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Authentication token required.' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const user = findUserById(payload.id);
  if (!user) {
    return res.status(401).json({ error: 'User associated with token no longer exists.' });
  }

  req.user = user;
  next();
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.deadletters_token) {
    token = req.cookies.deadletters_token;
  }

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = findUserById(payload.id);
    }
  }
  next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const roleList = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (req.user.role === 'superadmin' || roleList.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden. Insufficient clearance for operator role: ' + req.user.role });
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  findUserByLoginOrEmail,
  findUserById,
  requireAuth,
  optionalAuth,
  requireRole
};
