'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/analyze');

const BASE_URL = 'https://example.com/page';

function make(bodyHtml, headHtml = '', headers = {}) {
  return `<html><head>${headHtml}</head><body>${bodyHtml}</body></html>`;
}

// --- Title ---

test('extracts title text and length', () => {
  const result = analyze(make('', '<title>Hello World</title>'), {}, BASE_URL);
  assert.equal(result.title, 'Hello World');
  assert.equal(result.title_length, 11);
});

test('title is null when absent', () => {
  const result = analyze(make(''), {}, BASE_URL);
  assert.equal(result.title, null);
  assert.equal(result.title_length, null);
});

// --- Meta description ---

test('extracts meta description and length', () => {
  const result = analyze(make('', '<meta name="description" content="A great page">'), {}, BASE_URL);
  assert.equal(result.meta_description, 'A great page');
  assert.equal(result.meta_desc_length, 12);
});

test('meta_description is null when absent', () => {
  const result = analyze(make(''), {}, BASE_URL);
  assert.equal(result.meta_description, null);
  assert.equal(result.meta_desc_length, null);
});

// --- Canonical ---

test('extracts canonical URL', () => {
  const result = analyze(
    make('', '<link rel="canonical" href="https://example.com/page">'),
    {},
    BASE_URL
  );
  assert.equal(result.canonical_url, 'https://example.com/page');
});

test('canonical_url is null when absent', () => {
  const result = analyze(make(''), {}, BASE_URL);
  assert.equal(result.canonical_url, null);
});

// --- Headings ---

test('extracts first H1 text and count', () => {
  const result = analyze(make('<h1>Main</h1><h1>Second</h1>'), {}, BASE_URL);
  assert.equal(result.h1, 'Main');
  assert.equal(result.h1_count, 2);
});

test('h1 is null when no H1 present', () => {
  const result = analyze(make('<h2>Sub</h2>'), {}, BASE_URL);
  assert.equal(result.h1, null);
  assert.equal(result.h1_count, 0);
});

test('counts H2 tags', () => {
  const result = analyze(make('<h2>A</h2><h2>B</h2><h2>C</h2>'), {}, BASE_URL);
  assert.equal(result.h2_count, 3);
});

// --- Schema ---

test('detects JSON-LD schema', () => {
  const result = analyze(
    make('', '<script type="application/ld+json">{"@type":"WebPage"}</script>'),
    {},
    BASE_URL
  );
  assert.equal(result.has_schema, 1);
});

test('has_schema is 0 when no JSON-LD present', () => {
  const result = analyze(make(''), {}, BASE_URL);
  assert.equal(result.has_schema, 0);
});

// --- Robots / indexability ---

test('is_indexable is 0 when meta robots contains noindex', () => {
  const result = analyze(
    make('', '<meta name="robots" content="noindex, follow">'),
    {},
    BASE_URL
  );
  assert.equal(result.robots_directive, 'noindex, follow');
  assert.equal(result.is_indexable, 0);
});

test('is_indexable is 0 when X-Robots-Tag header contains noindex', () => {
  const result = analyze(make(''), { 'x-robots-tag': 'noindex' }, BASE_URL);
  assert.equal(result.x_robots_tag, 'noindex');
  assert.equal(result.is_indexable, 0);
});

test('is_indexable is 1 when no noindex directive present', () => {
  const result = analyze(
    make('', '<meta name="robots" content="index, follow">'),
    {},
    BASE_URL
  );
  assert.equal(result.is_indexable, 1);
});

test('joins meta robots and meta googlebot directives', () => {
  const result = analyze(
    make(
      '',
      '<meta name="robots" content="noindex"><meta name="googlebot" content="nosnippet">'
    ),
    {},
    BASE_URL
  );
  assert.equal(result.robots_directive, 'noindex, nosnippet');
});

// --- Word count ---

test('counts words in body text', () => {
  const result = analyze(make('<p>one two three four five</p>'), {}, BASE_URL);
  assert.equal(result.word_count, 5);
});

test('excludes script and style content from word count', () => {
  const result = analyze(
    make('<p>real words</p><script>var x = 1;</script><style>.foo { color: red; }</style>'),
    {},
    BASE_URL
  );
  assert.equal(result.word_count, 2);
});

// --- Links ---

test('classifies internal and external links', () => {
  const result = analyze(
    make('<a href="/about">About</a><a href="https://other.com">External</a>'),
    {},
    BASE_URL
  );
  assert.equal(result.internal_link_count, 1);
  assert.equal(result.external_link_count, 1);
  assert.equal(result.links[0].is_external, false);
  assert.equal(result.links[1].is_external, true);
});

test('resolves relative URLs to absolute', () => {
  const result = analyze(make('<a href="/contact">Contact</a>'), {}, BASE_URL);
  assert.equal(result.links[0].target_url, 'https://example.com/contact');
});

test('strips hash fragment from link URLs', () => {
  const result = analyze(make('<a href="/page#section">Link</a>'), {}, BASE_URL);
  assert.equal(result.links[0].target_url, 'https://example.com/page');
});

test('skips mailto, tel, javascript, bare hash, and fragment links', () => {
  const result = analyze(
    make(
      '<a href="mailto:a@b.com">Mail</a>' +
        '<a href="tel:555">Call</a>' +
        '<a href="javascript:void(0)">JS</a>' +
        '<a href="#">Hash</a>' +
        '<a href="#section-id">Fragment</a>'
    ),
    {},
    BASE_URL
  );
  assert.equal(result.links.length, 0);
});

test('captures anchor text', () => {
  const result = analyze(make('<a href="/about">About Us</a>'), {}, BASE_URL);
  assert.equal(result.links[0].anchor_text, 'About Us');
});

// --- Images ---

test('counts images and distinguishes absent vs empty alt', () => {
  const result = analyze(
    make('<img src="/a.jpg" alt=""><img src="/b.jpg" alt="Logo"><img src="/c.jpg">'),
    {},
    BASE_URL
  );
  assert.equal(result.image_count, 3);
  assert.equal(result.images_missing_alt, 1); // /c.jpg — alt attribute absent
  assert.equal(result.images_empty_alt, 1);   // /a.jpg — alt="" (decorative)
});

test('resolves relative image src to absolute', () => {
  const result = analyze(make('<img src="/img/logo.png" alt="Logo">'), {}, BASE_URL);
  assert.equal(result.images[0].src, 'https://example.com/img/logo.png');
});

test('stores null for absent alt attribute, empty string for present-but-empty', () => {
  const result = analyze(
    make('<img src="/a.jpg"><img src="/b.jpg" alt="">'),
    {},
    BASE_URL
  );
  assert.equal(result.images[0].alt, null);
  assert.equal(result.images[1].alt, '');
});

// --- Plan verification fixture ---

test('plan verification fixture passes all assertions', () => {
  const html = `<html><head>
    <title>Test Page Title</title>
    <meta name="description" content="A test description">
    <link rel="canonical" href="https://example.com/test">
    <script type="application/ld+json">{"@type":"WebPage"}</script>
  </head><body>
    <h1>Main Heading</h1><h2>Sub</h2>
    <p>Hello world content here</p>
    <a href="/internal">Internal</a>
    <a href="https://other.com">External</a>
    <img src="img.jpg" alt="">
    <img src="img2.jpg" alt="Has alt">
  </body></html>`;

  const result = analyze(html, {}, 'https://example.com/test');
  assert.equal(result.title, 'Test Page Title');
  assert.equal(result.title_length, 15);
  assert.equal(result.h1, 'Main Heading');
  assert.equal(result.h1_count, 1);
  assert.equal(result.h2_count, 1);
  assert.equal(result.has_schema, 1);
  assert.equal(result.images_missing_alt, 0); // img.jpg has alt="" — absent, not missing
  assert.equal(result.images_empty_alt, 1);   // img.jpg has alt="" — explicitly empty
  assert.equal(result.canonical_url, 'https://example.com/test');
});
