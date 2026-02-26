'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/**
 * Manages all interactions with a site's SQLite database.
 * One instance per site — open once, reuse across the crawl.
 */
class Db {
  /**
   * Opens (or creates) the crawl database for a given hostname.
   * Creates the audits/{hostname}/ directory if it doesn't exist.
   * @param {string} hostname - e.g. 'example.com'
   */
  constructor(hostname) {
    const dir = path.join('audits', hostname);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'crawl.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(schema);
    this.closed = false;
  }

  /**
   * Closes the database connection. Call this when the crawl is complete.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * Creates a new crawl session for a given site.
   * @param {string} siteUrl - The root URL being crawled, e.g. 'https://example.com'.
   * @param {string} [label] - Optional human-readable label, e.g. 'baseline'.
   * @returns {number} The ID of the newly created session.
   */
  createSession(siteUrl, label) {
    const result = this.db
      .prepare('INSERT INTO sessions (site_url, label) VALUES (?, ?)')
      .run(siteUrl, label || null);
    return result.lastInsertRowid;
  }

  /**
   * Updates the status of a crawl session.
   * When status is 'complete' or 'interrupted', also sets completed_at and total_pages.
   * @param {number} sessionId
   * @param {'running'|'complete'|'interrupted'} status
   */
  updateSessionStatus(sessionId, status) {
    if (status === 'complete' || status === 'interrupted') {
      const { count } = this.db
        .prepare(`SELECT COUNT(*) AS count FROM pages WHERE session_id = ? AND status = 'crawled'`)
        .get(sessionId);
      this.db
        .prepare(
          `
        UPDATE sessions
        SET status = ?, completed_at = datetime('now'), total_pages = ?
        WHERE id = ?
      `
        )
        .run(status, count, sessionId);
    } else {
      this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, sessionId);
    }
  }

  /**
   * Returns the most recent session with status 'interrupted', or undefined if none exists.
   * @returns {{ id: number, site_url: string, label: string, status: string } | undefined}
   */
  getLatestInterruptedSession() {
    return this.db
      .prepare(
        `
      SELECT * FROM sessions
      WHERE status = 'interrupted'
      ORDER BY id DESC
      LIMIT 1
    `
      )
      .get();
  }

  /**
   * Returns all sessions for this site in ascending order.
   * @returns {Array<{ id: number, site_url: string, label: string, status: string, started_at: string, completed_at: string, total_pages: number }>}
   */
  listSessions() {
    return this.db.prepare('SELECT * FROM sessions ORDER BY id').all();
  }

  /**
   * Returns a single session by ID, or undefined if not found.
   * @param {number} sessionId
   * @returns {{ id: number, site_url: string, label: string, status: string, started_at: string, completed_at: string, total_pages: number } | undefined}
   */
  getSession(sessionId) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  }

  /**
   * Returns all pages for a session ordered by URL.
   * @param {number} sessionId
   * @returns {Object[]}
   */
  getPages(sessionId) {
    return this.db
      .prepare('SELECT * FROM pages WHERE session_id = ? ORDER BY url')
      .all(sessionId);
  }

  /**
   * Returns all images discovered during a session.
   * @param {number} sessionId
   * @returns {Object[]}
   */
  getImages(sessionId) {
    return this.db.prepare('SELECT * FROM images WHERE session_id = ?').all(sessionId);
  }

  /**
   * Returns all internal links discovered during a session.
   * @param {number} sessionId
   * @returns {Object[]}
   */
  getInternalLinks(sessionId) {
    return this.db
      .prepare('SELECT * FROM links WHERE session_id = ? AND is_external = 0')
      .all(sessionId);
  }

  /**
   * Returns all page URLs for a session (any status).
   * Used to seed the `seen` set on resume.
   * @param {number} sessionId
   * @returns {string[]}
   */
  getAllPageUrls(sessionId) {
    return this.db
      .prepare('SELECT url FROM pages WHERE session_id = ?')
      .all(sessionId)
      .map((r) => r.url);
  }

  /**
   * Returns all distinct link target URLs discovered during a session.
   * Used alongside getAllPageUrls to fully seed `seen` on resume.
   * @param {number} sessionId
   * @returns {string[]}
   */
  getLinkTargetUrls(sessionId) {
    return this.db
      .prepare('SELECT DISTINCT target_url FROM links WHERE session_id = ?')
      .all(sessionId)
      .map((r) => r.target_url);
  }

  /**
   * Inserts a page into the queue. Does nothing if the URL already exists for this session.
   * ON CONFLICT DO NOTHING means the first insertion wins — depth and in_sitemap are not
   * updated on duplicates. In practice, sitemap URLs are seeded before crawling begins so
   * they get in_sitemap=1 and depth=0. Link-discovered URLs inserted later are silently
   * ignored if already present.
   * @param {number} sessionId
   * @param {{ url: string, status?: string, depth?: number, in_sitemap?: number }} page
   */
  upsertPage(sessionId, { url, status = 'pending', depth = 0, in_sitemap = 0 }) {
    this.db
      .prepare(
        `
      INSERT INTO pages (session_id, url, status, depth, in_sitemap)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, url) DO NOTHING
    `
      )
      .run(sessionId, url, status, depth, in_sitemap);
  }

  /**
   * Returns all pending URLs for a session, ordered shallowest-first.
   * @param {number} sessionId
   * @returns {Array<{ url: string, depth: number }>}
   */
  getPendingUrls(sessionId) {
    return this.db
      .prepare(
        `
      SELECT url, depth FROM pages
      WHERE session_id = ? AND status = 'pending'
      ORDER BY depth ASC
    `
      )
      .all(sessionId);
  }

  /**
   * Marks a page as crawled and writes all extracted SEO data.
   * The SET clause is built dynamically from the keys of `data`, so whatever fields
   * emptyPage() (in crawler.js) defines are automatically written — no manual sync needed.
   * @param {number} sessionId
   * @param {string} url
   * @param {Object} data - Fields matching the pages table columns (see schema.sql).
   */
  markPageCrawled(sessionId, url, data) {
    const setClause = Object.keys(data)
      .map((col) => `${col} = @${col}`)
      .join(',\n        ');
    this.db
      .prepare(
        `UPDATE pages SET
        status     = 'crawled',
        crawled_at = datetime('now'),
        ${setClause}
      WHERE session_id = @session_id AND url = @url`
      )
      .run({ ...data, session_id: sessionId, url });
  }

  /**
   * Marks a page as errored with an optional status code and message.
   * @param {number} sessionId
   * @param {string} url
   * @param {number|null} statusCode
   * @param {string|null} errorMessage
   */
  markPageError(sessionId, url, statusCode, errorMessage) {
    this.db
      .prepare(
        `UPDATE pages
      SET status = 'error', status_code = @status_code, error_message = @error_message, crawled_at = datetime('now')
      WHERE session_id = @session_id AND url = @url`
      )
      .run({ session_id: sessionId, url, status_code: statusCode || null, error_message: errorMessage || null });
  }

  /**
   * Marks a page as skipped (e.g. disallowed by robots.txt).
   * @param {number} sessionId
   * @param {string} url
   * @param {string} [reason] - Human-readable explanation.
   */
  markPageSkipped(sessionId, url, reason) {
    this.db
      .prepare(
        `UPDATE pages
      SET status = 'skipped', error_message = @error_message
      WHERE session_id = @session_id AND url = @url`
      )
      .run({ session_id: sessionId, url, error_message: reason || null });
  }

  /**
   * Atomically persists a crawled page's SEO data alongside its links and images.
   * Wraps markPageCrawled + insertLinks + insertImages in a single transaction so a
   * crash between them can't leave a page marked crawled with no links/images recorded.
   * @param {number} sessionId
   * @param {string} url
   * @param {Object} pageData - Passed directly to markPageCrawled.
   * @param {Array} [links]
   * @param {Array} [images]
   */
  persistPageResult(sessionId, url, pageData, links = [], images = []) {
    this.db.transaction(() => {
      this.markPageCrawled(sessionId, url, pageData);
      if (links.length > 0) this.insertLinks(sessionId, links);
      if (images.length > 0) this.insertImages(sessionId, images);
    })();
  }

  /**
   * Bulk-inserts links found on a page within a single transaction.
   * @param {number} sessionId
   * @param {Array<{ source_url: string, target_url: string, anchor_text?: string, is_external: boolean }>} links
   */
  insertLinks(sessionId, links) {
    const stmt = this.db.prepare(
      'INSERT INTO links (session_id, source_url, target_url, anchor_text, is_external) VALUES (?, ?, ?, ?, ?)'
    );
    this.db.transaction((rows) => {
      for (const link of rows) {
        stmt.run(
          sessionId,
          link.source_url,
          link.target_url,
          link.anchor_text || null,
          link.is_external ? 1 : 0
        );
      }
    })(links);
  }

  /**
   * Bulk-inserts images found on a page within a single transaction.
   * @param {number} sessionId
   * @param {Array<{ page_url: string, src: string, alt?: string }>} images
   */
  insertImages(sessionId, images) {
    const stmt = this.db.prepare(
      'INSERT INTO images (session_id, page_url, src, alt) VALUES (?, ?, ?, ?)'
    );
    this.db.transaction((rows) => {
      for (const img of rows) {
        stmt.run(sessionId, img.page_url, img.src, img.alt ?? null);
      }
    })(images);
  }
}

module.exports = Db;
