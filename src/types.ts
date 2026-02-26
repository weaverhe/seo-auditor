/** Crawler runtime configuration, populated from environment variables by loadConfig(). */
export interface Config {
  concurrency: number;
  requestTimeoutMs: number;
  userAgent: string;
  respectCrawlDelay: boolean;
  maxRetries: number;
  retryBaseDelayMs: number;
}

/**
 * All SEO data fields written to the pages table for a single crawled URL.
 * Mirrors the non-primary-key columns of the pages table in schema.sql.
 * `emptyPage()` in crawler.ts is the authoritative default for these fields.
 */
export interface PageData {
  status_code: number | null;
  redirect_url: string | null;
  content_type: string | null;
  title: string | null;
  title_length: number | null;
  meta_description: string | null;
  meta_desc_length: number | null;
  h1: string | null;
  h1_count: number;
  h2_count: number;
  canonical_url: string | null;
  robots_directive: string | null;
  x_robots_tag: string | null;
  is_indexable: 0 | 1 | null;
  word_count: number;
  internal_link_count: number;
  external_link_count: number;
  image_count: number;
  images_missing_alt: number;
  images_empty_alt: number;
  has_schema: 0 | 1;
  response_time_ms: number | null;
  page_size_bytes: number | null;
}

/** A hyperlink discovered on a crawled page. */
export interface LinkData {
  source_url: string;
  target_url: string;
  anchor_text: string | null;
  is_external: boolean;
}

/** An image discovered on a crawled page. */
export interface ImageData {
  page_url: string;
  src: string;
  /** null means alt attribute was absent entirely; '' means alt="" was set explicitly. */
  alt: string | null;
}

/** Parsed robots.txt rules for a site. Returned by fetchRobots(). */
export interface RobotsData {
  isAllowed: (url: string) => boolean;
  getCrawlDelay: () => number | null;
  getSitemapUrls: () => string[];
}

/** A row from the sessions table. */
export interface Session {
  id: number;
  site_url: string;
  label: string | null;
  status: 'running' | 'complete' | 'interrupted';
  started_at: string;
  completed_at: string | null;
  total_pages: number | null;
}

/** A row from the pages table. */
export interface Page extends PageData {
  id: number;
  session_id: number;
  url: string;
  status: string;
  depth: number;
  in_sitemap: number;
  crawled_at: string | null;
  error_message: string | null;
}

/** A row from the images table. */
export interface DbImage {
  id: number;
  session_id: number;
  page_url: string;
  src: string;
  alt: string | null;
}

/** A row from the links table. */
export interface DbLink {
  id: number;
  session_id: number;
  source_url: string;
  target_url: string;
  anchor_text: string | null;
  is_external: number;
}
