import Sitemapper from 'sitemapper';
import type { Config } from './types';

/**
 * Fetches all URLs from a site's sitemap(s).
 * Uses sitemap URLs from robots.txt if provided, otherwise tries /sitemap.xml.
 * Handles sitemap index files (nested sitemaps) automatically.
 * Returns an empty array if no sitemap is found or all fetches fail.
 * @param siteUrl - Root URL, e.g. 'https://example.com'
 * @param robotsSitemapUrls - Sitemap URLs discovered from robots.txt.
 * @param config - Optional config subset for timeout.
 * @returns Deduplicated list of page URLs found across all sitemaps.
 */
async function getUrls(
  siteUrl: string,
  robotsSitemapUrls: string[] = [],
  config: Partial<Config> = {}
): Promise<string[]> {
  const timeout = config.requestTimeoutMs || 15000;
  const sitemapper = new Sitemapper({ timeout });

  const candidates =
    robotsSitemapUrls.length > 0 ? robotsSitemapUrls : [new URL('/sitemap.xml', siteUrl).href];

  const allUrls = new Set<string>();

  for (const url of candidates) {
    try {
      const { sites } = await sitemapper.fetch(url);
      for (const site of sites) allUrls.add(site);
    } catch (err) {
      console.warn(`Sitemap fetch failed for ${url}: ${(err as Error).message}`);
    }
  }

  return [...allUrls];
}

export default { getUrls };
