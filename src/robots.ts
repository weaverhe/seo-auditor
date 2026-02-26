import axios from 'axios';
import robotsParser from 'robots-parser';
import type { Config, RobotsData } from './types';

const DEFAULTS = {
  userAgent: 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)',
  requestTimeoutMs: 15000,
};

/**
 * Fetches and parses robots.txt for a given site.
 * On any fetch failure, returns a permissive object (no restrictions).
 * @param siteUrl - Root URL, e.g. 'https://example.com'
 * @param config - Optional config subset; falls back to built-in defaults.
 * @returns Parsed robots.txt rules for the site.
 */
async function fetchRobots(siteUrl: string, config: Partial<Config> = {}): Promise<RobotsData> {
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
      isAllowed(url: string) {
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

export default { fetchRobots };
