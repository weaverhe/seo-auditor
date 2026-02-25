'use strict';

const Sitemapper = require('sitemapper').default;

const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Fetches all URLs from a site's sitemap(s).
 * Uses sitemap URLs from robots.txt if provided, otherwise tries /sitemap.xml.
 * Handles sitemap index files (nested sitemaps) automatically.
 * Returns an empty array if no sitemap is found or all fetches fail.
 * @param {string} siteUrl - Root URL, e.g. 'https://example.com'
 * @param {string[]} [robotsSitemapUrls] - Sitemap URLs discovered from robots.txt
 * @returns {Promise<string[]>}
 */
async function getUrls(siteUrl, robotsSitemapUrls = []) {
  const sitemapper = new Sitemapper({ timeout: REQUEST_TIMEOUT_MS });

  const candidates =
    robotsSitemapUrls.length > 0 ? robotsSitemapUrls : [new URL('/sitemap.xml', siteUrl).href];

  const allUrls = new Set();

  for (const url of candidates) {
    try {
      const { sites } = await sitemapper.fetch(url);
      for (const site of sites) allUrls.add(site);
    } catch {
      // individual sitemap fetch failure — continue with others
    }
  }

  return [...allUrls];
}

module.exports = { getUrls };
