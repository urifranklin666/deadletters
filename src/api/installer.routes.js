const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { initDb, updateOption, getDb } = require('../core/db');
const { hashPassword, signToken } = require('../core/auth');
const { generateDropCode, createReshare } = require('../core/reshare-engine');

const router = express.Router();

// GET /api/v1/installer/status
router.get('/status', (req, res) => {
  const isInstalled = config.isInstalled();
  const checks = {
    nodeVersion: {
      passed: parseInt(process.versions.node.split('.')[0], 10) >= 18,
      version: process.version
    },
    sqliteSupport: {
      passed: true
    },
    fsWritable: {
      passed: true
    },
    platform: process.platform
  };

  try {
    const testFile = path.join(config.dataDir, '.test-write');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
  } catch {
    checks.fsWritable.passed = false;
  }

  res.json({
    isInstalled,
    systemReady: checks.nodeVersion.passed && checks.fsWritable.passed,
    checks,
    engine: config.meta
  });
});

// POST /api/v1/installer/execute
router.post('/execute', (req, res) => {
  if (config.isInstalled()) {
    return res.status(400).json({ error: 'Engine already installed and initialized on this node.' });
  }

  const {
    siteTitle = 'Deadletters Atelier',
    siteTagline = 'the plug is dead. stay wired.',
    siteNodeHandle = '@deadplug/main-node',
    siteUrl = 'http://localhost:3000',
    adminLogin = 'clown',
    adminEmail = 'clown@deadplug.digital',
    adminPassword,
    themeSlug = 'deadplug-editorial',
    seedDemoContent = true
  } = req.body;

  if (!adminPassword || adminPassword.length < 6) {
    return res.status(400).json({ error: 'Operator master credential must be at least 6 characters.' });
  }

  try {
    // 1. Initialize DB Schema
    const db = initDb();

    // 2. Insert Superadmin User
    const hashedPassword = hashPassword(adminPassword);
    const insertUser = db.prepare(`
      INSERT INTO dl_users (user_login, user_pass, user_nicename, user_email, user_url, display_name, role, avatar_url, bio)
      VALUES (?, ?, ?, ?, ?, ?, 'superadmin', ?, ?)
    `);

    const userResult = insertUser.run(
      adminLogin,
      hashedPassword,
      adminLogin,
      adminEmail,
      'https://deadplug.digital',
      'Operator Clown // Atelier Lead',
      '/uploads/deadplug_operator_avatar.jpg',
      'Atelier Lead & Principal Architect at deadplug.digital. Operating on high-frequency editorial channels.'
    );

    const adminUserId = userResult.lastInsertRowid;

    // 3. Write default Options
    updateOption('site_title', siteTitle);
    updateOption('site_tagline', siteTagline);
    updateOption('site_node_handle', siteNodeHandle);
    updateOption('site_url', siteUrl);
    updateOption('admin_email', adminEmail);
    updateOption('active_theme', themeSlug);
    updateOption('permalink_structure', '/letter/%postname%');
    updateOption('default_comment_approved', '1');
    updateOption('posts_per_page', '10');
    updateOption('deadplug_atelier_branding', '1');
    updateOption('engine_installed_at', new Date().toISOString());

    // 4. Seed Demo Editorial Content if requested
    if (seedDemoContent) {
      seedDeadplugContent(db, adminUserId);
    }

    // 5. Save config.json
    config.saveConfigFile({
      port: config.port,
      host: config.host,
      jwtSecret: config.jwtSecret,
      installed: true,
      installedAt: new Date().toISOString()
    });

    // 6. Sign JWT token for instant login
    const adminUser = db.prepare('SELECT * FROM dl_users WHERE ID = ?').get(adminUserId);
    const token = signToken(adminUser);
    res.cookie('deadletters_token', token, { httpOnly: false, maxAge: 30 * 24 * 3600 * 1000 });

    res.status(201).json({
      success: true,
      message: 'Deadletters Engine initialized successfully.',
      token,
      user: {
        id: adminUser.ID,
        login: adminUser.user_login,
        email: adminUser.user_email,
        displayName: adminUser.display_name,
        role: adminUser.role,
        avatarUrl: adminUser.avatar_url
      }
    });
  } catch (err) {
    console.error('[Installer] Setup failed:', err);
    res.status(500).json({ error: 'Installation failure: ' + err.message });
  }
});

function seedDeadplugContent(db, authorId) {
  // Categories
  const categories = [
    { name: 'Manifesto', slug: 'manifesto', desc: 'Philosophical inquiries into dead networks and post-web aesthetics.' },
    { name: 'Lookbook', slug: 'lookbook', desc: 'Bespoke cyber-editorial fashion and physical-digital garments.' },
    { name: 'Mesh Syndication', slug: 'mesh-syndication', desc: 'Reshared drops and decentralized transmissions from peer nodes.' },
    { name: 'Atelier Architecture', slug: 'atelier-architecture', desc: 'Internal engineering dispatches and system design.' }
  ];

  categories.forEach(c => {
    const t = db.prepare('INSERT INTO dl_terms (name, slug) VALUES (?, ?)').run(c.name, c.slug);
    db.prepare('INSERT INTO dl_term_taxonomy (term_id, taxonomy, description, count) VALUES (?, ?, ?, 1)').run(t.lastInsertRowid, 'category', c.desc);
  });

  // Post 1: Flagship Manifesto
  const p1 = db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, featured_image, reading_time, drop_code, content_format
    ) VALUES (?, ?, ?, ?, ?, 'publish', 'post', ?, 4, ?, 'manifesto')
  `).run(
    authorId,
    'THE PLUG IS DEAD: A RETROGRADE CALL FOR CURATED ATELIERS',
    'the-plug-is-dead-manifesto',
    `The algorithmic feed did not liberate the publisher; it liquidated them.

For twenty years, the internet operated under the delusion that content management meant database abstraction over bloated PHP scripts, endlessly nesting comments inside tables that groaned under the weight of trackback spam and five-thousand-line template hierarchies.

[pullquote author="deadplug.digital atelier dispatch #01"]We do not need another headless CMS that costs six thousand dollars a month to serve cached markdown to thirty people. We need an engine that hits like a runway collection.[/pullquote]

[callout type="alert"]The legacy web is a necrotic shopping mall. The deadletter is the zine shoved into the lining of an obsidian trench coat.[/callout]

### THE ARCHITECTURE OF RESHARING

WordPress forgot what blogging was: it was **correspondence**. You did not simply broadcast into the algorithmic void; you responded. You re-lettered. You quoted the marginalia of peer nodes.

With Deadletters, resharing is not an afterthought or an embed iframe from a surveillance conglomerate. Resharing is the primary topological primitive. When an operator drops a letter, peer nodes can quote, append provenance signatures, and syndicate across the mesh.

[glitch]STAY WIRED. THE CURRENT WILL FIND ITS WAY.[/glitch]`,
    'The algorithmic feed did not liberate the publisher; it liquidated them. A manifesto on why deadplug.digital built deadletters.',
    '/uploads/deadplug_editorial_cover.jpg',
    generateDropCode('MANIFESTO')
  );

  // Link Post 1 to Manifesto Category
  db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, 1)').run(p1.lastInsertRowid);

  // Post 2: Monolith Architecture
  const p2 = db.prepare(`
    INSERT INTO dl_posts (
      post_author, post_title, post_name, post_content, post_excerpt,
      post_status, post_type, featured_image, reading_time, drop_code, content_format
    ) VALUES (?, ?, ?, ?, ?, 'publish', 'post', ?, 3, ?, 'standard')
  `).run(
    authorId,
    'BRUTALIST MONOLITHS: ZERO RUNTIME WEIGHT IN MODERN ATELIERS',
    'brutalist-monoliths-zero-weight',
    `In constructing the deadletters engine, the mandate was surgical: zero PHP, zero external database daemon requirements, zero client-side bloat.

By pairing SQLite synchronous Write-Ahead-Logging with an in-memory event bus and CSS variable design tokens, deadletters boots in under 40 milliseconds and serves cold-cache responses faster than a Redis cluster.

[pullquote author="System Engineer 04 // deadplug"]If an editorial platform cannot run off a USB key in a bunker during an electromagnetic pulse, it is not an archive; it is a subscription hostage.[/pullquote]

### THE THREE PRINCIPLES

1. **Provable Provenance**: Every re-letter carries a cryptographic signature tying curator commentary to the original author.
2. **Atelier Aesthetics**: Typography is not a default font stack; it is the physical architecture of the mind.
3. **Stand-Alone Portability**: Pack the entire engine into a zip file with one command. Unpack, run, publish.`,
    'Why deadletters chose embedded SQLite and pure Vanilla CSS tokens over the legacy enterprise web stack.',
    '/uploads/deadplug_monolith_architecture.jpg',
    generateDropCode('ENG')
  );

  db.prepare('INSERT INTO dl_term_relationships (object_id, term_taxonomy_id) VALUES (?, 4)').run(p2.lastInsertRowid);

  // Seed Reshare 1: Quoting Post 1 with commentary
  createReshare({
    userId: authorId,
    sourcePostId: p1.lastInsertRowid,
    sourceUrl: 'https://deadplug.digital/letters/the-plug-is-dead-manifesto',
    sourceNode: 'deadplug://tokyo-atelier',
    originalAuthor: 'Operator Clown // Atelier Lead',
    originalTitle: 'THE PLUG IS DEAD: A RETROGRADE CALL FOR CURATED ATELIERS',
    originalExcerpt: 'The algorithmic feed did not liberate the publisher; it liquidated them...',
    curatorCommentary: 'Essential reading for any studio tired of paying for four SaaS subscriptions just to run an art journal. The provenance verification on this drop is immaculate.',
    featuredImage: '/uploads/deadplug_editorial_cover.jpg'
  });

  // Seed Initial Comments
  db.prepare(`
    INSERT INTO dl_comments (comment_post_ID, comment_author, comment_author_email, comment_author_url, comment_content, comment_approved)
    VALUES (?, 'Kira Vance // Neon Index', 'kira@neonindex.org', 'https://neonindex.org', 'The typography in this engine is unlike anything in the CMS space. The drop caps and pullquote cards feel like a physical printed issue of Dazed or 032c.', '1')
  `).run(p1.lastInsertRowid);
}

module.exports = router;
