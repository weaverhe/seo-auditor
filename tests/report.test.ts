import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as fastcsv from 'fast-csv';
import Db from '../src/db';
import {
  parseArgs,
  buildDuplicateMap,
  allPagesRows,
  pageTitlesRows,
  metaDescriptionsRows,
  h1TagsRows,
  canonicalsRows,
  redirectsRows,
  imagesRows,
  internalLinksRows,
  indexabilityRows,
  sitemapCoverageRows,
  issuesSummaryRows,
  diffRows,
  generateReports,
  report,
} from '../src/report';
import type { Page, DbImage, DbLink } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCsv(filePath: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    fastcsv
      .parseFile(filePath, { headers: true })
      .on('data', (row: Record<string, string>) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: parses --site', () => {
  const args = parseArgs(['--site', 'https://example.com']);
  assert.equal(args.site, 'https://example.com');
  assert.equal(args.session, null);
  assert.equal(args.compare, null);
  assert.equal(args.listSessions, false);
});

test('parseArgs: parses --session', () => {
  const args = parseArgs(['--site', 'https://example.com', '--session', '3']);
  assert.equal(args.session, 3);
});

test('parseArgs: parses --compare', () => {
  const args = parseArgs(['--site', 'https://example.com', '--compare', '1', '3']);
  assert.deepEqual(args.compare, [1, 3]);
});

test('parseArgs: parses --list-sessions', () => {
  const args = parseArgs(['--site', 'https://example.com', '--list-sessions']);
  assert.equal(args.listSessions, true);
});

test('parseArgs: returns null site when --site not provided', () => {
  const args = parseArgs([]);
  assert.equal(args.site, null);
});

test('parseArgs: throws on non-numeric --session value', () => {
  assert.throws(() => parseArgs(['--site', 'https://example.com', '--session', 'abc']), /--session requires a numeric ID/);
});

test('parseArgs: throws on non-numeric --compare values', () => {
  assert.throws(() => parseArgs(['--site', 'https://example.com', '--compare', '1', 'abc']), /--compare requires two numeric session IDs/);
});

// ---------------------------------------------------------------------------
// buildDuplicateMap
// ---------------------------------------------------------------------------

test('buildDuplicateMap: counts occurrences of keyed values', () => {
  const items = [{ v: 'a' }, { v: 'b' }, { v: 'a' }];
  const map = buildDuplicateMap(items, (i) => i.v);
  assert.equal(map.get('a'), 2);
  assert.equal(map.get('b'), 1);
});

test('buildDuplicateMap: excludes null and empty string keys', () => {
  const items = [{ v: null }, { v: '' }, { v: 'real' }];
  const map = buildDuplicateMap(items, (i) => i.v);
  assert.equal(map.size, 1);
  assert.equal(map.get('real'), 1);
});

// ---------------------------------------------------------------------------
// Row generator fixtures
// ---------------------------------------------------------------------------

const HTML_PAGE: Page = {
  id: 1,
  session_id: 1,
  url: 'https://example.com/',
  status: 'crawled',
  status_code: 200,
  content_type: 'text/html',
  title: 'Home Page Title Here',
  title_length: 20,
  meta_description: 'A great description for the home page',
  meta_desc_length: 37,
  h1: 'Welcome',
  h1_count: 1,
  h2_count: 2,
  canonical_url: 'https://example.com/',
  robots_directive: null,
  x_robots_tag: null,
  is_indexable: 1,
  images_missing_alt: 0,
  images_empty_alt: 0,
  depth: 0,
  in_sitemap: 1,
  redirect_url: null,
  error_message: null,
  crawled_at: null,
  word_count: 0,
  internal_link_count: 0,
  external_link_count: 0,
  image_count: 0,
  has_schema: 0,
  response_time_ms: null,
  page_size_bytes: null,
};

const REDIRECT_PAGE: Page = {
  ...HTML_PAGE,
  url: 'https://example.com/old',
  status: 'crawled',
  status_code: 301,
  content_type: null,
  title: null,
  title_length: null,
  meta_description: null,
  meta_desc_length: null,
  h1: null,
  h1_count: 0,
  canonical_url: null,
  is_indexable: 0,
  redirect_url: 'https://example.com/new',
  in_sitemap: 0,
};

const BROKEN_PAGE: Page = {
  ...HTML_PAGE,
  url: 'https://example.com/gone',
  status: 'error',
  status_code: 404,
  content_type: null,
  title: null,
  title_length: null,
  meta_description: null,
  meta_desc_length: null,
  h1: null,
  h1_count: 0,
  canonical_url: null,
  is_indexable: null,
  in_sitemap: 0,
  error_message: 'HTTP 404',
};

// ---------------------------------------------------------------------------
// allPagesRows
// ---------------------------------------------------------------------------

test('allPagesRows: maps url, status, status_code, content_type, is_indexable, depth', () => {
  const rows = allPagesRows([HTML_PAGE]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.com/');
  assert.equal(rows[0].status, 'crawled');
  assert.equal(rows[0].status_code, 200);
  assert.equal(rows[0].content_type, 'text/html');
  assert.equal(rows[0].is_indexable, 1);
  assert.equal(rows[0].depth, 0);
});

test('allPagesRows: fills empty string for null fields', () => {
  const rows = allPagesRows([BROKEN_PAGE]);
  assert.equal(rows[0].content_type, '');
  assert.equal(rows[0].is_indexable, '');
});

// ---------------------------------------------------------------------------
// pageTitlesRows
// ---------------------------------------------------------------------------

test('pageTitlesRows: marks missing title', () => {
  const page: Page = { ...HTML_PAGE, title: null, title_length: null };
  const rows = pageTitlesRows([page]);
  assert.equal(rows[0].missing, 1);
  assert.equal(rows[0].title, '');
});

test('pageTitlesRows: marks duplicate titles across pages', () => {
  const p1: Page = { ...HTML_PAGE, url: 'https://example.com/a' };
  const p2: Page = { ...HTML_PAGE, url: 'https://example.com/b' };
  const rows = pageTitlesRows([p1, p2]);
  assert.equal(rows[0].duplicate, 1);
  assert.equal(rows[1].duplicate, 1);
});

test('pageTitlesRows: unique title is not marked duplicate', () => {
  const rows = pageTitlesRows([HTML_PAGE]);
  assert.equal(rows[0].duplicate, 0);
});

// ---------------------------------------------------------------------------
// metaDescriptionsRows
// ---------------------------------------------------------------------------

test('metaDescriptionsRows: marks missing meta description', () => {
  const page: Page = { ...HTML_PAGE, meta_description: null, meta_desc_length: null };
  const rows = metaDescriptionsRows([page]);
  assert.equal(rows[0].missing, 1);
});

test('metaDescriptionsRows: marks duplicate meta descriptions', () => {
  const p1: Page = { ...HTML_PAGE, url: 'https://example.com/a' };
  const p2: Page = { ...HTML_PAGE, url: 'https://example.com/b' };
  const rows = metaDescriptionsRows([p1, p2]);
  assert.equal(rows[0].duplicate, 1);
  assert.equal(rows[1].duplicate, 1);
});

// ---------------------------------------------------------------------------
// h1TagsRows
// ---------------------------------------------------------------------------

test('h1TagsRows: issue is ok for single h1', () => {
  const rows = h1TagsRows([HTML_PAGE]);
  assert.equal(rows[0].issue, 'ok');
});

test('h1TagsRows: issue is missing when h1_count is 0', () => {
  const rows = h1TagsRows([{ ...HTML_PAGE, h1_count: 0 }]);
  assert.equal(rows[0].issue, 'missing');
});

test('h1TagsRows: issue is multiple when h1_count > 1', () => {
  const rows = h1TagsRows([{ ...HTML_PAGE, h1_count: 3 }]);
  assert.equal(rows[0].issue, 'multiple');
});

// ---------------------------------------------------------------------------
// canonicalsRows
// ---------------------------------------------------------------------------

test('canonicalsRows: type is self when canonical matches url', () => {
  const rows = canonicalsRows([HTML_PAGE]);
  assert.equal(rows[0].type, 'self');
});

test('canonicalsRows: type is points-elsewhere when canonical differs', () => {
  const page: Page = { ...HTML_PAGE, canonical_url: 'https://example.com/other' };
  const rows = canonicalsRows([page]);
  assert.equal(rows[0].type, 'points-elsewhere');
});

test('canonicalsRows: type is missing when canonical is null', () => {
  const page: Page = { ...HTML_PAGE, canonical_url: null };
  const rows = canonicalsRows([page]);
  assert.equal(rows[0].type, 'missing');
});

// ---------------------------------------------------------------------------
// redirectsRows
// ---------------------------------------------------------------------------

test('redirectsRows: only includes 3xx pages', () => {
  const rows = redirectsRows([HTML_PAGE, REDIRECT_PAGE, BROKEN_PAGE]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_url, 'https://example.com/old');
  assert.equal(rows[0].redirect_url, 'https://example.com/new');
  assert.equal(rows[0].status_code, 301);
});

test('redirectsRows: returns empty array when no redirects', () => {
  assert.equal(redirectsRows([HTML_PAGE]).length, 0);
});

// ---------------------------------------------------------------------------
// imagesRows
// ---------------------------------------------------------------------------

test('imagesRows: flags missing_alt for null alt', () => {
  const img: DbImage = { id: 1, session_id: 1, page_url: 'https://example.com/', src: 'https://example.com/img.jpg', alt: null };
  const rows = imagesRows([img]);
  assert.equal(rows[0].missing_alt, 1);
  assert.equal(rows[0].empty_alt, 0);
  assert.equal(rows[0].alt, '');
});

test('imagesRows: flags empty_alt for empty string alt', () => {
  const img: DbImage = { id: 1, session_id: 1, page_url: 'https://example.com/', src: 'https://example.com/img.jpg', alt: '' };
  const rows = imagesRows([img]);
  assert.equal(rows[0].missing_alt, 0);
  assert.equal(rows[0].empty_alt, 1);
});

test('imagesRows: neither flag set when alt has text', () => {
  const img: DbImage = { id: 1, session_id: 1, page_url: 'https://example.com/', src: 'https://example.com/img.jpg', alt: 'Logo' };
  const rows = imagesRows([img]);
  assert.equal(rows[0].missing_alt, 0);
  assert.equal(rows[0].empty_alt, 0);
});

// ---------------------------------------------------------------------------
// internalLinksRows
// ---------------------------------------------------------------------------

test('internalLinksRows: maps source, target, anchor_text', () => {
  const link: DbLink = {
    id: 1,
    session_id: 1,
    source_url: 'https://example.com/',
    target_url: 'https://example.com/about',
    anchor_text: 'About',
    is_external: 0,
  };
  const rows = internalLinksRows([link]);
  assert.equal(rows[0].source_url, 'https://example.com/');
  assert.equal(rows[0].target_url, 'https://example.com/about');
  assert.equal(rows[0].anchor_text, 'About');
});

// ---------------------------------------------------------------------------
// indexabilityRows
// ---------------------------------------------------------------------------

test('indexabilityRows: only includes is_indexable = 0 pages', () => {
  const noindex: Page = {
    ...HTML_PAGE,
    is_indexable: 0,
    robots_directive: 'noindex, follow',
    x_robots_tag: null,
  };
  const rows = indexabilityRows([HTML_PAGE, noindex]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, noindex.url);
  assert.equal(rows[0].reason, 'meta robots');
});

test('indexabilityRows: reason includes x-robots-tag when present', () => {
  const page: Page = { ...HTML_PAGE, is_indexable: 0, robots_directive: null, x_robots_tag: 'noindex' };
  const rows = indexabilityRows([page]);
  assert.equal(rows[0].reason, 'x-robots-tag');
});

// ---------------------------------------------------------------------------
// sitemapCoverageRows
// ---------------------------------------------------------------------------

test('sitemapCoverageRows: reports in_sitemap_not_crawled', () => {
  const page: Page = { ...HTML_PAGE, in_sitemap: 1, status: 'error' };
  const rows = sitemapCoverageRows([page]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 'in_sitemap_not_crawled');
});

test('sitemapCoverageRows: reports crawled_not_in_sitemap', () => {
  const page: Page = { ...HTML_PAGE, in_sitemap: 0, status: 'crawled' };
  const rows = sitemapCoverageRows([page]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 'crawled_not_in_sitemap');
});

test('sitemapCoverageRows: excludes pages that are in sitemap and crawled', () => {
  const rows = sitemapCoverageRows([HTML_PAGE]); // in_sitemap=1 and status=crawled
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// issuesSummaryRows
// ---------------------------------------------------------------------------

test('issuesSummaryRows: reports missing_title', () => {
  const page: Page = { ...HTML_PAGE, title: null, title_length: null };
  const rows = issuesSummaryRows([page]);
  assert.ok(rows.some((r) => r.issue === 'missing_title'));
});

test('issuesSummaryRows: reports title_too_long', () => {
  const page: Page = { ...HTML_PAGE, title: 'A'.repeat(65), title_length: 65 };
  const rows = issuesSummaryRows([page]);
  assert.ok(rows.some((r) => r.issue === 'title_too_long'));
});

test('issuesSummaryRows: reports missing_h1', () => {
  const page: Page = { ...HTML_PAGE, h1: null, h1_count: 0 };
  const rows = issuesSummaryRows([page]);
  assert.ok(rows.some((r) => r.issue === 'missing_h1'));
});

test('issuesSummaryRows: reports noindex', () => {
  const page: Page = { ...HTML_PAGE, is_indexable: 0, robots_directive: 'noindex' };
  const rows = issuesSummaryRows([page]);
  assert.ok(rows.some((r) => r.issue === 'noindex'));
});

test('issuesSummaryRows: reports redirect for 3xx pages', () => {
  const rows = issuesSummaryRows([REDIRECT_PAGE]);
  assert.ok(rows.some((r) => r.issue === 'redirect'));
});

test('issuesSummaryRows: reports broken for 4xx pages', () => {
  const rows = issuesSummaryRows([BROKEN_PAGE]);
  assert.ok(rows.some((r) => r.issue === 'broken'));
});

test('issuesSummaryRows: reports duplicate_title across pages', () => {
  const p1: Page = { ...HTML_PAGE, url: 'https://example.com/a' };
  const p2: Page = { ...HTML_PAGE, url: 'https://example.com/b' };
  const rows = issuesSummaryRows([p1, p2]);
  const dupes = rows.filter((r) => r.issue === 'duplicate_title');
  assert.equal(dupes.length, 2);
});

test('issuesSummaryRows: no issues for a clean page', () => {
  const clean: Page = {
    ...HTML_PAGE,
    title: 'A well-formed page title here ok',
    title_length: 33,
    meta_description: 'A description that is not too long and not too short for SEO purposes.',
    meta_desc_length: 71,
    h1_count: 1,
    is_indexable: 1,
    canonical_url: HTML_PAGE.url,
    images_missing_alt: 0,
    images_empty_alt: 0,
  };
  const rows = issuesSummaryRows([clean]);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// diffRows
// ---------------------------------------------------------------------------

test('diffRows: detects changed field values', () => {
  const a: Page[] = [{ ...HTML_PAGE, title: 'Old Title' }];
  const b: Page[] = [{ ...HTML_PAGE, title: 'New Title' }];
  const rows = diffRows(a, b);
  const titleChange = rows.find((r) => r.field === 'title');
  assert.ok(titleChange);
  assert.equal(titleChange.change_type, 'changed');
  assert.equal(titleChange.session_a_value, 'Old Title');
  assert.equal(titleChange.session_b_value, 'New Title');
});

test('diffRows: detects new pages', () => {
  const rows = diffRows([], [HTML_PAGE]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change_type, 'new_page');
  assert.equal(rows[0].url, HTML_PAGE.url);
});

test('diffRows: detects removed pages', () => {
  const rows = diffRows([HTML_PAGE], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change_type, 'removed_page');
});

test('diffRows: returns empty array when sessions are identical', () => {
  const rows = diffRows([HTML_PAGE], [HTML_PAGE]);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// generateReports integration test
// ---------------------------------------------------------------------------

const REPORT_HOSTNAME = '_test.report.local';
const REPORT_SITE = `https://${REPORT_HOSTNAME}`;
let reportDb: Db;
let reportSessionId: number;
let reportOutDir: string;

before(() => {
  reportDb = new Db(REPORT_HOSTNAME);
  reportSessionId = reportDb.createSession(REPORT_SITE, 'report-test');

  // Page 1: clean HTML page (crawled, in sitemap)
  reportDb.upsertPage(reportSessionId, { url: `${REPORT_SITE}/`, depth: 0, in_sitemap: 1 });
  reportDb.markPageCrawled(reportSessionId, `${REPORT_SITE}/`, {
    status_code: 200,
    redirect_url: null,
    content_type: 'text/html',
    title: 'A Well Formed Page Title Here',
    title_length: 29,
    meta_description: 'A good description',
    meta_desc_length: 18,
    h1: 'Welcome',
    h1_count: 1,
    h2_count: 2,
    canonical_url: `${REPORT_SITE}/`,
    robots_directive: null,
    x_robots_tag: null,
    is_indexable: 1,
    word_count: 100,
    internal_link_count: 2,
    external_link_count: 1,
    image_count: 1,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: 200,
    page_size_bytes: 2048,
  });

  // Page 2: HTML page with issues (no title, no h1, noindex, not in sitemap)
  reportDb.upsertPage(reportSessionId, { url: `${REPORT_SITE}/no-title`, depth: 1, in_sitemap: 0 });
  reportDb.markPageCrawled(reportSessionId, `${REPORT_SITE}/no-title`, {
    status_code: 200,
    redirect_url: null,
    content_type: 'text/html',
    title: null,
    title_length: null,
    meta_description: null,
    meta_desc_length: null,
    h1: null,
    h1_count: 0,
    h2_count: 0,
    canonical_url: null,
    robots_directive: 'noindex',
    x_robots_tag: null,
    is_indexable: 0,
    word_count: 0,
    internal_link_count: 0,
    external_link_count: 0,
    image_count: 0,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: 100,
    page_size_bytes: 512,
  });

  // Page 3: redirect
  reportDb.upsertPage(reportSessionId, { url: `${REPORT_SITE}/old`, depth: 1, in_sitemap: 1 });
  reportDb.markPageCrawled(reportSessionId, `${REPORT_SITE}/old`, {
    status_code: 301,
    redirect_url: `${REPORT_SITE}/`,
    content_type: null,
    title: null,
    title_length: null,
    meta_description: null,
    meta_desc_length: null,
    h1: null,
    h1_count: 0,
    h2_count: 0,
    canonical_url: null,
    robots_directive: null,
    x_robots_tag: null,
    is_indexable: 0,
    word_count: 0,
    internal_link_count: 0,
    external_link_count: 0,
    image_count: 0,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: 50,
    page_size_bytes: 0,
  });

  // Page 4: broken link
  reportDb.upsertPage(reportSessionId, { url: `${REPORT_SITE}/gone`, depth: 1 });
  reportDb.markPageError(reportSessionId, `${REPORT_SITE}/gone`, 404, 'HTTP 404');

  reportDb.insertImages(reportSessionId, [
    { page_url: `${REPORT_SITE}/`, src: `${REPORT_SITE}/img.jpg`, alt: 'Logo' },
  ]);

  reportDb.insertLinks(reportSessionId, [
    {
      source_url: `${REPORT_SITE}/`,
      target_url: `${REPORT_SITE}/about`,
      anchor_text: 'About',
      is_external: false,
    },
    {
      source_url: `${REPORT_SITE}/`,
      target_url: 'https://external.com',
      anchor_text: 'External',
      is_external: true,
    },
  ]);

  reportDb.updateSessionStatus(reportSessionId, 'complete');

  reportOutDir = path.join('audits', REPORT_HOSTNAME, 'reports', `session-${reportSessionId}`);
});

after(() => {
  reportDb.close();
  fs.rmSync(path.join('audits', REPORT_HOSTNAME), { recursive: true });
});

test('generateReports: creates all 11 CSV files', async () => {
  await generateReports(reportDb, reportSessionId, reportOutDir);

  const expected = [
    'all-pages.csv',
    'page-titles.csv',
    'meta-descriptions.csv',
    'h1-tags.csv',
    'canonicals.csv',
    'redirects.csv',
    'images.csv',
    'internal-links.csv',
    'indexability.csv',
    'sitemap-coverage.csv',
    'issues-summary.csv',
  ];
  for (const file of expected) {
    assert.ok(fs.existsSync(path.join(reportOutDir, file)), `missing: ${file}`);
  }
});

test('generateReports: all-pages.csv has correct headers and row count', async () => {
  const rows = await readCsv(path.join(reportOutDir, 'all-pages.csv'));
  assert.equal(rows.length, 4); // 2 html + redirect + broken
  assert.ok('url' in rows[0]);
  assert.ok('status' in rows[0]);
  assert.ok('status_code' in rows[0]);
  assert.ok('is_indexable' in rows[0]);
  assert.ok('depth' in rows[0]);
});

test('generateReports: issues-summary.csv captures expected issues', async () => {
  const rows = await readCsv(path.join(reportOutDir, 'issues-summary.csv'));
  const issues = rows.map((r) => r.issue);
  assert.ok(issues.includes('missing_title'), 'should flag missing_title');
  assert.ok(issues.includes('missing_h1'), 'should flag missing_h1');
  assert.ok(issues.includes('noindex'), 'should flag noindex');
  assert.ok(issues.includes('redirect'), 'should flag redirect');
  assert.ok(issues.includes('broken'), 'should flag broken');
});

test('generateReports: redirects.csv contains only 3xx pages', async () => {
  const rows = await readCsv(path.join(reportOutDir, 'redirects.csv'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status_code, '301');
});

test('generateReports: internal-links.csv excludes external links', async () => {
  const rows = await readCsv(path.join(reportOutDir, 'internal-links.csv'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anchor_text, 'About');
});

test('generateReports: sitemap-coverage.csv reports divergence', async () => {
  const rows = await readCsv(path.join(reportOutDir, 'sitemap-coverage.csv'));
  const issues = rows.map((r) => r.issue);
  // /old is in sitemap but status is 'crawled' (redirect, still crawled) — no discrepancy
  // /no-title is crawled but not in sitemap
  assert.ok(issues.includes('crawled_not_in_sitemap'));
});

// ---------------------------------------------------------------------------
// report() entry point
// ---------------------------------------------------------------------------

test('report(): throws when --site is not provided', async () => {
  await assert.rejects(
    () => report({ args: { site: null, session: null, compare: null, listSessions: false } }),
    /--site is required/
  );
});

test('report(): throws when site has no crawl sessions yet', async () => {
  const emptyHostname = '_test.report.empty.local';
  try {
    await assert.rejects(
      () =>
        report({
          args: {
            site: `https://${emptyHostname}`,
            session: null,
            compare: null,
            listSessions: false,
          },
        }),
      /No sessions found/
    );
  } finally {
    // Clean up the empty DB that report() creates just by opening the site
    fs.rmSync(path.join('audits', emptyHostname), { recursive: true, force: true });
  }
});
