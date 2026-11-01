function runMigrations(db) {
  if (!db) return;

  // Create any missing tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS dl_revisions (
      revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      post_title TEXT,
      post_content TEXT,
      post_excerpt TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES dl_posts(ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dl_nav_menus (
      menu_id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_location TEXT UNIQUE NOT NULL,
      items_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ensure columns exist on dl_posts
  const columns = db.prepare("PRAGMA table_info(dl_posts)").all().map(c => c.name);
  
  if (!columns.includes('is_sticky')) {
    db.prepare("ALTER TABLE dl_posts ADD COLUMN is_sticky INTEGER DEFAULT 0").run();
  }
  if (!columns.includes('post_password')) {
    db.prepare("ALTER TABLE dl_posts ADD COLUMN post_password TEXT DEFAULT NULL").run();
  }
  if (!columns.includes('menu_order')) {
    db.prepare("ALTER TABLE dl_posts ADD COLUMN menu_order INTEGER DEFAULT 0").run();
  }
  if (!columns.includes('post_parent')) {
    db.prepare("ALTER TABLE dl_posts ADD COLUMN post_parent INTEGER DEFAULT 0").run();
  }
}

module.exports = { runMigrations };
