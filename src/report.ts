import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { format } from 'fast-csv';
import Db from './db';
import type { Page, DbImage, DbLink } from './types';

// Fields compared in diff reports. Module-level so they're easy to find and document.
// Chosen because they're the most likely to surface SEO regressions between crawls.
const DIFF_FIELDS: (keyof Page)[] = [
  'status_code',
  'title',
  'meta_description',
  'canonical_url',
  'is_indexable',
  'h1',
  'robots_directive',
];

/** Parsed report CLI arguments. */
export interface ReportArgs {
  site: string | null;
  session: number | null;
  compare: [number, number] | null;
  listSessions: boolean;
}

/**
 * Parses report CLI flags from an args array (pass process.argv.slice(2)).
 * Throws with a descriptive message if numeric flags receive non-numeric values.
 * @param argv - Raw CLI argument strings.
 * @returns Parsed flag values.
 */
export function parseArgs(argv: string[]): ReportArgs {
  const result: ReportArgs = { site: null, session: null, compare: null, listSessions: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') {
      result.site = argv[++i] ?? null;
    } else if (argv[i] === '--session') {
      const val = parseInt(argv[++i], 10);
      if (isNaN(val)) throw new Error(`--session requires a numeric ID, got: ${argv[i]}`);
      result.session = val;
    } else if (argv[i] === '--compare') {
      const rawA = argv[++i];
      const rawB = argv[++i];
      const a = parseInt(rawA, 10);
      const b = parseInt(rawB, 10);
      if (isNaN(a) || isNaN(b)) {
        throw new Error(`--compare requires two numeric session IDs, got: ${rawA} ${rawB}`);
      }
      result.compare = [a, b];
    } else if (argv[i] === '--list-sessions') {
      result.listSessions = true;
    }
  }
  return result;
}

/**
 * Writes an array of row objects to a CSV file using stream.pipeline for correct
 * backpressure handling and error propagation.
 * Uses the first row's keys as headers (fast-csv default with `headers: true`).
 * An empty rows array produces an empty file with no header row — consumers
 * should treat a 0-byte CSV as "no data" rather than an error.
 * @param filePath - Absolute or relative path to write to.
 * @param rows - Array of plain objects; all objects must share the same key set.
 * @returns Resolves when the file is fully written.
 */
export async function writeCsv(filePath: string, rows: Record<string, unknown>[]): Promise<void> {
  await pipeline(
    Readable.from(rows),
    format({ headers: true }),
    fs.createWriteStream(filePath)
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a value-to-count map for detecting duplicates.
 * Keys with falsy values (null, undefined, empty string) are excluded.
 * @param items - The array of objects to count over.
 * @param keyFn - Returns the value to count per item.
 * @returns Map from value to occurrence count.
 */
export function buildDuplicateMap<T>(items: T[], keyFn: (item: T) => unknown): Map<unknown, number> {
  const counts = new Map<unknown, number>();
  for (const item of items) {
    const key = keyFn(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Row generators — pure functions, no I/O, easy to unit test
// ---------------------------------------------------------------------------

/**
 * Builds rows for all-pages.csv — one row per URL regardless of status.
 * @param pages - All pages rows for a session.
 * @returns One row per page with url, status, status_code, content_type, is_indexable, depth.
 */
export function allPagesRows(pages: Page[]): Record<string, unknown>[] {
  return pages.map((p) => ({
    url: p.url,
    status: p.status,
    status_code: p.status_code ?? '',
    content_type: p.content_type ?? '',
    is_indexable: p.is_indexable ?? '',
    depth: p.depth ?? '',
  }));
}

/**
 * Builds rows for page-titles.csv.
 * Computes duplicate flag in-memory — a title is duplicate if it appears on 2+ pages.
 * @param htmlPages - Crawled HTML pages only (pre-filtered by caller).
 * @returns One row per page with url, title, title_length, missing, duplicate flags.
 */
export function pageTitlesRows(htmlPages: Page[]): Record<string, unknown>[] {
  const counts = buildDuplicateMap(htmlPages, (p) => p.title);
  return htmlPages.map((p) => ({
    url: p.url,
    title: p.title ?? '',
    title_length: p.title_length ?? '',
    missing: p.title === null ? 1 : 0,
    duplicate: p.title && (counts.get(p.title) ?? 0) > 1 ? 1 : 0,
  }));
}

/**
 * Builds rows for meta-descriptions.csv.
 * Computes duplicate flag in-memory — a description is duplicate if it appears on 2+ pages.
 * @param htmlPages - Crawled HTML pages only (pre-filtered by caller).
 * @returns One row per page with url, meta_description, meta_desc_length, missing, duplicate flags.
 */
export function metaDescriptionsRows(htmlPages: Page[]): Record<string, unknown>[] {
  const counts = buildDuplicateMap(htmlPages, (p) => p.meta_description);
  return htmlPages.map((p) => ({
    url: p.url,
    meta_description: p.meta_description ?? '',
    meta_desc_length: p.meta_desc_length ?? '',
    missing: p.meta_description === null ? 1 : 0,
    duplicate: p.meta_description && (counts.get(p.meta_description) ?? 0) > 1 ? 1 : 0,
  }));
}

/**
 * Builds rows for h1-tags.csv.
 * @param htmlPages - Crawled HTML pages only (pre-filtered by caller).
 * @returns One row per page with url, h1, h1_count, and issue classification.
 */
export function h1TagsRows(htmlPages: Page[]): Record<string, unknown>[] {
  return htmlPages.map((p) => ({
    url: p.url,
    h1: p.h1 ?? '',
    h1_count: p.h1_count,
    issue: p.h1_count === 0 ? 'missing' : p.h1_count > 1 ? 'multiple' : 'ok',
  }));
}

/**
 * Builds rows for canonicals.csv.
 * @param htmlPages - Crawled HTML pages only (pre-filtered by caller).
 * @returns One row per page with url, canonical_url, and type classification.
 */
export function canonicalsRows(htmlPages: Page[]): Record<string, unknown>[] {
  return htmlPages.map((p) => ({
    url: p.url,
    canonical_url: p.canonical_url ?? '',
    type: !p.canonical_url ? 'missing' : p.canonical_url === p.url ? 'self' : 'points-elsewhere',
  }));
}

/**
 * Builds rows for redirects.csv — only pages with a 3xx status code.
 * @param pages - All pages rows for a session.
 * @returns One row per redirect with source_url, redirect_url, status_code.
 */
export function redirectsRows(pages: Page[]): Record<string, unknown>[] {
  return pages
    .filter((p) => (p.status_code ?? 0) >= 300 && (p.status_code ?? 0) < 400)
    .map((p) => ({
      source_url: p.url,
      redirect_url: p.redirect_url ?? '',
      status_code: p.status_code,
    }));
}

/**
 * Builds rows for images.csv from the images table.
 * @param images - All images rows for a session.
 * @returns One row per image with page_url, src, alt, missing_alt, empty_alt flags.
 */
export function imagesRows(images: DbImage[]): Record<string, unknown>[] {
  return images.map((img) => ({
    page_url: img.page_url,
    src: img.src,
    alt: img.alt ?? '',
    missing_alt: img.alt === null ? 1 : 0,
    empty_alt: img.alt === '' ? 1 : 0,
  }));
}

/**
 * Builds rows for internal-links.csv from the links table.
 * @param links - Internal link rows for a session (is_external = 0).
 * @returns One row per link with source_url, target_url, anchor_text.
 */
export function internalLinksRows(links: DbLink[]): Record<string, unknown>[] {
  return links.map((l) => ({
    source_url: l.source_url,
    target_url: l.target_url,
    anchor_text: l.anchor_text ?? '',
  }));
}

/**
 * Builds rows for indexability.csv — only non-indexable crawled HTML pages.
 * @param htmlPages - Crawled HTML pages only (pre-filtered by caller).
 * @returns One row per non-indexable page with url, is_indexable, and reason.
 */
export function indexabilityRows(htmlPages: Page[]): Record<string, unknown>[] {
  return htmlPages
    .filter((p) => p.is_indexable === 0)
    .map((p) => {
      const reasons = [
        p.robots_directive?.toLowerCase().includes('noindex') ? 'meta robots' : null,
        p.x_robots_tag?.toLowerCase().includes('noindex') ? 'x-robots-tag' : null,
      ].filter(Boolean);
      return {
        url: p.url,
        is_indexable: 0,
        reason: reasons.join(', ') || 'unknown',
      };
    });
}

/**
 * Builds rows for sitemap-coverage.csv — only URLs where sitemap membership and crawl status diverge.
 * Excludes URLs that are both in the sitemap and successfully crawled (no discrepancy).
 * @param pages - All pages rows for a session.
 * @returns One row per discrepancy with url, in_sitemap, status, and issue classification.
 */
export function sitemapCoverageRows(pages: Page[]): Record<string, unknown>[] {
  return pages
    .filter(
      (p) =>
        (p.in_sitemap === 1 && p.status !== 'crawled') ||
        (p.in_sitemap === 0 && p.status === 'crawled')
    )
    .map((p) => ({
      url: p.url,
      in_sitemap: p.in_sitemap,
      status: p.status,
      issue: p.in_sitemap === 1 ? 'in_sitemap_not_crawled' : 'crawled_not_in_sitemap',
    }));
}

/**
 * Builds rows for issues-summary.csv — one row per issue per URL.
 * Accepts all pages (not just HTML) because it also processes redirects, broken links,
 * and fetch errors. HTML-specific checks are filtered internally. Contrast with other
 * row generators which accept pre-filtered htmlPages.
 * Issue types: missing_title, title_too_long, title_too_short, duplicate_title,
 *   missing_meta_description, meta_description_too_long, duplicate_meta_description,
 *   missing_h1, multiple_h1, noindex, missing_canonical, canonical_mismatch,
 *   images_missing_alt, images_empty_alt, redirect, broken, fetch_error.
 * @param pages - All pages rows for a session.
 * @returns One row per issue found, with url, issue type, and detail.
 */
export function issuesSummaryRows(pages: Page[]): Record<string, unknown>[] {
  const htmlPages = pages.filter(
    (p) => p.status === 'crawled' && p.content_type?.includes('text/html')
  );
  const titleCounts = buildDuplicateMap(htmlPages, (p) => p.title);
  const descCounts = buildDuplicateMap(htmlPages, (p) => p.meta_description);

  const rows: Record<string, unknown>[] = [];
  for (const p of pages) {
    const isHtml = p.status === 'crawled' && p.content_type?.includes('text/html');

    if (isHtml) {
      if (p.title === null) rows.push({ url: p.url, issue: 'missing_title', detail: '' });
      else if ((p.title_length ?? 0) > 60)
        rows.push({ url: p.url, issue: 'title_too_long', detail: `${p.title_length} chars` });
      else if ((p.title_length ?? 0) < 30)
        rows.push({ url: p.url, issue: 'title_too_short', detail: `${p.title_length} chars` });

      if (p.title && (titleCounts.get(p.title) ?? 0) > 1)
        rows.push({ url: p.url, issue: 'duplicate_title', detail: p.title });

      if (p.meta_description === null)
        rows.push({ url: p.url, issue: 'missing_meta_description', detail: '' });
      else if ((p.meta_desc_length ?? 0) > 160)
        rows.push({
          url: p.url,
          issue: 'meta_description_too_long',
          detail: `${p.meta_desc_length} chars`,
        });

      if (p.meta_description && (descCounts.get(p.meta_description) ?? 0) > 1)
        rows.push({
          url: p.url,
          issue: 'duplicate_meta_description',
          detail: p.meta_description.slice(0, 80),
        });

      if (p.h1_count === 0) rows.push({ url: p.url, issue: 'missing_h1', detail: '' });
      if (p.h1_count > 1)
        rows.push({ url: p.url, issue: 'multiple_h1', detail: `${p.h1_count} H1s` });

      if (p.is_indexable === 0)
        rows.push({
          url: p.url,
          issue: 'noindex',
          detail: p.robots_directive || p.x_robots_tag || '',
        });

      if (p.canonical_url === null)
        rows.push({ url: p.url, issue: 'missing_canonical', detail: '' });
      else if (p.canonical_url !== p.url)
        rows.push({ url: p.url, issue: 'canonical_mismatch', detail: p.canonical_url });

      if (p.images_missing_alt > 0)
        rows.push({
          url: p.url,
          issue: 'images_missing_alt',
          detail: `${p.images_missing_alt} images`,
        });
      if (p.images_empty_alt > 0)
        rows.push({
          url: p.url,
          issue: 'images_empty_alt',
          detail: `${p.images_empty_alt} images`,
        });
    }

    if ((p.status_code ?? 0) >= 300 && (p.status_code ?? 0) < 400)
      rows.push({
        url: p.url,
        issue: 'redirect',
        detail: `${p.status_code} → ${p.redirect_url || ''}`,
      });

    if ((p.status_code ?? 0) >= 400)
      rows.push({ url: p.url, issue: 'broken', detail: `HTTP ${p.status_code}` });

    if (p.status === 'error' && p.error_message)
      rows.push({ url: p.url, issue: 'fetch_error', detail: p.error_message });
  }
  return rows;
}

/**
 * Compares two sessions and returns rows describing field changes, new pages, and removed pages.
 * Compares the fields listed in DIFF_FIELDS (module-level constant).
 * @param pagesA - Pages from the earlier (baseline) session.
 * @param pagesB - Pages from the later session.
 * @returns One row per change, with url, change_type, field, and both session values.
 */
export function diffRows(pagesA: Page[], pagesB: Page[]): Record<string, unknown>[] {
  const mapA = new Map(pagesA.map((p) => [p.url, p]));
  const mapB = new Map(pagesB.map((p) => [p.url, p]));
  const rows: Record<string, unknown>[] = [];

  for (const [url, b] of mapB) {
    const a = mapA.get(url);
    if (!a) {
      rows.push({ url, change_type: 'new_page', field: '', session_a_value: '', session_b_value: '' });
      continue;
    }
    for (const field of DIFF_FIELDS) {
      if (a[field] !== b[field]) {
        rows.push({
          url,
          change_type: 'changed',
          field,
          session_a_value: a[field] ?? '',
          session_b_value: b[field] ?? '',
        });
      }
    }
  }

  for (const [url] of mapA) {
    if (!mapB.has(url)) {
      rows.push({
        url,
        change_type: 'removed_page',
        field: '',
        session_a_value: '',
        session_b_value: '',
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Generates all 11 CSV reports for a session and writes them to `outDir`.
 * Creates `outDir` if it does not exist.
 * @param db - The Db instance for the site.
 * @param sessionId - The session to report on.
 * @param outDir - Directory to write CSV files into.
 * @returns Resolves when all files are written.
 */
export async function generateReports(db: Db, sessionId: number, outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });

  const pages = db.getPages(sessionId);
  const htmlPages = pages.filter(
    (p) => p.status === 'crawled' && p.content_type?.includes('text/html')
  );
  const images = db.getImages(sessionId);
  const links = db.getInternalLinks(sessionId);

  await Promise.all([
    writeCsv(path.join(outDir, 'all-pages.csv'), allPagesRows(pages)),
    writeCsv(path.join(outDir, 'page-titles.csv'), pageTitlesRows(htmlPages)),
    writeCsv(path.join(outDir, 'meta-descriptions.csv'), metaDescriptionsRows(htmlPages)),
    writeCsv(path.join(outDir, 'h1-tags.csv'), h1TagsRows(htmlPages)),
    writeCsv(path.join(outDir, 'canonicals.csv'), canonicalsRows(htmlPages)),
    writeCsv(path.join(outDir, 'redirects.csv'), redirectsRows(pages)),
    writeCsv(path.join(outDir, 'images.csv'), imagesRows(images)),
    writeCsv(path.join(outDir, 'internal-links.csv'), internalLinksRows(links)),
    writeCsv(path.join(outDir, 'indexability.csv'), indexabilityRows(htmlPages)),
    writeCsv(path.join(outDir, 'sitemap-coverage.csv'), sitemapCoverageRows(pages)),
    writeCsv(path.join(outDir, 'issues-summary.csv'), issuesSummaryRows(pages)),
  ]);
}

/**
 * Prints a text summary of a completed session to stdout.
 * @param db - The Db instance for the site.
 * @param sessionId - The session to summarize.
 * @param outDir - Path where reports were written (included in output).
 */
export function printSummary(db: Db, sessionId: number, outDir: string): void {
  const session = db.getSession(sessionId);
  const pages = db.getPages(sessionId);
  const htmlPages = pages.filter(
    (p) => p.status === 'crawled' && p.content_type?.includes('text/html')
  );

  const crawled = pages.filter((p) => p.status === 'crawled').length;
  const broken = pages.filter((p) => (p.status_code ?? 0) >= 400).length;
  const missingTitles = htmlPages.filter((p) => p.title === null).length;
  const noindex = htmlPages.filter((p) => p.is_indexable === 0).length;

  let duration = '';
  if (session?.started_at && session?.completed_at) {
    const ms = new Date(session.completed_at).getTime() - new Date(session.started_at).getTime();
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  const label = session?.label ? ` — ${session.label}` : '';
  console.log(`\nSession ${sessionId}${label} — ${session?.site_url || ''}`);
  if (duration) console.log(`Duration: ${duration}`);
  console.log('');
  console.log(`Pages crawled:      ${crawled.toLocaleString()}`);
  console.log(`Broken links:       ${broken.toLocaleString()}`);
  console.log(`Missing titles:     ${missingTitles.toLocaleString()}`);
  console.log(`Noindex pages:      ${noindex.toLocaleString()}`);
  console.log(`\nReports: ${outDir}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Options passed to report(). */
interface ReportOptions {
  args?: ReportArgs;
}

/**
 * Main report entry point.
 * Throws on invalid arguments rather than calling process.exit().
 * @param opts - Optional pre-parsed args (useful for tests).
 * @returns Resolves when reporting is complete.
 */
export async function report(opts: ReportOptions = {}): Promise<void> {
  const args = opts.args || parseArgs(process.argv.slice(2));

  if (!args.site) {
    throw new Error(
      '--site is required. Usage: report --site <url> [--session <id>] [--compare <a> <b>] [--list-sessions]'
    );
  }

  const hostname = new URL(args.site).hostname;
  const db = new Db(hostname);

  try {
    if (args.listSessions) {
      const sessions = db.listSessions();
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      console.log(`\nSessions for ${hostname}:`);
      console.log('ID   Status        Pages  Label                Started');
      console.log('─'.repeat(65));
      for (const s of sessions) {
        const id = String(s.id).padEnd(4);
        const status = s.status.padEnd(13);
        const pages = String(s.total_pages ?? '-').padEnd(6);
        const label = (s.label ?? '-').padEnd(20);
        console.log(`${id} ${status} ${pages} ${label} ${s.started_at}`);
      }
      return;
    }

    if (args.compare) {
      const [idA, idB] = args.compare;
      const rows = diffRows(db.getPages(idA), db.getPages(idB));
      const outDir = path.join('audits', hostname, 'reports');
      fs.mkdirSync(outDir, { recursive: true });
      const diffFile = path.join(outDir, `diff-session-${idA}-vs-${idB}.csv`);
      await writeCsv(diffFile, rows);
      console.log(`Diff: ${diffFile} (${rows.length} change${rows.length !== 1 ? 's' : ''})`);
      return;
    }

    let sessionId: number;
    if (args.session !== null) {
      sessionId = args.session;
    } else {
      const sessions = db.listSessions();
      if (sessions.length === 0) throw new Error('No sessions found. Run a crawl first.');
      sessionId = Math.max(...sessions.map((s) => s.id));
    }

    const outDir = path.join('audits', hostname, 'reports', `session-${sessionId}`);
    await generateReports(db, sessionId, outDir);
    printSummary(db, sessionId, outDir);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config();
  report().catch((err: Error) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
