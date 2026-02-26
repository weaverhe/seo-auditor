import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { PageData, LinkData, ImageData, Session, Page, DbImage, DbLink } from '../types';

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/**
 * Manages all interactions with a site's SQLite database.
 * One instance per site — open once, reuse across the crawl.
 */
class Db {
  db: Database.Database;
  closed: boolean;

  /**
   * Opens (or creates) the crawl database for a given hostname.
   * Creates the audits/{hostname}/ directory if it doesn't exist.
   * @param hostname - e.g. 'example.com'
   */
  constructor(hostname: string) {
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * Creates a new crawl session for a given site.
   * @param siteUrl - The root URL being crawled, e.g. 'https://example.com'.
   * @param label - Optional human-readable label, e.g. 'baseline'.
   * @returns The ID of the newly created session.
   */
  createSession(siteUrl: string, label?: string | null): number {
    const result = this.db
      .prepare('INSERT INTO sessions (site_url, label) VALUES (?, ?)')
      .run(siteUrl, label || null);
    return result.lastInsertRowid as number;
  }

  /**
   * Updates the status of a crawl session.
   * When status is 'complete' or 'interrupted', also sets completed_at and total_pages.
   * @param sessionId - The session to update.
   * @param status - New status value.
   */
  updateSessionStatus(sessionId: number, status: 'running' | 'complete' | 'interrupted'): void {
    if (status === 'complete' || status === 'interrupted') {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS count FROM pages WHERE session_id = ? AND status = 'crawled'`)
        .get(sessionId) as { count: number };
      this.db
        .prepare(
          `
        UPDATE sessions
        SET status = ?, completed_at = datetime('now'), total_pages = ?
        WHERE id = ?
      `
        )
        .run(status, row.count, sessionId);
    } else {
      this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, sessionId);
    }
  }

  /**
   * Returns the most recent session with status 'interrupted', or undefined if none exists.
   * @returns The interrupted session row, or undefined.
   */
  getLatestInterruptedSession(): Session | undefined {
    return this.db
      .prepare(
        `
      SELECT * FROM sessions
      WHERE status = 'interrupted'
      ORDER BY id DESC
      LIMIT 1
    `
      )
      .get() as Session | undefined;
  }

  /**
   * Returns all sessions for this site in ascending order.
   * @returns All session rows.
   */
  listSessions(): Session[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY id').all() as Session[];
  }

  /**
   * Returns a single session by ID, or undefined if not found.
   * @param sessionId - The session ID to look up.
   * @returns The session row, or undefined.
   */
  getSession(sessionId: number): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as Session | undefined;
  }

  /**
   * Returns all pages for a session ordered by URL.
   * @param sessionId - The session to query.
   * @returns All page rows for the session.
   */
  getPages(sessionId: number): Page[] {
    return this.db
      .prepare('SELECT * FROM pages WHERE session_id = ? ORDER BY url')
      .all(sessionId) as Page[];
  }

  /**
   * Returns all images discovered during a session.
   * @param sessionId - The session to query.
   * @returns All image rows for the session.
   */
  getImages(sessionId: number): DbImage[] {
    return this.db
      .prepare('SELECT * FROM images WHERE session_id = ?')
      .all(sessionId) as DbImage[];
  }

  /**
   * Returns all internal links discovered during a session.
   * @param sessionId - The session to query.
   * @returns Internal link rows (is_external = 0) for the session.
   */
  getInternalLinks(sessionId: number): DbLink[] {
    return this.db
      .prepare('SELECT * FROM links WHERE session_id = ? AND is_external = 0')
      .all(sessionId) as DbLink[];
  }

  /**
   * Returns all page URLs for a session (any status).
   * Used to seed the `seen` set on resume.
   * @param sessionId - The session to query.
   * @returns Array of URL strings.
   */
  getAllPageUrls(sessionId: number): string[] {
    return (
      this.db
        .prepare('SELECT url FROM pages WHERE session_id = ?')
        .all(sessionId) as { url: string }[]
    ).map((r) => r.url);
  }

  /**
   * Returns all distinct link target URLs discovered during a session.
   * Used alongside getAllPageUrls to fully seed `seen` on resume.
   * @param sessionId - The session to query.
   * @returns Array of target URL strings.
   */
  getLinkTargetUrls(sessionId: number): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT target_url FROM links WHERE session_id = ?')
        .all(sessionId) as { target_url: string }[]
    ).map((r) => r.target_url);
  }

  /**
   * Inserts a page into the queue. Does nothing if the URL already exists for this session.
   * ON CONFLICT DO NOTHING means the first insertion wins — depth and in_sitemap are not
   * updated on duplicates. In practice, sitemap URLs are seeded before crawling begins so
   * they get in_sitemap=1 and depth=0. Link-discovered URLs inserted later are silently
   * ignored if already present.
   * @param sessionId - The session this page belongs to.
   * @param page - The page fields to insert.
   * @param page.url - The page URL.
   * @param [page.status] - Initial status; defaults to 'pending'.
   * @param [page.depth] - Crawl depth; defaults to 0.
   * @param [page.in_sitemap] - Whether the URL was found in the sitemap; defaults to 0.
   */
  upsertPage(
    sessionId: number,
    { url, status = 'pending', depth = 0, in_sitemap = 0 }: {
      url: string;
      status?: string;
      depth?: number;
      in_sitemap?: number;
    }
  ): void {
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
   * @param sessionId - The session to query.
   * @returns Array of pending URL + depth pairs.
   */
  getPendingUrls(sessionId: number): { url: string; depth: number }[] {
    return this.db
      .prepare(
        `
      SELECT url, depth FROM pages
      WHERE session_id = ? AND status = 'pending'
      ORDER BY depth ASC
    `
      )
      .all(sessionId) as { url: string; depth: number }[];
  }

  /**
   * Marks a page as crawled and writes all extracted SEO data.
   * The SET clause is built dynamically from the keys of `data`, so whatever fields
   * emptyPage() (in crawler.ts) defines are automatically written — no manual sync needed.
   * @param sessionId - The session this page belongs to.
   * @param url - The URL that was crawled.
   * @param data - Fields matching the pages table columns (see schema.sql).
   */
  markPageCrawled(sessionId: number, url: string, data: PageData): void {
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
      .run({ ...(data as unknown as Record<string, unknown>), session_id: sessionId, url });
  }

  /**
   * Marks a page as errored with an optional status code and message.
   * @param sessionId - The session this page belongs to.
   * @param url - The URL that errored.
   * @param statusCode - HTTP status code, or null for network errors.
   * @param errorMessage - Human-readable error description.
   */
  markPageError(
    sessionId: number,
    url: string,
    statusCode: number | null,
    errorMessage: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE pages
      SET status = 'error', status_code = @status_code, error_message = @error_message, crawled_at = datetime('now')
      WHERE session_id = @session_id AND url = @url`
      )
      .run({
        session_id: sessionId,
        url,
        status_code: statusCode || null,
        error_message: errorMessage || null,
      });
  }

  /**
   * Marks a page as skipped (e.g. disallowed by robots.txt).
   * @param sessionId - The session this page belongs to.
   * @param url - The URL that was skipped.
   * @param reason - Human-readable explanation.
   */
  markPageSkipped(sessionId: number, url: string, reason?: string): void {
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
   * @param sessionId - The session this page belongs to.
   * @param url - The URL that was crawled.
   * @param pageData - Passed directly to markPageCrawled.
   * @param links - Links discovered on the page.
   * @param images - Images discovered on the page.
   */
  persistPageResult(
    sessionId: number,
    url: string,
    pageData: PageData,
    links: LinkData[] = [],
    images: ImageData[] = []
  ): void {
    this.db.transaction(() => {
      this.markPageCrawled(sessionId, url, pageData);
      if (links.length > 0) this.insertLinks(sessionId, links);
      if (images.length > 0) this.insertImages(sessionId, images);
    })();
  }

  /**
   * Bulk-inserts links found on a page within a single transaction.
   * @param sessionId - The session these links belong to.
   * @param links - The link records to insert.
   */
  insertLinks(sessionId: number, links: LinkData[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO links (session_id, source_url, target_url, anchor_text, is_external) VALUES (?, ?, ?, ?, ?)'
    );
    this.db.transaction((rows: LinkData[]) => {
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
   * @param sessionId - The session these images belong to.
   * @param images - The image records to insert.
   */
  insertImages(sessionId: number, images: ImageData[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO images (session_id, page_url, src, alt) VALUES (?, ?, ?, ?)'
    );
    this.db.transaction((rows: ImageData[]) => {
      for (const img of rows) {
        stmt.run(sessionId, img.page_url, img.src, img.alt ?? null);
      }
    })(images);
  }
}

export default Db;
