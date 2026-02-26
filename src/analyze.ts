import { load } from 'cheerio';
import type { LinkData, ImageData } from './types';

/** All SEO fields extracted from a page, plus the raw links and images arrays. */
export interface AnalyzeResult {
  title: string | null;
  title_length: number | null;
  meta_description: string | null;
  meta_desc_length: number | null;
  robots_directive: string | null;
  x_robots_tag: string | null;
  is_indexable: 0 | 1;
  canonical_url: string | null;
  h1: string | null;
  h1_count: number;
  h2_count: number;
  has_schema: 0 | 1;
  word_count: number;
  internal_link_count: number;
  external_link_count: number;
  image_count: number;
  images_missing_alt: number;
  images_empty_alt: number;
  links: LinkData[];
  images: ImageData[];
}

/**
 * Extracts SEO-relevant data from a page's HTML and response headers.
 * Pure function — no I/O.
 * @param html - Raw HTML of the page.
 * @param headers - Response headers (lowercase keys, e.g. from axios).
 * @param url - Absolute URL of the page (used for link/image normalization).
 * @returns SEO data fields for the pages table, plus links[] and images[] arrays.
 */
export function analyze(
  html: string,
  headers: Record<string, string>,
  url: string
): AnalyzeResult {
  const $ = load(html);
  const pageHost = new URL(url).hostname;

  // Title
  const title = $('title').first().text().trim() || null;
  const title_length = title !== null ? title.length : null;

  // Meta description
  const metaDesc = $('meta[name="description"]').attr('content');
  const meta_description = metaDesc !== undefined ? metaDesc.trim() : null;
  const meta_desc_length = meta_description !== null ? meta_description.length : null;

  // Robots directives (meta robots + meta googlebot, joined if both present)
  const robotsValues = $('meta[name="robots"], meta[name="googlebot"]')
    .map((_, el) => $(el).attr('content'))
    .get()
    .filter(Boolean) as string[];
  const robots_directive = robotsValues.length > 0 ? robotsValues.join(', ') : null;

  // X-Robots-Tag header (axios lowercases header names)
  const x_robots_tag = headers['x-robots-tag'] || null;

  // Indexability — noindex in either meta robots or X-Robots-Tag
  const noindexPattern = /noindex/i;
  const is_indexable: 0 | 1 =
    noindexPattern.test(robots_directive || '') || noindexPattern.test(x_robots_tag || '')
      ? 0
      : 1;

  // Canonical
  const canonical_url = $('link[rel="canonical"]').attr('href') || null;

  // Headings
  const h1Els = $('h1');
  const h1 = h1Els.first().text().trim() || null;
  const h1_count = h1Els.length;
  const h2_count = $('h2').length;

  // Structured data
  const has_schema: 0 | 1 = $('script[type="application/ld+json"]').length > 0 ? 1 : 0;

  // Word count — strip scripts/styles/noscript, then count whitespace-separated tokens
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript').remove();
  const bodyText = bodyClone.text().replace(/\s+/g, ' ').trim();
  const word_count = bodyText ? bodyText.split(' ').filter(Boolean).length : 0;

  // Links
  const links: LinkData[] = [];
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href')?.trim();
    // Skip protocol-less links and any fragment-only href (bare # or #section-id).
    // Note: sites using <base href> will have relative URLs misresolved here — TODO if needed.
    if (!raw || /^(mailto:|tel:|javascript:|#)/.test(raw)) return;

    let targetUrl: string;
    try {
      const parsed = new URL(raw, url);
      parsed.hash = '';
      targetUrl = parsed.href;
    } catch {
      return;
    }

    const is_external = new URL(targetUrl).hostname !== pageHost;
    const anchor_text = $(el).text().trim() || null;
    links.push({ source_url: url, target_url: targetUrl, anchor_text, is_external });
  });

  const internal_link_count = links.filter((l) => !l.is_external).length;
  const external_link_count = links.filter((l) => l.is_external).length;

  // Images — alt=null means attribute absent, alt='' means present but empty; both are flagged
  const images: ImageData[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src')?.trim();
    if (!src) return;

    let absoluteSrc: string;
    try {
      absoluteSrc = new URL(src, url).href;
    } catch {
      return;
    }

    const altAttr = $(el).attr('alt');
    const alt = altAttr !== undefined ? altAttr : null;
    images.push({ page_url: url, src: absoluteSrc, alt });
  });

  const image_count = images.length;
  // images_missing_alt: alt attribute absent entirely (SEO/a11y issue)
  // images_empty_alt:   alt="" explicitly set (typically decorative — less critical)
  const images_missing_alt = images.filter((img) => img.alt === null).length;
  const images_empty_alt = images.filter((img) => img.alt === '').length;

  return {
    title,
    title_length,
    meta_description,
    meta_desc_length,
    robots_directive,
    x_robots_tag,
    is_indexable,
    canonical_url,
    h1,
    h1_count,
    h2_count,
    has_schema,
    word_count,
    internal_link_count,
    external_link_count,
    image_count,
    images_missing_alt,
    images_empty_alt,
    links,
    images,
  };
}
