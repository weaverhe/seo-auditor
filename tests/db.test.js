'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Db = require('../src/db');

const HOSTNAME = '_test.db.local';
const SITE_URL = 'https://_test.db.local';
let db;

before(() => {
  db = new Db(HOSTNAME);
});

after(() => {
  db.close();
  fs.rmSync(path.join('audits', HOSTNAME), { recursive: true });
});

test('createSession returns a numeric id', () => {
  const sid = db.createSession(SITE_URL, 'test-label');
  assert.ok(typeof sid === 'number' && sid > 0);
});

test('listSessions returns all created sessions', () => {
  const sessions = db.listSessions();
  assert.ok(sessions.length >= 1);
  assert.equal(sessions[0].site_url, SITE_URL);
  assert.equal(sessions[0].label, 'test-label');
  assert.equal(sessions[0].status, 'running');
});

test('upsertPage inserts a pending page', () => {
  const sid = db.createSession(SITE_URL, 'upsert-test');
  db.upsertPage(sid, { url: `${SITE_URL}/page`, depth: 1 });
  const pending = db.getPendingUrls(sid);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, `${SITE_URL}/page`);
  assert.equal(pending[0].depth, 1);
});

test('upsertPage is idempotent — duplicate url does nothing', () => {
  const sid = db.createSession(SITE_URL, 'idempotent-test');
  db.upsertPage(sid, { url: `${SITE_URL}/dup`, depth: 0 });
  db.upsertPage(sid, { url: `${SITE_URL}/dup`, depth: 0 });
  const pending = db.getPendingUrls(sid);
  assert.equal(pending.length, 1);
});

test('getPendingUrls returns pages ordered shallowest-first', () => {
  const sid = db.createSession(SITE_URL, 'depth-order-test');
  db.upsertPage(sid, { url: `${SITE_URL}/deep`, depth: 3 });
  db.upsertPage(sid, { url: `${SITE_URL}/shallow`, depth: 1 });
  db.upsertPage(sid, { url: `${SITE_URL}/root`, depth: 0 });
  const pending = db.getPendingUrls(sid);
  assert.equal(pending[0].depth, 0);
  assert.equal(pending[1].depth, 1);
  assert.equal(pending[2].depth, 3);
});

test('markPageCrawled removes page from pending and writes seo data', () => {
  const sid = db.createSession(SITE_URL, 'crawled-test');
  const url = `${SITE_URL}/crawled`;
  db.upsertPage(sid, { url, depth: 0 });
  db.markPageCrawled(sid, url, {
    status_code: 200,
    title: 'Test Page',
    title_length: 9,
    meta_description: null,
    meta_desc_length: null,
    redirect_url: null,
    content_type: 'text/html',
    h1: 'Heading',
    h1_count: 1,
    h2_count: 2,
    canonical_url: url,
    robots_directive: null,
    x_robots_tag: null,
    is_indexable: 1,
    word_count: 50,
    internal_link_count: 3,
    external_link_count: 1,
    image_count: 2,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: 200,
    page_size_bytes: 1024,
  });
  assert.equal(db.getPendingUrls(sid).length, 0);
  const row = db.db.prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?').get(sid, url);
  assert.equal(row.status, 'crawled');
  assert.equal(row.title, 'Test Page');
  assert.equal(row.status_code, 200);
});

test('markPageError sets status to error', () => {
  const sid = db.createSession(SITE_URL, 'error-test');
  const url = `${SITE_URL}/broken`;
  db.upsertPage(sid, { url, depth: 0 });
  db.markPageError(sid, url, 404, 'Not Found');
  const row = db.db.prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?').get(sid, url);
  assert.equal(row.status, 'error');
  assert.equal(row.status_code, 404);
  assert.equal(row.error_message, 'Not Found');
});

test('markPageSkipped sets status to skipped', () => {
  const sid = db.createSession(SITE_URL, 'skipped-test');
  const url = `${SITE_URL}/disallowed`;
  db.upsertPage(sid, { url, depth: 0 });
  db.markPageSkipped(sid, url, 'disallowed by robots.txt');
  const row = db.db.prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?').get(sid, url);
  assert.equal(row.status, 'skipped');
  assert.equal(row.error_message, 'disallowed by robots.txt');
});

test('updateSessionStatus complete sets total_pages and completed_at', () => {
  const sid = db.createSession(SITE_URL, 'status-test');
  const url = `${SITE_URL}/done`;
  db.upsertPage(sid, { url, depth: 0 });
  db.markPageCrawled(sid, url, {
    status_code: 200,
    title: null,
    title_length: null,
    meta_description: null,
    meta_desc_length: null,
    redirect_url: null,
    content_type: 'text/html',
    h1: null,
    h1_count: 0,
    h2_count: 0,
    canonical_url: null,
    robots_directive: null,
    x_robots_tag: null,
    is_indexable: 1,
    word_count: 0,
    internal_link_count: 0,
    external_link_count: 0,
    image_count: 0,
    images_missing_alt: 0,
    images_empty_alt: 0,
    has_schema: 0,
    response_time_ms: 100,
    page_size_bytes: 512,
  });
  db.updateSessionStatus(sid, 'complete');
  const session = db.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  assert.equal(session.status, 'complete');
  assert.equal(session.total_pages, 1);
  assert.ok(session.completed_at);
});

test('getLatestInterruptedSession returns most recent interrupted session', () => {
  const sid = db.createSession(SITE_URL, 'interrupted-test');
  db.updateSessionStatus(sid, 'interrupted');
  const session = db.getLatestInterruptedSession();
  assert.equal(session.id, sid);
  assert.equal(session.status, 'interrupted');
});

test('insertLinks bulk inserts within a transaction', () => {
  const sid = db.createSession(SITE_URL, 'links-test');
  db.insertLinks(sid, [
    {
      source_url: `${SITE_URL}/`,
      target_url: `${SITE_URL}/about`,
      anchor_text: 'About',
      is_external: false,
    },
    {
      source_url: `${SITE_URL}/`,
      target_url: 'https://other.com',
      anchor_text: 'External',
      is_external: true,
    },
  ]);
  const links = db.db.prepare('SELECT * FROM links WHERE session_id = ?').all(sid);
  assert.equal(links.length, 2);
  assert.equal(links[1].is_external, 1);
});

test('getSession returns the session by ID', () => {
  const sid = db.createSession(SITE_URL, 'get-session-test');
  const session = db.getSession(sid);
  assert.equal(session.id, sid);
  assert.equal(session.label, 'get-session-test');
});

test('getSession returns undefined for unknown ID', () => {
  const session = db.getSession(99999);
  assert.equal(session, undefined);
});

test('getPages returns all pages for a session ordered by url', () => {
  const sid = db.createSession(SITE_URL, 'get-pages-test');
  db.upsertPage(sid, { url: `${SITE_URL}/z`, depth: 1 });
  db.upsertPage(sid, { url: `${SITE_URL}/a`, depth: 1 });
  const pages = db.getPages(sid);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].url, `${SITE_URL}/a`);
  assert.equal(pages[1].url, `${SITE_URL}/z`);
});

test('getImages returns all images for a session', () => {
  const sid = db.createSession(SITE_URL, 'get-images-test');
  db.insertImages(sid, [
    { page_url: `${SITE_URL}/`, src: '/img/a.jpg', alt: 'A' },
    { page_url: `${SITE_URL}/`, src: '/img/b.jpg', alt: null },
  ]);
  const images = db.getImages(sid);
  assert.equal(images.length, 2);
});

test('getInternalLinks returns only internal links for a session', () => {
  const sid = db.createSession(SITE_URL, 'get-links-test');
  db.insertLinks(sid, [
    { source_url: `${SITE_URL}/`, target_url: `${SITE_URL}/about`, anchor_text: 'About', is_external: false },
    { source_url: `${SITE_URL}/`, target_url: 'https://external.com', anchor_text: 'Ext', is_external: true },
  ]);
  const links = db.getInternalLinks(sid);
  assert.equal(links.length, 1);
  assert.equal(links[0].target_url, `${SITE_URL}/about`);
});

test('insertImages bulk inserts within a transaction', () => {
  const sid = db.createSession(SITE_URL, 'images-test');
  db.insertImages(sid, [
    { page_url: `${SITE_URL}/`, src: '/img/logo.png', alt: 'Logo' },
    { page_url: `${SITE_URL}/`, src: '/img/hero.jpg', alt: '' },
  ]);
  const images = db.db.prepare('SELECT * FROM images WHERE session_id = ?').all(sid);
  assert.equal(images.length, 2);
  assert.equal(images[0].alt, 'Logo');
});
