'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_MEDIA_FILE_SIZE,
  getMediaExtension,
  isAllowedMediaFilename,
  validateMediaUpload,
  createMediaFilename,
  hasValidMediaSignature
} = require('../src/core/file-validation');

test('media allowlist accepts only the intended extensions', () => {
  for (const filename of ['photo.JPG', 'photo.jpeg', 'photo.png', 'photo.gif', 'photo.webp', 'movie.mp4', 'movie.webm', 'sound.mp3', 'sound.wav', 'sound.ogg']) {
    assert.equal(isAllowedMediaFilename(filename), true, filename);
  }
  for (const filename of ['vector.svg', 'page.html', 'script.js', 'document.pdf', 'photo', 'photo.png.exe', '', null]) {
    assert.equal(isAllowedMediaFilename(filename), false, String(filename));
  }
  assert.equal(getMediaExtension('C:\\fakepath\\PHOTO.JPEG'), '.jpeg');
  assert.equal(MAX_MEDIA_FILE_SIZE, 25 * 1024 * 1024);
});

test('media upload validation rejects extension and MIME mismatches', () => {
  assert.equal(validateMediaUpload({ originalname: 'photo.jpg', mimetype: 'image/jpeg' }), null);
  assert.equal(validateMediaUpload({ originalname: 'sound.wav', mimetype: 'audio/x-wav' }), null);

  for (const file of [
    { originalname: 'vector.svg', mimetype: 'image/svg+xml' },
    { originalname: 'page.html', mimetype: 'text/html' },
    { originalname: 'photo.png', mimetype: 'image/jpeg' },
    { originalname: 'photo.jpg', mimetype: 'text/html' },
    { originalname: 'movie.webm', mimetype: 'video/mp4' },
    { originalname: 'sound.ogg', mimetype: 'application/octet-stream' },
    { originalname: 'photo.jpg', mimetype: '' }
  ]) {
    assert.match(validateMediaUpload(file), /Unsupported media type|does not match/, file.originalname);
  }
});

test('canonical media filenames are portable, bounded, and unique', () => {
  const first = createMediaFilename('../../My  Summer😀 Photo.JPG');
  const second = createMediaFilename('../../My  Summer😀 Photo.JPG');

  assert.match(first, /^my-summer-photo-[a-z0-9]+-[a-f0-9]{12}\.jpg$/);
  assert.notEqual(first, second);
  assert.equal(first.includes('..'), false);
  assert.equal(first.includes('/'), false);
  assert.equal(first.includes('\\'), false);
  assert.ok(first.length <= 80);
  assert.match(createMediaFilename('😀.png'), /^media-[a-z0-9]+-[a-f0-9]{12}\.png$/);
  assert.throws(() => createMediaFilename('payload.svg'), /unsupported media type/);
});

test('image signatures distinguish every supported image container', () => {
  const samples = new Map([
    ['.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ['.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00])],
    ['.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])],
    ['.gif', Buffer.from('GIF89a...')],
    ['.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 ')])]
  ]);

  for (const [extension, payload] of samples) {
    assert.equal(hasValidMediaSignature(payload, extension), true, extension);
    assert.equal(hasValidMediaSignature(Buffer.from('<svg onload=alert(1)>'), extension), false, extension);
  }
  assert.equal(hasValidMediaSignature(samples.get('.png'), '.jpg'), false);
  assert.equal(hasValidMediaSignature(samples.get('.jpg'), '.png'), false);
});

test('video and audio signatures validate container markers', () => {
  const validSamples = [
    ['.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)])],
    ['.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])],
    ['.mp3', Buffer.from('ID3\u0004\u0000\u0000')],
    ['.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00])],
    ['.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])],
    ['.ogg', Buffer.from('OggS\u0000\u0002')]
  ];

  for (const [extension, payload] of validSamples) {
    assert.equal(hasValidMediaSignature(payload, extension), true, extension);
  }

  for (const [extension, payload] of [
    ['.mp4', Buffer.from('not an mp4 file')],
    ['.webm', Buffer.from('RIFF....WEBP')],
    ['.mp3', Buffer.from([0xff, 0xe0, 0x00, 0x00])],
    ['.mp3', Buffer.from([0xff, 0xfb, 0xf0, 0x64])],
    ['.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
    ['.ogg', Buffer.from('<html>')],
    ['.xyz', Buffer.from('OggS')]
  ]) {
    assert.equal(hasValidMediaSignature(payload, extension), false, extension);
  }
});
