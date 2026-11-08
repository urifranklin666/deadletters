'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_MEDIA_FILE_SIZE = 25 * 1024 * 1024;

const MEDIA_MIME_TYPES = Object.freeze({
  '.jpg': Object.freeze(['image/jpeg']),
  '.jpeg': Object.freeze(['image/jpeg']),
  '.png': Object.freeze(['image/png']),
  '.gif': Object.freeze(['image/gif']),
  '.webp': Object.freeze(['image/webp']),
  '.mp4': Object.freeze(['video/mp4']),
  '.webm': Object.freeze(['video/webm']),
  '.mp3': Object.freeze(['audio/mpeg']),
  '.wav': Object.freeze(['audio/wav', 'audio/x-wav']),
  '.ogg': Object.freeze(['audio/ogg'])
});

function getMediaExtension(originalName) {
  if (typeof originalName !== 'string' || originalName.length === 0) return null;

  const normalizedName = originalName.replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedName);
  const extension = path.posix.extname(basename).toLowerCase();
  return Object.hasOwn(MEDIA_MIME_TYPES, extension) ? extension : null;
}

function isAllowedMediaFilename(filename) {
  return getMediaExtension(filename) !== null;
}

function validateMediaUpload(file) {
  if (!file || typeof file !== 'object') return 'No media payload uploaded.';

  const extension = getMediaExtension(file.originalname);
  if (!extension) {
    return 'Unsupported media type. Only JPG, JPEG, PNG, GIF, WEBP, MP4, WEBM, MP3, WAV, and OGG files are allowed.';
  }

  const mimetype = typeof file.mimetype === 'string'
    ? file.mimetype.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (!MEDIA_MIME_TYPES[extension].includes(mimetype)) {
    return `Media extension ${extension} does not match its declared MIME type.`;
  }

  return null;
}

function createMediaFilename(originalName) {
  const extension = getMediaExtension(originalName);
  if (!extension) throw new TypeError('Cannot create a filename for an unsupported media type.');

  const normalizedName = originalName.replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedName);
  const originalBase = basename.slice(0, basename.length - path.posix.extname(basename).length);
  const safeBase = originalBase
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'media';

  const uniqueSuffix = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  return `${safeBase}-${uniqueSuffix}${extension}`;
}

function startsWith(buffer, signature, offset = 0) {
  return buffer.length >= offset + signature.length && buffer.subarray(offset, offset + signature.length).equals(signature);
}

function hasValidMediaSignature(buffer, extension) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  const normalizedExtension = String(extension || '').toLowerCase();

  switch (normalizedExtension) {
    case '.jpg':
    case '.jpeg':
      return startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]));
    case '.png':
      return startsWith(buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case '.gif':
      return startsWith(buffer, Buffer.from('GIF87a')) || startsWith(buffer, Buffer.from('GIF89a'));
    case '.webp':
      return startsWith(buffer, Buffer.from('RIFF')) && startsWith(buffer, Buffer.from('WEBP'), 8);
    case '.mp4':
      return buffer.length >= 12 && startsWith(buffer, Buffer.from('ftyp'), 4);
    case '.webm':
      return startsWith(buffer, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case '.mp3': {
      if (startsWith(buffer, Buffer.from('ID3'))) return true;
      if (buffer.length < 4 || buffer[0] !== 0xff || (buffer[1] & 0xe0) !== 0xe0) return false;

      const versionBits = (buffer[1] >> 3) & 0x03;
      const layerBits = (buffer[1] >> 1) & 0x03;
      const bitrateIndex = (buffer[2] >> 4) & 0x0f;
      const sampleRateBits = (buffer[2] >> 2) & 0x03;
      return versionBits !== 0x01 && layerBits !== 0 && bitrateIndex !== 0 && bitrateIndex !== 0x0f && sampleRateBits !== 0x03;
    }
    case '.wav':
      return startsWith(buffer, Buffer.from('RIFF')) && startsWith(buffer, Buffer.from('WAVE'), 8);
    case '.ogg':
      return startsWith(buffer, Buffer.from('OggS'));
    default:
      return false;
  }
}

function verifyMediaFileSignature(filePath, extension) {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    return hasValidMediaSignature(buffer.subarray(0, bytesRead), extension);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

module.exports = {
  MAX_MEDIA_FILE_SIZE,
  MEDIA_MIME_TYPES,
  getMediaExtension,
  isAllowedMediaFilename,
  validateMediaUpload,
  createMediaFilename,
  hasValidMediaSignature,
  verifyMediaFileSignature
};
