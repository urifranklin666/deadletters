const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { requireAuth } = require('../core/auth');
const { CAPABILITIES, requireCapability } = require('../core/capabilities');
const {
  MAX_MEDIA_FILE_SIZE,
  isAllowedMediaFilename,
  validateMediaUpload,
  createMediaFilename,
  verifyMediaFileSignature
} = require('../core/file-validation');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadsDir);
  },
  filename: (req, file, cb) => {
    try {
      cb(null, createMediaFilename(file.originalname));
    } catch (error) {
      cb(error);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MEDIA_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const validationError = validateMediaUpload(file);
    if (validationError) {
      const error = new Error(validationError);
      error.status = 400;
      return cb(error);
    }
    cb(null, true);
  }
});

function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[Media API] Unable to clean temporary upload:', error.message);
  }
}

function mediaUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, error => {
    if (!error) return next();
    cleanupUploadedFile(req.file?.path);
    res.status(400).json({ error: `Media upload rejected: ${error.message}` });
  });
}

// POST /api/v1/media/upload
router.post('/upload', requireAuth, requireCapability(CAPABILITIES.MEDIA_UPLOAD), mediaUploadMiddleware, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media payload uploaded.' });
  }

  try {
    if (!verifyMediaFileSignature(req.file.path, path.extname(req.file.filename))) {
      cleanupUploadedFile(req.file.path);
      return res.status(400).json({ error: 'Media payload signature does not match its file type.' });
    }
  } catch (error) {
    cleanupUploadedFile(req.file.path);
    return res.status(400).json({ error: 'Media payload could not be validated.' });
  }

  const publicUrl = `/uploads/${req.file.filename}`;
  res.status(201).json({
    url: publicUrl,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: new Date().toISOString()
  });
});

// GET /api/v1/media
router.get('/', (req, res) => {
  if (!fs.existsSync(config.uploadsDir)) {
    return res.json({ media: [] });
  }

  const entries = fs.readdirSync(config.uploadsDir, { withFileTypes: true });
  const mediaList = entries
    .filter(entry => !entry.name.startsWith('.') && entry.isFile() && isAllowedMediaFilename(entry.name))
    .map(entry => {
      const fullPath = path.join(config.uploadsDir, entry.name);
      try {
        const stat = fs.lstatSync(fullPath);
        if (!stat.isFile()) return null;
        return {
          filename: entry.name,
          url: `/uploads/${entry.name}`,
          sizeBytes: stat.size,
          createdAt: stat.birthtime,
          isImage: /\.(jpg|jpeg|png|webp|gif)$/i.test(entry.name),
          isVideo: /\.(mp4|webm)$/i.test(entry.name),
          isAudio: /\.(mp3|wav|ogg)$/i.test(entry.name)
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({ media: mediaList });
});

// DELETE /api/v1/media/:filename
router.delete('/:filename', requireAuth, requireCapability(CAPABILITIES.MEDIA_DELETE), (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const fullPath = path.join(config.uploadsDir, safeFilename);

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    res.json({ message: 'Media asset vaporized.' });
  } else {
    res.status(404).json({ error: 'Asset not found.' });
  }
});

module.exports = router;
