const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { requireAuth } = require('../core/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// POST /api/v1/media/upload
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media payload uploaded.' });
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

  const files = fs.readdirSync(config.uploadsDir);
  const mediaList = files
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const fullPath = path.join(config.uploadsDir, f);
      const stat = fs.statSync(fullPath);
      return {
        filename: f,
        url: `/uploads/${f}`,
        sizeBytes: stat.size,
        createdAt: stat.birthtime,
        isImage: /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(f),
        isVideo: /\.(mp4|webm)$/i.test(f),
        isAudio: /\.(mp3|wav|ogg)$/i.test(f)
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({ media: mediaList });
});

// DELETE /api/v1/media/:filename
router.delete('/:filename', requireAuth, (req, res) => {
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
