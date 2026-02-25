'use strict';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Sitemapper = require('sitemapper').default;
const sitemap = require('../src/sitemap');

afterEach(() => mock.restoreAll());

test('getUrls returns URLs from /sitemap.xml when no robots sitemap provided', async () => {
  mock.method(Sitemapper.prototype, 'fetch', async () => ({
    sites: ['https://example.com/', 'https://example.com/about'],
    errors: [],
  }));
  const urls = await sitemap.getUrls('https://example.com');
  assert.equal(urls.length, 2);
  assert.ok(urls.includes('https://example.com/'));
});

test('getUrls uses robots.txt sitemap URLs when provided', async () => {
  let fetchedUrl;
  mock.method(Sitemapper.prototype, 'fetch', async function (url) {
    fetchedUrl = url;
    return { sites: ['https://example.com/page1'], errors: [] };
  });
  await sitemap.getUrls('https://example.com', ['https://example.com/custom-sitemap.xml']);
  assert.equal(fetchedUrl, 'https://example.com/custom-sitemap.xml');
});

test('getUrls deduplicates URLs across multiple sitemaps', async () => {
  let callCount = 0;
  mock.method(Sitemapper.prototype, 'fetch', async () => {
    callCount++;
    return {
      sites: ['https://example.com/shared', `https://example.com/unique-${callCount}`],
      errors: [],
    };
  });
  const urls = await sitemap.getUrls('https://example.com', [
    'https://example.com/sitemap1.xml',
    'https://example.com/sitemap2.xml',
  ]);
  assert.equal(urls.filter((u) => u === 'https://example.com/shared').length, 1);
  assert.equal(urls.length, 3);
});

test('getUrls returns empty array when sitemap fetch fails', async () => {
  mock.method(Sitemapper.prototype, 'fetch', async () => {
    throw new Error('fetch failed');
  });
  const urls = await sitemap.getUrls('https://example.com');
  assert.deepEqual(urls, []);
});

test('getUrls continues if one sitemap fails and another succeeds', async () => {
  let callCount = 0;
  mock.method(Sitemapper.prototype, 'fetch', async () => {
    callCount++;
    if (callCount === 1) throw new Error('first failed');
    return { sites: ['https://example.com/page1'], errors: [] };
  });
  const urls = await sitemap.getUrls('https://example.com', [
    'https://example.com/bad-sitemap.xml',
    'https://example.com/good-sitemap.xml',
  ]);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], 'https://example.com/page1');
});
