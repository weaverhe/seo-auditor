'use strict';

/**
 * Reads crawler configuration from process.env.
 * Call this inside your entry function (not at module load time) so tests can
 * control env before invoking.
 * @returns {{ concurrency: number, requestTimeoutMs: number, userAgent: string, respectCrawlDelay: boolean }}
 */
function loadConfig() {
  return {
    concurrency: parseInt(process.env.CONCURRENCY || '5', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)',
    respectCrawlDelay: process.env.RESPECT_CRAWL_DELAY !== 'false',
  };
}

module.exports = { loadConfig };
