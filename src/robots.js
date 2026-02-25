'use strict';

const axios = require('axios');
const robotsParser = require('robots-parser');

const DEFAULTS = {
  userAgent: 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)',
  requestTimeoutMs: 15000,
};

/**
 * Fetches and parses robots.txt for a given site.
 * On any fetch failure, returns a permissive object (no restrictions).
 * @param {string} siteUrl - Root URL, e.g. 'https://example.com'
 * @param {{ userAgent?: string, requestTimeoutMs?: number }} [config]
 * @returns {Promise<{ isAllowed: (url: string) => boolean, getCrawlDelay: () => number|null, getSitemapUrls: () => string[] }>}
 */
async function fetchRobots(siteUrl, config = {}) {
  const userAgent = config.userAgent || DEFAULTS.userAgent;
  const timeout = config.requestTimeoutMs || DEFAULTS.requestTimeoutMs;
  const robotsUrl = new URL('/robots.txt', siteUrl).href;

  try {
    const response = await axios.get(robotsUrl, {
      timeout,
      headers: { 'User-Agent': userAgent },
      validateStatus: null,
    });

    const content =
      response.status === 200 && typeof response.data === 'string' ? response.data : '';
    const robots = robotsParser(robotsUrl, content);

    return {
      isAllowed(url) {
        // robots-parser returns undefined for paths not covered by any rule; treat as allowed
        return robots.isAllowed(url, userAgent) !== false;
      },
      getCrawlDelay() {
        return robots.getCrawlDelay(userAgent) ?? null;
      },
      getSitemapUrls() {
        return robots.getSitemaps() ?? [];
      },
    };
  } catch {
    return {
      isAllowed: () => true,
      getCrawlDelay: () => null,
      getSitemapUrls: () => [],
    };
  }
}

module.exports = { fetchRobots };
