'use strict';

const ROLES = Object.freeze({
  SUPERADMIN: 'superadmin',
  ART_DIRECTOR: 'art_director',
  AUTHOR: 'author',
  OPERATOR: 'operator'
});

const VALID_ROLES = Object.freeze(Object.values(ROLES));
const MIN_NEW_USER_PASSWORD_LENGTH = 12;

const CAPABILITIES = Object.freeze({
  POST_CREATE: 'posts:create',
  POST_EDIT: 'posts:edit',
  POST_REVISE: 'posts:revise',
  POST_TRASH: 'posts:trash',
  POST_RESTORE: 'posts:restore',
  POST_DELETE: 'posts:delete',
  POST_MANAGE_ALL: 'posts:manage-all',
  COMMENTS_MODERATE: 'comments:moderate',
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_DELETE: 'media:delete',
  THEMES_MANAGE: 'themes:manage',
  ADDONS_MANAGE: 'addons:manage',
  USERS_LIST: 'users:list',
  USERS_CREATE: 'users:create',
  USERS_DELETE: 'users:delete',
  SETTINGS_MANAGE: 'settings:manage',
  SETTINGS_EXPORT: 'settings:export',
  SETTINGS_TELEMETRY: 'settings:telemetry',
  TAXONOMIES_MANAGE: 'taxonomies:manage'
});

const AUTHOR_POST_CAPABILITIES = [
  CAPABILITIES.POST_CREATE,
  CAPABILITIES.POST_EDIT,
  CAPABILITIES.POST_REVISE,
  CAPABILITIES.POST_TRASH,
  CAPABILITIES.POST_RESTORE,
  CAPABILITIES.POST_DELETE
];

const ROLE_CAPABILITIES = Object.freeze({
  [ROLES.SUPERADMIN]: Object.freeze(['*']),
  [ROLES.ART_DIRECTOR]: Object.freeze([
    ...AUTHOR_POST_CAPABILITIES,
    CAPABILITIES.POST_MANAGE_ALL,
    CAPABILITIES.COMMENTS_MODERATE,
    CAPABILITIES.MEDIA_UPLOAD,
    CAPABILITIES.MEDIA_DELETE,
    CAPABILITIES.THEMES_MANAGE,
    CAPABILITIES.USERS_LIST,
    CAPABILITIES.USERS_CREATE,
    CAPABILITIES.TAXONOMIES_MANAGE
  ]),
  [ROLES.AUTHOR]: Object.freeze([
    ...AUTHOR_POST_CAPABILITIES,
    CAPABILITIES.MEDIA_UPLOAD
  ]),
  [ROLES.OPERATOR]: Object.freeze([])
});

const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITIES));

function getRole(userOrRole) {
  return typeof userOrRole === 'string' ? userOrRole : userOrRole && userOrRole.role;
}

function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

function hasCapability(userOrRole, capability) {
  if (!KNOWN_CAPABILITIES.has(capability)) return false;

  const granted = ROLE_CAPABILITIES[getRole(userOrRole)];
  return Boolean(granted && (granted.includes('*') || granted.includes(capability)));
}

function requireCapability(capability) {
  if (!KNOWN_CAPABILITIES.has(capability)) {
    throw new Error(`Unknown capability: ${capability}`);
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized. Authentication required.' });
    }

    if (!hasCapability(req.user, capability)) {
      return res.status(403).json({
        error: `Forbidden. Required capability: ${capability}.`
      });
    }

    next();
  };
}

function isPostOwner(user, post) {
  const userId = user && (user.ID ?? user.id);
  if (userId === undefined || userId === null || !post || post.post_author === undefined || post.post_author === null) {
    return false;
  }
  return String(userId) === String(post.post_author);
}

function canManagePost(user, post, capability = CAPABILITIES.POST_EDIT) {
  if (!hasCapability(user, capability)) return false;
  return hasCapability(user, CAPABILITIES.POST_MANAGE_ALL) || isPostOwner(user, post);
}

function canReadPost(user, post) {
  if (!post) return false;
  if (post.post_status === 'publish') return true;
  return canManagePost(user, post, CAPABILITIES.POST_EDIT);
}

function canAssignRole(actorOrRole, targetRole) {
  if (!isValidRole(targetRole)) return false;

  const actorRole = getRole(actorOrRole);
  if (actorRole === ROLES.SUPERADMIN) return true;
  return actorRole === ROLES.ART_DIRECTOR && [ROLES.AUTHOR, ROLES.OPERATOR].includes(targetRole);
}

function validateNewUser(input = {}) {
  const { login, email, password, role = ROLES.AUTHOR } = input;

  if (
    typeof login !== 'string' || !login.trim() ||
    typeof email !== 'string' || !email.trim() ||
    typeof password !== 'string' || password.length < MIN_NEW_USER_PASSWORD_LENGTH
  ) {
    return `Username, valid email, and password (min ${MIN_NEW_USER_PASSWORD_LENGTH} chars) required.`;
  }

  if (!isValidRole(role)) {
    return 'Invalid operator role.';
  }

  return null;
}

module.exports = {
  ROLES,
  VALID_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  MIN_NEW_USER_PASSWORD_LENGTH,
  isValidRole,
  hasCapability,
  requireCapability,
  isPostOwner,
  canManagePost,
  canReadPost,
  canAssignRole,
  validateNewUser
};
