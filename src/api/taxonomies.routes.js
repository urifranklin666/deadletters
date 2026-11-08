const express = require('express');
const { getDb } = require('../core/db');
const { requireAuth } = require('../core/auth');
const { CAPABILITIES, requireCapability } = require('../core/capabilities');

const router = express.Router();

function makeSlug(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-');
}

// GET /api/v1/taxonomies/categories
router.get('/categories', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.term_id, t.name, t.slug, tt.description, tt.count, tt.parent
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'category'
    ORDER BY tt.count DESC, t.name ASC
  `).all();
  res.json({ categories: rows });
});

// POST /api/v1/taxonomies/categories
router.post('/categories', requireAuth, requireCapability(CAPABILITIES.TAXONOMIES_MANAGE), (req, res) => {
  const { name, description = '', parent = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name required.' });

  const db = getDb();
  const slug = makeSlug(name);

  let term = db.prepare('SELECT term_id FROM dl_terms WHERE slug = ?').get(slug);
  if (!term) {
    const r = db.prepare('INSERT INTO dl_terms (name, slug) VALUES (?, ?)').run(name, slug);
    term = { term_id: r.lastInsertRowid };
  }

  let tt = db.prepare('SELECT term_taxonomy_id FROM dl_term_taxonomy WHERE term_id = ? AND taxonomy = ?').get(term.term_id, 'category');
  if (!tt) {
    db.prepare('INSERT INTO dl_term_taxonomy (term_id, taxonomy, description, parent, count) VALUES (?, ?, ?, ?, 0)').run(term.term_id, 'category', description, parent);
  }

  res.status(201).json({ message: 'Category indexed.', slug, name });
});

// GET /api/v1/taxonomies/tags
router.get('/tags', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.term_id, t.name, t.slug, tt.description, tt.count
    FROM dl_terms t
    JOIN dl_term_taxonomy tt ON t.term_id = tt.term_id
    WHERE tt.taxonomy = 'post_tag'
    ORDER BY tt.count DESC
  `).all();
  res.json({ tags: rows });
});

module.exports = router;
