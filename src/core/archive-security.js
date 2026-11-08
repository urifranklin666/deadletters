'use strict';

const path = require('node:path');

const ARCHIVE_UPLOAD_FILE_SIZE = 10 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 64 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 500,
  maxTotalUncompressedSize: 50 * 1024 * 1024,
  maxCompressionRatio: 100
});

class ArchiveSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveSecurityError';
    this.code = 'INVALID_ARCHIVE';
    this.status = 400;
    this.statusCode = 400;
  }
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

function validateArchiveEntryName(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new ArchiveSecurityError('archive contains an empty or invalid entry name.');
  }
  if (entryName.includes('\0')) {
    throw new ArchiveSecurityError('archive entry names cannot contain null bytes.');
  }
  if (entryName.includes('\\')) {
    throw new ArchiveSecurityError(`archive entry "${entryName}" contains a backslash.`);
  }
  if (path.posix.isAbsolute(entryName) || path.win32.isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) {
    throw new ArchiveSecurityError(`archive entry "${entryName}" uses an absolute path.`);
  }
  if (entryName.split('/').includes('..')) {
    throw new ArchiveSecurityError(`archive entry "${entryName}" contains path traversal.`);
  }

  return true;
}

function isPathWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveContainedPath(root, childPath) {
  if (typeof childPath !== 'string') {
    throw new ArchiveSecurityError('archive destination must be a string.');
  }

  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, childPath);
  if (!isPathWithin(resolvedRoot, destination)) {
    throw new ArchiveSecurityError('archive destination escapes its configured root.');
  }
  return destination;
}

function resolveInstallDestination(root, slug) {
  if (!isValidSlug(slug)) {
    throw new ArchiveSecurityError(`slug must match ${SLUG_PATTERN}.`);
  }

  const destination = resolveContainedPath(root, slug);
  if (destination === path.resolve(root)) {
    throw new ArchiveSecurityError('installation destination must be below its configured root.');
  }
  return destination;
}

function getEntryAttributes(entry) {
  return Number(entry.attr ?? entry.header?.attr ?? 0) >>> 0;
}

function isSymlinkLikeEntry(entry) {
  const attributes = getEntryAttributes(entry);
  const unixFileType = (attributes >>> 16) & 0o170000;

  // Unix symlinks, Windows reparse points, and other special filesystem nodes
  // must never be materialized by an archive installer.
  if (unixFileType === 0o120000 || (attributes & 0x400) !== 0) return true;
  return unixFileType !== 0 && unixFileType !== 0o100000 && unixFileType !== 0o040000;
}

function readEntrySize(entry, property) {
  const value = entry.header?.[property] ?? entry[property] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveSecurityError(`archive entry "${entry.entryName}" has an invalid ${property}.`);
  }
  return value;
}

function validateArchiveEntries(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new ArchiveSecurityError('archive entry list is invalid.');
  }

  const maxEntries = options.maxEntries ?? DEFAULT_ARCHIVE_LIMITS.maxEntries;
  const maxTotalUncompressedSize = options.maxTotalUncompressedSize ?? DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedSize;
  const maxCompressionRatio = options.maxCompressionRatio ?? DEFAULT_ARCHIVE_LIMITS.maxCompressionRatio;

  if (entries.length > maxEntries) {
    throw new ArchiveSecurityError(`archive contains too many entries (maximum ${maxEntries}).`);
  }

  let totalUncompressedSize = 0;
  let totalCompressedSize = 0;

  for (const entry of entries) {
    validateArchiveEntryName(entry.entryName);
    if (isSymlinkLikeEntry(entry)) {
      throw new ArchiveSecurityError(`archive entry "${entry.entryName}" is a symlink or special filesystem entry.`);
    }

    const uncompressedSize = readEntrySize(entry, 'size');
    const compressedSize = readEntrySize(entry, 'compressedSize');
    if (uncompressedSize > maxTotalUncompressedSize - totalUncompressedSize) {
      throw new ArchiveSecurityError(`archive exceeds the ${maxTotalUncompressedSize}-byte uncompressed size limit.`);
    }

    totalUncompressedSize += uncompressedSize;
    totalCompressedSize += compressedSize;

    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new ArchiveSecurityError(`archive entry "${entry.entryName}" has an invalid compression ratio.`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) {
      throw new ArchiveSecurityError(`archive entry "${entry.entryName}" exceeds the ${maxCompressionRatio}:1 compression ratio limit.`);
    }

    if (options.destinationRoot !== undefined) {
      resolveContainedPath(options.destinationRoot, entry.entryName);
    }
  }

  if (totalCompressedSize === 0 && totalUncompressedSize > 0) {
    throw new ArchiveSecurityError('archive has an invalid total compression ratio.');
  }
  if (totalCompressedSize > 0 && totalUncompressedSize / totalCompressedSize > maxCompressionRatio) {
    throw new ArchiveSecurityError(`archive exceeds the ${maxCompressionRatio}:1 total compression ratio limit.`);
  }

  return { entryCount: entries.length, totalUncompressedSize, totalCompressedSize };
}

function readArchiveManifest(entries, manifestName) {
  const manifestEntry = entries.find(entry => (
    !entry.isDirectory &&
    (entry.entryName === manifestName || entry.entryName.endsWith(`/${manifestName}`))
  ));

  if (!manifestEntry) {
    throw new ArchiveSecurityError(`missing ${manifestName} manifest.`);
  }
  if (readEntrySize(manifestEntry, 'size') > MAX_MANIFEST_SIZE) {
    throw new ArchiveSecurityError(`${manifestName} manifest exceeds ${MAX_MANIFEST_SIZE} bytes.`);
  }

  let manifest;
  try {
    const serialized = manifestEntry.getData().toString('utf8');
    manifest = JSON.parse(serialized);
  } catch {
    throw new ArchiveSecurityError(`invalid ${manifestName} manifest: expected valid JSON.`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ArchiveSecurityError(`invalid ${manifestName} manifest: expected a JSON object.`);
  }
  if (!isValidSlug(manifest.slug)) {
    throw new ArchiveSecurityError(`invalid ${manifestName} manifest: slug must match ${SLUG_PATTERN}.`);
  }

  return manifest;
}

module.exports = {
  ARCHIVE_UPLOAD_FILE_SIZE,
  MAX_MANIFEST_SIZE,
  SLUG_PATTERN,
  DEFAULT_ARCHIVE_LIMITS,
  ArchiveSecurityError,
  isValidSlug,
  validateArchiveEntryName,
  isPathWithin,
  resolveContainedPath,
  resolveInstallDestination,
  isSymlinkLikeEntry,
  validateArchiveEntries,
  readArchiveManifest
};
