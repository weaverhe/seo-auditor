'use strict';

const axios = require('axios');
const { analyze } = require('./analyze');
const robots = require('./robots');
const sitemap = require('./sitemap');
const Db = require('./db');
const { loadConfig } = require('./config');

/**
 * Returns a baseline page data object for pages that can't be parsed as HTML.
 * Pass overrides for fields specific to the response type.
 * @param {Object} overrides
 */
function emptyPage(overrides = {}) {
  return {
    redirect_url: null,
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
    is_indexable: null,
    word_count: 0,
    internal_link_count: 0,
    external_link_count: 0,
    image_count: 0,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: null,
    page_size_bytes: null,
    ...overrides,
  };
}

/**
 * Parses crawler flags from an args array (pass process.argv.slice(2)).
 * @param {string[]} args
 * @returns {{ site: string|null, label: string|null, resume: boolean }}
 */
function parseArgs(args) {
  const result = { site: null, label: null, resume: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site') result.site = args[++i];
    else if (args[i] === '--label') result.label = args[++i];
    else if (args[i] === '--resume') result.resume = true;
  }
  return result;
}

/**
 * Fetches a single URL without following redirects.
 * Returns a normalized result regardless of outcome — never throws.
 * @param {string} url
 * @param {{ requestTimeoutMs: number, userAgent: string }} config
 * @returns {Promise<{ status: number|null, headers: Object, data: string|null, redirectUrl: string|null, responseTimeMs: number, error: string|null }>}
 */
async function fetchPage(url, config) {
  const start = Date.now();
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: null,
      timeout: config.requestTimeoutMs,
      headers: { 'User-Agent': config.userAgent },
      responseType: 'text',
    });
    return {
      status: response.status,
      headers: response.headers,
      data: response.data,
      redirectUrl: null,
      responseTimeMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    // axios throws MaxRedirectsError when server sends a redirect and maxRedirects: 0
    if (err.response && err.response.status >= 300 && err.response.status < 400) {
      return {
        status: err.response.status,
        headers: err.response.headers,
        data: null,
        redirectUrl: err.response.headers['location'] || null,
        responseTimeMs,
        error: null,
      };
    }
    return {
      status: null,
      headers: {},
      data: null,
      redirectUrl: null,
      responseTimeMs,
      error: err.message,
    };
  }
}

/**
 * Starts a new crawl session: creates DB record, fetches robots.txt and sitemap,
 * seeds the queue with sitemap URLs and the site root.
 * @param {Db} db
 * @param {string} siteUrl
 * @param {string|null} label
 * @param {Object} config
 * @returns {Promise<{ sessionId: number, robotsData: Object, seen: Set, queue: Array }>}
 */
async function initSession(db, siteUrl, label, config) {
  const sessionId = db.createSession(siteUrl, label || null);
  console.log(`Starting session ${sessionId} for ${new URL(siteUrl).hostname}...`);

  console.log('Fetching robots.txt...');
  const robotsData = await robots.fetchRobots(siteUrl, config);

  console.log('Fetching sitemap...');
  const sitemapUrls = await sitemap.getUrls(siteUrl, robotsData.getSitemapUrls(), config);
  console.log(`Found ${sitemapUrls.length} URL(s) in sitemap`);

  const seen = new Set();
  const queue = [];

  for (const url of sitemapUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      db.upsertPage(sessionId, { url, depth: 0, in_sitemap: 1 });
      queue.push({ url, depth: 0 });
    }
  }

  // Seed the site root. If --site points to a subdirectory (e.g. /blog/),
  // this seeds that path as the starting point, not the domain root.
  const siteRoot = siteUrl + '/';
  if (!seen.has(siteRoot)) {
    seen.add(siteRoot);
    db.upsertPage(sessionId, { url: siteRoot, depth: 0 });
    queue.push({ url: siteRoot, depth: 0 });
  }

  return { sessionId, robotsData, seen, queue };
}

/**
 * Resumes an interrupted session: reloads pending URLs into the queue and
 * seeds `seen` from all page URLs and link targets discovered before interruption.
 * @param {Db} db
 * @param {Object} config
 * @returns {Promise<{ sessionId: number, robotsData: Object, seen: Set, queue: Array }>}
 */
async function resumeSession(db, config) {
  const interrupted = db.getLatestInterruptedSession();
  if (!interrupted) throw new Error('No interrupted session found');

  const { id: sessionId, site_url: siteUrl, label } = interrupted;
  console.log(`Resuming session ${sessionId} (${label || 'unlabeled'})...`);

  console.log('Fetching robots.txt...');
  const robotsData = await robots.fetchRobots(siteUrl, config);

  // Seed seen from all known page URLs and all link targets discovered before
  // interruption, so we don't re-queue URLs that were already found.
  const seen = new Set();
  db.getAllPageUrls(sessionId).forEach((url) => seen.add(url));
  db.getLinkTargetUrls(sessionId).forEach((url) => seen.add(url));

  const queue = db.getPendingUrls(sessionId);
  db.updateSessionStatus(sessionId, 'running');

  return { sessionId, robotsData, seen, queue };
}

/**
 * Fetches, analyzes, and persists a single URL.
 * Returns new internal URLs to enqueue, or null.
 * @param {string} url
 * @param {number} depth
 * @param {{ db: Db, sessionId: number, robotsData: Object, config: Object }} ctx
 * @returns {Promise<Array<{ url: string, depth: number }>|null>}
 */
async function processUrl(url, depth, ctx) {
  const { db, sessionId, robotsData, config } = ctx;

  if (!robotsData.isAllowed(url)) {
    db.markPageSkipped(sessionId, url, 'disallowed by robots.txt');
    console.log(`  SKIP ${url}`);
    return null;
  }

  const { status, headers, data, redirectUrl, responseTimeMs, error } = await fetchPage(url, config);

  if (error) {
    db.markPageError(sessionId, url, null, error);
    console.log(`  ERR  ${url} — ${error}`);
    return null;
  }

  if (status >= 300 && status < 400) {
    const resolvedRedirect = redirectUrl ? new URL(redirectUrl, url).href : null;
    db.markPageCrawled(sessionId, url, emptyPage({
      status_code: status,
      redirect_url: resolvedRedirect,
      is_indexable: 0,
      response_time_ms: responseTimeMs,
    }));
    console.log(`  ${status}  ${url} → ${resolvedRedirect || '(unknown)'}`);
    return resolvedRedirect ? [{ url: resolvedRedirect, depth }] : null;
  }

  if (status >= 400) {
    db.markPageError(sessionId, url, status, `HTTP ${status}`);
    console.log(`  ${status} ${url}`);
    return null;
  }

  const contentType = headers['content-type'] || null;
  const isHtml = contentType && contentType.includes('text/html');
  const pageSizeBytes = data ? Buffer.byteLength(data, 'utf8') : null;

  if (!isHtml || !data) {
    // is_indexable is null for non-HTML — indexability is not meaningful for PDFs, images, etc.
    db.markPageCrawled(sessionId, url, emptyPage({
      status_code: status,
      content_type: contentType,
      response_time_ms: responseTimeMs,
      page_size_bytes: pageSizeBytes,
    }));
    console.log(`  ${status}  ${url} (${contentType || 'unknown type'})`);
    return null;
  }

  const { links, images, ...seoFields } = analyze(data, headers, url);

  db.persistPageResult(sessionId, url, emptyPage({
    status_code: status,
    redirect_url: null,
    content_type: contentType,
    response_time_ms: responseTimeMs,
    page_size_bytes: pageSizeBytes,
    ...seoFields,
  }), links, images);

  console.log(`  ${status}  ${url} — "${seoFields.title || '(no title)'}"`);

  return links
    .filter((l) => !l.is_external)
    .map((l) => ({ url: l.target_url, depth: depth + 1 }));
}

/**
 * Runs the concurrent worker pool until the queue drains or shutdown is signalled.
 * Keeps up to ctx.config.concurrency fetches in flight at all times.
 * @param {Array} queue
 * @param {Set} seen
 * @param {{ db: Db, sessionId: number, robotsData: Object, crawlDelay: number|null, config: Object }} ctx
 * @param {{ shuttingDown: boolean }} state
 */
async function runWorkerPool(queue, seen, ctx, state) {
  const { db, sessionId, crawlDelay, config } = ctx;

  await new Promise((poolResolve) => {
    let activeWorkers = 0;
    let resolved = false;

    function resolve() {
      if (!resolved) {
        resolved = true;
        poolResolve();
      }
    }

    function startNext() {
      while (activeWorkers < config.concurrency && queue.length > 0 && !state.shuttingDown) {
        const { url, depth } = queue.shift();
        activeWorkers++;

        processUrl(url, depth, ctx)
          .then((newUrls) => {
            if (newUrls) {
              for (const { url: u, depth: d } of newUrls) {
                if (!seen.has(u)) {
                  seen.add(u);
                  db.upsertPage(sessionId, { url: u, depth: d });
                  queue.push({ url: u, depth: d });
                }
              }
            }
          })
          .catch((err) => console.error('Worker error:', err))
          .finally(() => {
            activeWorkers--;
            // Each worker waits crawlDelay seconds after completing a fetch before
            // starting the next one, so the delay applies per-worker, not globally.
            if (crawlDelay && !state.shuttingDown) {
              setTimeout(startNext, crawlDelay * 1000);
            } else {
              startNext();
            }
            if (activeWorkers === 0 && queue.length === 0) resolve();
          });
      }

      if (activeWorkers === 0 && queue.length === 0) resolve();
    }

    startNext();
  });
}

/**
 * Main crawl entry point.
 * Throws on invalid arguments rather than calling process.exit().
 * @param {{ args?: Object, config?: Object }} [opts]
 */
async function crawl(opts = {}) {
  const args = opts.args || parseArgs(process.argv.slice(2));
  const config = opts.config || loadConfig();

  if (!args.site) {
    throw new Error('--site is required. Usage: crawl --site <url> [--label <label>] [--resume]');
  }

  const siteUrl = args.site.replace(/\/$/, '');
  const hostname = new URL(siteUrl).hostname;
  const db = new Db(hostname);

  let sessionId, robotsData, seen, queue;
  try {
    if (args.resume) {
      ({ sessionId, robotsData, seen, queue } = await resumeSession(db, config));
    } else {
      ({ sessionId, robotsData, seen, queue } = await initSession(db, siteUrl, args.label, config));
    }
  } catch (err) {
    db.close();
    throw err;
  }

  const crawlDelay = config.respectCrawlDelay ? robotsData.getCrawlDelay() : null;
  const ctx = { db, sessionId, robotsData, crawlDelay, config };
  const state = { shuttingDown: false };

  const sigintHandler = () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    console.log('\nInterrupted — saving progress...');
    try {
      db.updateSessionStatus(sessionId, 'interrupted');
      db.close();
    } catch { /* best-effort shutdown */ }
    process.exit(130); // 128 + SIGINT(2) — conventional exit code for interrupted processes
  };
  process.on('SIGINT', sigintHandler);

  console.log(
    `Queue: ${queue.length} URL(s) | Concurrency: ${config.concurrency}${crawlDelay ? ` | Crawl delay: ${crawlDelay}s` : ''}\n`
  );

  await runWorkerPool(queue, seen, ctx, state);

  if (!state.shuttingDown) {
    db.updateSessionStatus(sessionId, 'complete');
    const session = db.getSession(sessionId);
    console.log(`\nDone — session ${sessionId} | ${session?.total_pages ?? 0} pages crawled`);
  }

  process.off('SIGINT', sigintHandler);
  db.close();
}

module.exports = { parseArgs, loadConfig, fetchPage, processUrl, initSession, resumeSession, runWorkerPool, crawl };

if (require.main === module) {
  require('dotenv').config();
  crawl().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
