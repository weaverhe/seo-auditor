CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url      TEXT NOT NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  started_at    DATETIME NOT NULL DEFAULT (datetime('now')),
  completed_at  DATETIME,
  total_pages   INTEGER
);

CREATE TABLE IF NOT EXISTS pages (
  session_id          INTEGER NOT NULL,
  url                 TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  status_code         INTEGER,
  redirect_url        TEXT,
  content_type        TEXT,
  title               TEXT,
  title_length        INTEGER,
  title_duplicate     INTEGER,
  meta_description    TEXT,
  meta_desc_length    INTEGER,
  meta_desc_duplicate INTEGER,
  h1                  TEXT,
  h1_count            INTEGER,
  h2_count            INTEGER,
  canonical_url       TEXT,
  robots_directive    TEXT,
  x_robots_tag        TEXT,
  is_indexable        INTEGER,
  word_count          INTEGER,
  internal_link_count INTEGER,
  external_link_count INTEGER,
  image_count         INTEGER,
  images_missing_alt  INTEGER,
  has_schema          INTEGER,
  response_time_ms    INTEGER,
  page_size_bytes     INTEGER,
  depth               INTEGER,
  in_sitemap          INTEGER DEFAULT 0,
  crawled_at          DATETIME,
  error_message       TEXT,
  UNIQUE(session_id, url)
);

CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  source_url  TEXT NOT NULL,
  target_url  TEXT NOT NULL,
  anchor_text TEXT,
  is_external INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  page_url    TEXT NOT NULL,
  src         TEXT NOT NULL,
  alt         TEXT
);
