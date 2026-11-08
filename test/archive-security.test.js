'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
  SLUG_PATTERN,
  ArchiveSecurityError,
  isValidSlug,
  validateArchiveEntryName,
  isPathWithin,
  resolveContainedPath,
  resolveInstallDestination,
  isSymlinkLikeEntry,
  validateArchiveEntries,
  readArchiveManifest
} = require('../src/core/archive-security');

function archiveEntry(entryName, options = {}) {
  return {
    entryName,
    isDirectory: options.isDirectory || false,
    attr: options.attr || 0,
    header: {
      size: options.size ?? 20,
      compressedSize: options.compressedSize ?? 20
    },
    getData: () => options.data ?? Buffer.from('{}')
  };
}

test('slugs are lowercase, bounded, and cannot introduce path segments', () => {
  for (const slug of ['a', 'theme-1', 'my_addon', '0', 'a'.repeat(64)]) {
    assert.equal(isValidSlug(slug), true, slug);
    assert.equal(SLUG_PATTERN.test(slug), true, slug);
  }
  for (const slug of ['', '-theme', '_theme', 'Theme', 'theme.name', '../theme', 'theme/name', 'theme\\name', 'a'.repeat(65), null, {}, 7]) {
    assert.equal(isValidSlug(slug), false, String(slug));
  }
});

test('archive entry names reject absolute paths, backslashes, and traversal', () => {
  for (const name of ['theme.json', 'assets/site.css', 'nested/theme.json', './theme.json']) {
    assert.equal(validateArchiveEntryName(name), true, name);
  }
  for (const name of [
    '/etc/passwd',
    'C:/windows/system32.dll',
    'C:relative.txt',
    '../outside.txt',
    'safe/../../outside.txt',
    'safe/../outside.txt',
    '..\\outside.txt',
    'safe\\outside.txt',
    'bad\0name.txt',
    ''
  ]) {
    assert.throws(() => validateArchiveEntryName(name), ArchiveSecurityError, name);
  }
});

test('path containment is prefix-safe and installation destinations use strict slugs', () => {
  const root = path.resolve('/tmp/opencode/archive-root');
  assert.equal(isPathWithin(root, root), true);
  assert.equal(isPathWithin(root, path.join(root, 'theme', 'style.css')), true);
  assert.equal(isPathWithin(root, `${root}-sibling/style.css`), false);
  assert.equal(isPathWithin(root, path.join(root, '..', 'outside')), false);
  assert.equal(resolveContainedPath(root, 'theme/style.css'), path.join(root, 'theme', 'style.css'));
  assert.throws(() => resolveContainedPath(root, '../outside'), ArchiveSecurityError);
  assert.throws(() => resolveContainedPath(root, '/outside'), ArchiveSecurityError);
  assert.equal(resolveInstallDestination(root, 'safe-theme'), path.join(root, 'safe-theme'));
  assert.throws(() => resolveInstallDestination(root, '../safe-theme'), ArchiveSecurityError);
});

test('symlink-like and special entries are rejected', () => {
  assert.equal(isSymlinkLikeEntry(archiveEntry('link', { attr: (0o120777 << 16) >>> 0 })), true);
  assert.equal(isSymlinkLikeEntry(archiveEntry('fifo', { attr: (0o010644 << 16) >>> 0 })), true);
  assert.equal(isSymlinkLikeEntry(archiveEntry('junction', { attr: 0x400 })), true);
  assert.equal(isSymlinkLikeEntry(archiveEntry('file', { attr: (0o100644 << 16) >>> 0 })), false);
  assert.equal(isSymlinkLikeEntry(archiveEntry('directory/', { attr: (0o040755 << 16) >>> 0, isDirectory: true })), false);
  assert.throws(
    () => validateArchiveEntries([archiveEntry('link', { attr: (0o120777 << 16) >>> 0 })]),
    /symlink or special/
  );
});

test('archive entry count and total uncompressed size are capped', () => {
  assert.throws(
    () => validateArchiveEntries([archiveEntry('one'), archiveEntry('two')], { maxEntries: 1 }),
    /too many entries/
  );
  assert.throws(
    () => validateArchiveEntries([
      archiveEntry('one', { size: 60, compressedSize: 60 }),
      archiveEntry('two', { size: 50, compressedSize: 50 })
    ], { maxTotalUncompressedSize: 100 }),
    /uncompressed size limit/
  );
  assert.throws(
    () => validateArchiveEntries([archiveEntry('bad', { size: Number.MAX_SAFE_INTEGER + 1 })]),
    /invalid size/
  );
});

test('high-ratio entries and inconsistent zero compressed sizes are rejected', () => {
  assert.throws(
    () => validateArchiveEntries([archiveEntry('bomb', { size: 1001, compressedSize: 10 })], { maxCompressionRatio: 100 }),
    /compression ratio/
  );
  assert.throws(
    () => validateArchiveEntries([archiveEntry('bomb', { size: 100, compressedSize: 0 })]),
    /compression ratio/
  );

  const result = validateArchiveEntries([
    archiveEntry('manifest', { size: 100, compressedSize: 50 }),
    archiveEntry('empty', { size: 0, compressedSize: 0 })
  ]);
  assert.deepEqual(result, { entryCount: 2, totalUncompressedSize: 100, totalCompressedSize: 50 });
});

test('all entry targets are checked against an optional extraction root', () => {
  const root = path.resolve('/tmp/opencode/theme-install');
  assert.doesNotThrow(() => validateArchiveEntries([archiveEntry('assets/site.css')], { destinationRoot: root }));
  assert.throws(
    () => validateArchiveEntries([archiveEntry('../outside')], { destinationRoot: root }),
    ArchiveSecurityError
  );
});

test('manifest reads require valid JSON objects and strict slugs', () => {
  const manifest = value => archiveEntry('theme.json', {
    data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    size: Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)),
    compressedSize: 20
  });

  assert.deepEqual(readArchiveManifest([manifest({ slug: 'safe-theme', name: 'Safe' })], 'theme.json'), {
    slug: 'safe-theme',
    name: 'Safe'
  });
  for (const entry of [
    manifest('{not json'),
    manifest('null'),
    manifest([]),
    manifest({ name: 'Missing slug' }),
    manifest({ slug: '../escape' }),
    manifest({ slug: 'Uppercase' })
  ]) {
    assert.throws(() => readArchiveManifest([entry], 'theme.json'), ArchiveSecurityError);
  }
  assert.throws(() => readArchiveManifest([archiveEntry('style.css')], 'theme.json'), /missing theme.json/);
});

test('a real adm-zip package passes entry and manifest validation', () => {
  const source = new AdmZip();
  source.addFile('theme.json', Buffer.from(JSON.stringify({ slug: 'safe-theme', name: 'Safe Theme' })));
  source.addFile('assets/style.css', Buffer.from('body { color: black; }'));

  const zip = new AdmZip(source.toBuffer());
  const entries = zip.getEntries();
  assert.doesNotThrow(() => validateArchiveEntries(entries));
  assert.equal(readArchiveManifest(entries, 'theme.json').slug, 'safe-theme');
});
