'use strict';

const axios = require('axios');
const robotsParser = require('robots-parser');

const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Fetches and parses robots.txt for a given site.
 * On any fetch failure, returns a permissive object (no restrictions).
 * @param {string} siteUrl - Root URL, e.g. 'https://example.com'
 * @returns {Promise<{ isAllowed: (url: string) => boolean, getCrawlDelay: () => number|null, getSitemapUrls: () => string[] }>}
 */
async function fetch(siteUrl) {
  const robotsUrl = new URL('/robots.txt', siteUrl).href;

  try {
    const response = await axios.get(robotsUrl, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: null,
    });

    const content =
      response.status === 200 && typeof response.data === 'string' ? response.data : '';
    const robots = robotsParser(robotsUrl, content);

    return {
      isAllowed(url) {
        return robots.isAllowed(url, USER_AGENT) !== false;
      },
      getCrawlDelay() {
        return robots.getCrawlDelay(USER_AGENT) ?? null;
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

module.exports = { fetch };
