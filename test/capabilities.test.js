'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES,
  VALID_ROLES,
  CAPABILITIES,
  MIN_NEW_USER_PASSWORD_LENGTH,
  isValidRole,
  hasCapability,
  requireCapability,
  isPostOwner,
  canManagePost,
  canReadPost,
  canAssignRole,
  validateNewUser
} = require('../src/core/capabilities');
const { sanitizeAddonManifest } = require('../src/api/addons.routes');

const ALL_CAPABILITIES = Object.values(CAPABILITIES);
const AUTHOR_CAPABILITIES = new Set([
  CAPABILITIES.POST_CREATE,
  CAPABILITIES.POST_EDIT,
  CAPABILITIES.POST_REVISE,
  CAPABILITIES.POST_TRASH,
  CAPABILITIES.POST_RESTORE,
  CAPABILITIES.POST_DELETE,
  CAPABILITIES.MEDIA_UPLOAD
]);
const ART_DIRECTOR_CAPABILITIES = new Set([
  ...AUTHOR_CAPABILITIES,
  CAPABILITIES.POST_MANAGE_ALL,
  CAPABILITIES.COMMENTS_MODERATE,
  CAPABILITIES.MEDIA_DELETE,
  CAPABILITIES.THEMES_MANAGE,
  CAPABILITIES.USERS_LIST,
  CAPABILITIES.USERS_CREATE,
  CAPABILITIES.TAXONOMIES_MANAGE
]);

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('only the four UI roles are valid', () => {
  assert.deepEqual(VALID_ROLES, ['superadmin', 'art_director', 'author', 'operator']);
  for (const role of VALID_ROLES) assert.equal(isValidRole(role), true);
  for (const role of ['administrator', 'editor', '', null, undefined, 'SUPERADMIN']) {
    assert.equal(isValidRole(role), false);
  }
});

test('superadmin has every defined capability', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(hasCapability(ROLES.SUPERADMIN, capability), true, capability);
    assert.equal(hasCapability({ role: ROLES.SUPERADMIN }, capability), true, capability);
  }
});

test('art director capabilities cover editorial management but not engine administration', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(
      hasCapability(ROLES.ART_DIRECTOR, capability),
      ART_DIRECTOR_CAPABILITIES.has(capability),
      capability
    );
  }

  for (const capability of [
    CAPABILITIES.ADDONS_MANAGE,
    CAPABILITIES.USERS_DELETE,
    CAPABILITIES.SETTINGS_MANAGE,
    CAPABILITIES.SETTINGS_EXPORT,
    CAPABILITIES.SETTINGS_TELEMETRY
  ]) {
    assert.equal(hasCapability(ROLES.ART_DIRECTOR, capability), false, capability);
  }
});

test('author capabilities are limited to own-post workflows and media upload', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(
      hasCapability(ROLES.AUTHOR, capability),
      AUTHOR_CAPABILITIES.has(capability),
      capability
    );
  }
});

test('operator has no administrative capabilities and unknown roles or capabilities are denied', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(hasCapability(ROLES.OPERATOR, capability), false, capability);
    assert.equal(hasCapability('unknown', capability), false, capability);
    assert.equal(hasCapability(null, capability), false, capability);
  }
  assert.equal(hasCapability(ROLES.SUPERADMIN, 'posts:unknown'), false);
});

test('requireCapability returns 401 without an authenticated user', () => {
  const middleware = requireCapability(CAPABILITIES.POST_CREATE);
  const res = createResponse();
  let nextCalled = false;

  middleware({}, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Authentication required/);
  assert.equal(nextCalled, false);
});

test('requireCapability returns 403 for an authenticated but unauthorized role', () => {
  const middleware = requireCapability(CAPABILITIES.THEMES_MANAGE);
  const res = createResponse();
  let nextCalled = false;

  middleware({ user: { role: ROLES.AUTHOR } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /themes:manage/);
  assert.equal(nextCalled, false);
});

test('requireCapability composes by calling next for authorized users', () => {
  for (const [role, capability] of [
    [ROLES.AUTHOR, CAPABILITIES.POST_CREATE],
    [ROLES.ART_DIRECTOR, CAPABILITIES.COMMENTS_MODERATE],
    [ROLES.SUPERADMIN, CAPABILITIES.ADDONS_MANAGE]
  ]) {
    const res = createResponse();
    let nextCalled = false;
    requireCapability(capability)({ user: { role } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  }

  assert.throws(() => requireCapability('not:defined'), /Unknown capability/);
});

test('post ownership accepts database and API user id shapes without coercion surprises', () => {
  assert.equal(isPostOwner({ ID: 7 }, { post_author: 7 }), true);
  assert.equal(isPostOwner({ id: '7' }, { post_author: 7 }), true);
  assert.equal(isPostOwner({ ID: 8 }, { post_author: 7 }), false);
  assert.equal(isPostOwner(null, { post_author: 7 }), false);
  assert.equal(isPostOwner({ ID: 7 }, null), false);
});

test('authors can perform every post mutation only on their own posts', () => {
  const ownPost = { post_author: 7 };
  const otherPost = { post_author: 8 };
  const author = { ID: 7, role: ROLES.AUTHOR };

  for (const capability of [
    CAPABILITIES.POST_EDIT,
    CAPABILITIES.POST_REVISE,
    CAPABILITIES.POST_TRASH,
    CAPABILITIES.POST_RESTORE,
    CAPABILITIES.POST_DELETE
  ]) {
    assert.equal(canManagePost(author, ownPost, capability), true, capability);
    assert.equal(canManagePost(author, otherPost, capability), false, capability);
  }
});

test('art director and superadmin can manage others posts while operator cannot administer even owned posts', () => {
  const post = { post_author: 7 };
  for (const role of [ROLES.ART_DIRECTOR, ROLES.SUPERADMIN]) {
    assert.equal(canManagePost({ ID: 99, role }, post, CAPABILITIES.POST_DELETE), true);
  }
  assert.equal(canManagePost({ ID: 7, role: ROLES.OPERATOR }, post, CAPABILITIES.POST_EDIT), false);
});

test('non-public posts are readable only by their author or editorial managers', () => {
  const ownPrivatePost = { post_author: 7, post_status: 'private' };
  const otherPrivatePost = { post_author: 8, post_status: 'private' };

  assert.equal(canReadPost(null, { post_status: 'publish' }), true);
  assert.equal(canReadPost(null, ownPrivatePost), false);
  assert.equal(canReadPost({ ID: 7, role: ROLES.OPERATOR }, ownPrivatePost), false);
  assert.equal(canReadPost({ ID: 7, role: ROLES.AUTHOR }, ownPrivatePost), true);
  assert.equal(canReadPost({ ID: 7, role: ROLES.AUTHOR }, otherPrivatePost), false);
  assert.equal(canReadPost({ ID: 9, role: ROLES.ART_DIRECTOR }, otherPrivatePost), true);
  assert.equal(canReadPost({ ID: 9, role: ROLES.SUPERADMIN }, otherPrivatePost), true);
  assert.equal(canReadPost(null, null), false);
});

test('role assignment is restricted independently from user creation capability', () => {
  const expected = {
    superadmin: { superadmin: true, art_director: true, author: true, operator: true },
    art_director: { superadmin: false, art_director: false, author: true, operator: true },
    author: { superadmin: false, art_director: false, author: false, operator: false },
    operator: { superadmin: false, art_director: false, author: false, operator: false }
  };

  for (const actorRole of VALID_ROLES) {
    for (const targetRole of VALID_ROLES) {
      assert.equal(
        canAssignRole({ role: actorRole }, targetRole),
        expected[actorRole][targetRole],
        `${actorRole} -> ${targetRole}`
      );
    }
  }
  assert.equal(canAssignRole(ROLES.SUPERADMIN, 'administrator'), false);
});

test('new-user validation accepts valid roles and defaults to author', () => {
  const baseUser = {
    login: 'raven',
    email: 'raven@example.com',
    password: 'a'.repeat(MIN_NEW_USER_PASSWORD_LENGTH)
  };

  assert.equal(validateNewUser(baseUser), null);
  for (const role of VALID_ROLES) {
    assert.equal(validateNewUser({ ...baseUser, role }), null);
  }
});

test('new-user validation requires credentials and a twelve-character password', () => {
  const valid = {
    login: 'raven',
    email: 'raven@example.com',
    password: 'a'.repeat(MIN_NEW_USER_PASSWORD_LENGTH),
    role: ROLES.AUTHOR
  };

  for (const input of [
    {},
    { ...valid, login: '' },
    { ...valid, login: null },
    { ...valid, email: ' ' },
    { ...valid, password: 'a'.repeat(MIN_NEW_USER_PASSWORD_LENGTH - 1) },
    { ...valid, password: undefined }
  ]) {
    assert.match(validateNewUser(input), /min 12 chars/);
  }
});

test('new-user validation rejects unknown roles', () => {
  const error = validateNewUser({
    login: 'raven',
    email: 'raven@example.com',
    password: 'a'.repeat(MIN_NEW_USER_PASSWORD_LENGTH),
    role: 'administrator'
  });
  assert.equal(error, 'Invalid operator role.');
});

test('addon list projection excludes settings, secrets, runtime entry points, and unknown fields', () => {
  const manifest = {
    name: 'Example Addon',
    version: '1.2.3',
    description: 'Public description',
    author: 'Example Author',
    slug: 'example',
    entry: 'index.js',
    is_active: 1,
    settings: { license_key: 'do-not-expose' },
    secrets: { token: 'do-not-expose' },
    apiKey: 'do-not-expose',
    arbitraryPublicLookingField: 'not-allowlisted'
  };
  const snapshot = structuredClone(manifest);

  assert.deepEqual(sanitizeAddonManifest(manifest), {
    name: 'Example Addon',
    version: '1.2.3',
    description: 'Public description',
    author: 'Example Author'
  });
  assert.deepEqual(manifest, snapshot);
  assert.deepEqual(sanitizeAddonManifest(), {});
});
