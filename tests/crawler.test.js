'use strict';

const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Db = require('../src/db');
const { parseArgs, loadConfig, fetchPage, processUrl, crawl } = require('../src/crawler');
const robots = require('../src/robots');
const sitemap = require('../src/sitemap');

const TEST_CONFIG = {
  concurrency: 2,
  requestTimeoutMs: 5000,
  userAgent: 'test-bot',
  respectCrawlDelay: false,
};

// --- parseArgs ---

test('parseArgs: parses --site', () => {
  const args = parseArgs(['--site', 'https://example.com']);
  assert.equal(args.site, 'https://example.com');
  assert.equal(args.label, null);
  assert.equal(args.resume, false);
});

test('parseArgs: parses --site and --label', () => {
  const args = parseArgs(['--site', 'https://example.com', '--label', 'baseline']);
  assert.equal(args.site, 'https://example.com');
  assert.equal(args.label, 'baseline');
});

test('parseArgs: parses --resume', () => {
  const args = parseArgs(['--site', 'https://example.com', '--resume']);
  assert.equal(args.resume, true);
});

test('parseArgs: returns null site when --site not provided', () => {
  const args = parseArgs([]);
  assert.equal(args.site, null);
});

// --- loadConfig ---

test('loadConfig: returns defaults when env vars are not set', () => {
  const config = loadConfig();
  assert.equal(typeof config.concurrency, 'number');
  assert.equal(typeof config.requestTimeoutMs, 'number');
  assert.equal(typeof config.userAgent, 'string');
  assert.equal(typeof config.respectCrawlDelay, 'boolean');
});

// --- fetchPage ---

afterEach(() => mock.restoreAll());

test('fetchPage: returns status and data on 200', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    data: '<html></html>',
  }));
  const result = await fetchPage('https://example.com/', TEST_CONFIG);
  assert.equal(result.status, 200);
  assert.equal(result.data, '<html></html>');
  assert.equal(result.error, null);
  assert.equal(result.redirectUrl, null);
});

test('fetchPage: returns redirect url on 301', async () => {
  mock.method(axios, 'get', async () => {
    const err = new Error('redirect');
    err.response = { status: 301, headers: { location: 'https://example.com/new' } };
    throw err;
  });
  const result = await fetchPage('https://example.com/old', TEST_CONFIG);
  assert.equal(result.status, 301);
  assert.equal(result.redirectUrl, 'https://example.com/new');
  assert.equal(result.error, null);
});

test('fetchPage: returns error message on network failure', async () => {
  mock.method(axios, 'get', async () => { throw new Error('ECONNREFUSED'); });
  const result = await fetchPage('https://example.com/', TEST_CONFIG);
  assert.equal(result.status, null);
  assert.equal(result.error, 'ECONNREFUSED');
});

// --- processUrl (integration with real DB) ---

const HOSTNAME = '_test.crawler.local';
const SITE_URL = 'https://_test.crawler.local';
let db;
let sessionId;

const permissiveRobots = {
  isAllowed: () => true,
  getCrawlDelay: () => null,
  getSitemapUrls: () => [],
};

before(() => {
  db = new Db(HOSTNAME);
  sessionId = db.createSession(SITE_URL, 'test');
  db.upsertPage(sessionId, { url: `${SITE_URL}/`, depth: 0 });
  db.upsertPage(sessionId, { url: `${SITE_URL}/about`, depth: 1 });
  db.upsertPage(sessionId, { url: `${SITE_URL}/old`, depth: 1 });
  db.upsertPage(sessionId, { url: `${SITE_URL}/broken`, depth: 1 });
  db.upsertPage(sessionId, { url: `${SITE_URL}/disallowed`, depth: 1 });
});

after(() => {
  db.close();
  fs.rmSync(path.join('audits', HOSTNAME), { recursive: true });
});

function makeCtx(overrides = {}) {
  return { db, sessionId, robotsData: permissiveRobots, crawlDelay: null, config: TEST_CONFIG, ...overrides };
}

test('processUrl: crawls HTML page and discovers internal links', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    data: `<html><head><title>Home</title></head><body>
      <a href="/about">About</a>
      <a href="https://other.com">External</a>
    </body></html>`,
  }));

  const newUrls = await processUrl(`${SITE_URL}/`, 0, makeCtx());
  const row = db.db
    .prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, `${SITE_URL}/`);

  assert.equal(row.status, 'crawled');
  assert.equal(row.title, 'Home');
  assert.equal(row.status_code, 200);
  assert.equal(row.internal_link_count, 1);
  assert.equal(row.external_link_count, 1);
  assert.ok(Array.isArray(newUrls));
  assert.equal(newUrls.length, 1);
  assert.equal(newUrls[0].url, `${SITE_URL}/about`);
  assert.equal(newUrls[0].depth, 1);
});

test('processUrl: records redirect and returns destination url', async () => {
  mock.method(axios, 'get', async () => {
    const err = new Error('redirect');
    err.response = { status: 301, headers: { location: `${SITE_URL}/new` } };
    throw err;
  });

  const newUrls = await processUrl(`${SITE_URL}/old`, 1, makeCtx());
  const row = db.db
    .prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, `${SITE_URL}/old`);

  assert.equal(row.status, 'crawled');
  assert.equal(row.status_code, 301);
  assert.equal(row.redirect_url, `${SITE_URL}/new`);
  assert.ok(Array.isArray(newUrls));
  assert.equal(newUrls[0].url, `${SITE_URL}/new`);
});

test('processUrl: records error on 404', async () => {
  mock.method(axios, 'get', async () => ({
    status: 404,
    headers: {},
    data: 'Not found',
  }));

  const newUrls = await processUrl(`${SITE_URL}/broken`, 1, makeCtx());
  const row = db.db
    .prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, `${SITE_URL}/broken`);

  assert.equal(row.status, 'error');
  assert.equal(row.status_code, 404);
  assert.equal(newUrls, null);
});

test('processUrl: skips url disallowed by robots.txt', async () => {
  const blockingRobots = { ...permissiveRobots, isAllowed: () => false };
  const newUrls = await processUrl(`${SITE_URL}/disallowed`, 1, makeCtx({ robotsData: blockingRobots }));
  const row = db.db
    .prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, `${SITE_URL}/disallowed`);

  assert.equal(row.status, 'skipped');
  assert.equal(newUrls, null);
});

test('processUrl: sets is_indexable to null for non-HTML responses', async () => {
  db.upsertPage(sessionId, { url: `${SITE_URL}/file.pdf`, depth: 1 });
  mock.method(axios, 'get', async () => ({
    status: 200,
    headers: { 'content-type': 'application/pdf' },
    data: '%PDF...',
  }));

  await processUrl(`${SITE_URL}/file.pdf`, 1, makeCtx());
  const row = db.db
    .prepare('SELECT is_indexable FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, `${SITE_URL}/file.pdf`);

  assert.equal(row.is_indexable, null);
});

// --- crawl() pool integration ---

function crawlHostname(label) { return `_test.pool.${label}.local`; }
function crawlSiteUrl(label) { return `https://${crawlHostname(label)}`; }
function openResultDb(label) { return new Db(crawlHostname(label)); }
function cleanupCrawlDb(label) {
  try { fs.rmSync(path.join('audits', crawlHostname(label)), { recursive: true }); } catch {}
}

function mockDeps(pages = {}) {
  mock.method(robots, 'fetchRobots', async () => ({
    isAllowed: () => true,
    getCrawlDelay: () => null,
    getSitemapUrls: () => [],
  }));
  mock.method(sitemap, 'getUrls', async () => []);
  mock.method(axios, 'get', async (url) => {
    const page = pages[url];
    if (!page) return { status: 404, headers: {}, data: 'Not found' };
    return { status: 200, headers: { 'content-type': 'text/html' }, data: page };
  });
}

test('crawl(): crawls all sitemap URLs and homepage', async () => {
  const site = crawlSiteUrl('sitemap');
  mock.method(robots, 'fetchRobots', async () => ({
    isAllowed: () => true,
    getCrawlDelay: () => null,
    getSitemapUrls: () => [],
  }));
  mock.method(sitemap, 'getUrls', async () => [`${site}/page1`, `${site}/page2`]);
  mock.method(axios, 'get', async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    data: '<html><head><title>T</title></head><body></body></html>',
  }));

  await crawl({ args: { site, label: 'test', resume: false }, config: TEST_CONFIG });

  const resultDb = openResultDb('sitemap');
  const crawled = resultDb.db
    .prepare("SELECT url FROM pages WHERE status = 'crawled' ORDER BY url")
    .all().map((r) => r.url);
  resultDb.close();
  cleanupCrawlDb('sitemap');

  assert.equal(crawled.length, 3);
  assert.ok(crawled.includes(`${site}/`));
  assert.ok(crawled.includes(`${site}/page1`));
  assert.ok(crawled.includes(`${site}/page2`));
});

test('crawl(): discovers and crawls linked pages', async () => {
  const site = crawlSiteUrl('links');
  mockDeps({
    [`${site}/`]: `<html><head><title>Home</title></head><body><a href="/about">About</a></body></html>`,
    [`${site}/about`]: `<html><head><title>About</title></head><body><a href="/team">Team</a></body></html>`,
    [`${site}/team`]: `<html><head><title>Team</title></head><body></body></html>`,
  });

  await crawl({ args: { site, label: 'test', resume: false }, config: TEST_CONFIG });

  const resultDb = openResultDb('links');
  const crawled = resultDb.db
    .prepare("SELECT url FROM pages WHERE status = 'crawled' ORDER BY url")
    .all().map((r) => r.url);
  resultDb.close();
  cleanupCrawlDb('links');

  assert.ok(crawled.includes(`${site}/`));
  assert.ok(crawled.includes(`${site}/about`));
  assert.ok(crawled.includes(`${site}/team`));
});

test('crawl(): does not crawl the same URL twice even when linked from multiple pages', async () => {
  const site = crawlSiteUrl('dedup');
  mockDeps({
    [`${site}/`]: `<html><head><title>Home</title></head><body>
      <a href="/shared">Shared</a><a href="/page2">Page2</a>
    </body></html>`,
    [`${site}/page2`]: `<html><head><title>P2</title></head><body><a href="/shared">Shared again</a></body></html>`,
    [`${site}/shared`]: `<html><head><title>Shared</title></head><body></body></html>`,
  });

  await crawl({ args: { site, label: 'test', resume: false }, config: TEST_CONFIG });

  const resultDb = openResultDb('dedup');
  const sharedRows = resultDb.db
    .prepare("SELECT url FROM pages WHERE url LIKE '%/shared'").all();
  resultDb.close();
  cleanupCrawlDb('dedup');

  assert.equal(sharedRows.length, 1);
});

test('crawl(): resumes interrupted session and crawls remaining pending pages', async () => {
  const site = crawlSiteUrl('resume');
  const hostname = crawlHostname('resume');

  const setupDb = new Db(hostname);
  const sid = setupDb.createSession(site, 'interrupted-test');
  setupDb.upsertPage(sid, { url: `${site}/done`, depth: 0 });
  setupDb.markPageCrawled(sid, `${site}/done`, {
    status_code: 200, redirect_url: null, content_type: 'text/html',
    title: 'Done', title_length: 4, meta_description: null, meta_desc_length: null,
    h1: null, h1_count: 0, h2_count: 0, canonical_url: null, robots_directive: null,
    x_robots_tag: null, is_indexable: 1, word_count: 1, internal_link_count: 0,
    external_link_count: 0, image_count: 0, images_missing_alt: 0, images_empty_alt: 0, has_schema: 0,
    response_time_ms: 100, page_size_bytes: 100,
  });
  setupDb.upsertPage(sid, { url: `${site}/pending`, depth: 0 });
  setupDb.updateSessionStatus(sid, 'interrupted');
  setupDb.close();

  mock.method(robots, 'fetchRobots', async () => ({
    isAllowed: () => true,
    getCrawlDelay: () => null,
    getSitemapUrls: () => [],
  }));
  mock.method(axios, 'get', async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    data: '<html><head><title>Pending</title></head><body></body></html>',
  }));

  await crawl({ args: { site, label: null, resume: true }, config: TEST_CONFIG });

  const resultDb = openResultDb('resume');
  const pages = resultDb.db
    .prepare('SELECT url, status FROM pages WHERE session_id = ?').all(sid);
  resultDb.close();
  cleanupCrawlDb('resume');

  assert.equal(pages.find((p) => p.url === `${site}/done`).status, 'crawled');
  assert.equal(pages.find((p) => p.url === `${site}/pending`).status, 'crawled');
});

test('crawl(): throws when --site is not provided', async () => {
  await assert.rejects(
    () => crawl({ args: { site: null, label: null, resume: false }, config: TEST_CONFIG }),
    /--site is required/
  );
});
