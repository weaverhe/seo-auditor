'use strict';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const robots = require('../src/robots');

afterEach(() => mock.restoreAll());

test('isAllowed returns true for a path not disallowed', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    data: 'User-agent: *\nDisallow: /private/',
  }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.isAllowed('https://example.com/public/page'), true);
});

test('isAllowed returns false for a disallowed path', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    data: 'User-agent: *\nDisallow: /private/',
  }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.isAllowed('https://example.com/private/secret'), false);
});

test('isAllowed returns true when robots.txt is empty', async () => {
  mock.method(axios, 'get', async () => ({ status: 200, data: '' }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.isAllowed('https://example.com/anything'), true);
});

test('isAllowed returns true when robots.txt returns 404', async () => {
  mock.method(axios, 'get', async () => ({ status: 404, data: '' }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.isAllowed('https://example.com/anything'), true);
});

test('isAllowed returns true when fetch throws a network error', async () => {
  mock.method(axios, 'get', async () => {
    throw new Error('ECONNREFUSED');
  });
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.isAllowed('https://example.com/anything'), true);
});

test('getCrawlDelay returns the configured delay', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    data: 'User-agent: *\nCrawl-delay: 2',
  }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.getCrawlDelay(), 2);
});

test('getCrawlDelay returns null when not specified', async () => {
  mock.method(axios, 'get', async () => ({ status: 200, data: 'User-agent: *\nDisallow:' }));
  const r = await robots.fetchRobots('https://example.com');
  assert.equal(r.getCrawlDelay(), null);
});

test('getSitemapUrls returns sitemap URLs from robots.txt', async () => {
  mock.method(axios, 'get', async () => ({
    status: 200,
    data: 'User-agent: *\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap2.xml',
  }));
  const r = await robots.fetchRobots('https://example.com');
  const urls = r.getSitemapUrls();
  assert.equal(urls.length, 2);
  assert.ok(urls.includes('https://example.com/sitemap.xml'));
});

test('getSitemapUrls returns empty array when none declared', async () => {
  mock.method(axios, 'get', async () => ({ status: 200, data: 'User-agent: *\nDisallow:' }));
  const r = await robots.fetchRobots('https://example.com');
  assert.deepEqual(r.getSitemapUrls(), []);
});
