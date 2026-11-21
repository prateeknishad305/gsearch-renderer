'use strict';

// Dork ("site:", "filetype:", ...) support for the google_lite path.
//
// These tests are deliberately network-free: they pin the behaviour that made
// dorks unusable before — operator-blind basic-HTML URLs, Bing's /ck/a
// redirect host leaking into the filter, operator-blind fallback ordering and
// renders that outlived the request budget.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const googleLite = require('../api/lib/googleLite');
const dork = require('../api/lib/dork');
const search = require('../api/search');
const lite = require('../api/lib/lite');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'bing_results.html'), 'utf8');
const BING_HREF_RE = /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;

// ---------------------------------------------------------------- operators

test('parseDork detects site: and filetype: operators', () => {
  const info = dork.parseDork('site:python.org asyncio tutorial');
  assert.equal(info.has_operators, true);
  assert.deepEqual(info.site_targets, ['python.org']);
  assert.deepEqual(info.operators.site, ['python.org']);

  const f = dork.parseDork('filetype:pdf machine learning');
  assert.equal(f.has_operators, true);
  assert.deepEqual(f.site_targets, []);
  assert.deepEqual(f.operators.filetype, ['pdf']);
});

test('a plain query has no operators', () => {
  const info = dork.parseDork('asyncio tutorial');
  assert.equal(info.has_operators, false);
  assert.deepEqual(info.site_targets, []);
});

test('hostMatchesSite accepts the domain and its subdomains', () => {
  // The filter works on hostnames, not on full urls.
  assert.equal(dork.hostMatchesSite('www.python.org', 'python.org'), true);
  assert.equal(dork.hostMatchesSite('docs.python.org', 'python.org'), true);
  assert.equal(dork.hostMatchesSite('python.org', 'python.org'), true);
  assert.equal(dork.hostMatchesSite('mybank.com', 'python.org'), false);
  assert.equal(dork.hostMatchesSite('notpython.org', 'python.org'), false);
});

test('enforceDork keeps on-target results and drops the rest', () => {
  const info = dork.parseDork('site:python.org');
  const results = [
    { url: 'https://www.python.org/', title: 'Python' },
    { url: 'https://docs.python.org/3/', title: 'Docs' },
    { url: 'https://mybank.com/', title: 'Bank' },
  ];
  const kept = dork.enforceDork(results, info);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.url.includes('python.org')));
});

// ------------------------------------------------------- bing /ck/a decode

test("bing's /ck/a redirect hrefs decode to the real destination", () => {
  // Same shape Bing serves today: u=a1<base64url> inside the ck/a redirect.
  const href =
    'https://www.bing.com/ck/a?!&&p=7c8e1d697bb78e2b2df6ddce019599435d81d122e15d344f53e023c93447086a' +
    'JmltdHM9MTc5NTIxOTIwMA&ptn=3&ver=2&u=a1aHR0cHM6Ly93d3cucHl0aG9uLm9yZy8&ntb=1';
  const decoded = lite.decodeBingHref(href);
  assert.equal(decoded, 'https://www.python.org/');
});

test('a plain bing href is left untouched', () => {
  assert.equal(lite.decodeBingHref('https://www.python.org/'), 'https://www.python.org/');
  assert.equal(lite.decodeBingHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('bing fixture results expose the real host, not bing.com', () => {
  const blocks = lite.parseAnchorBlocks(FIXTURE, {
    hostRe: /www\.bing\.com/,
    titleRe: BING_HREF_RE,
    decode: lite.decodeBingHref,
  });
  assert.ok(blocks.length > 0, 'fixture should contain results');
  for (const b of blocks) {
    assert.ok(
      !/bing\.com\/ck\//.test(b.url),
      `ck/a redirect leaked into the result url: ${b.url}`,
    );
    assert.match(b.url, /^https?:\/\//);
  }
  assert.ok(blocks.some((b) => !/bing\.com/.test(b.url)));
});

test('the bing fixture keeps only on-target results after dork filtering', () => {
  const blocks = lite.parseAnchorBlocks(FIXTURE, {
    hostRe: /www\.bing\.com/,
    titleRe: BING_HREF_RE,
    decode: lite.decodeBingHref,
  });
  const info = dork.parseDork('site:python.org');
  const kept = dork.enforceDork(blocks, info);
  for (const r of kept) assert.ok(dork.hostMatchesSite(r.url, 'python.org'));
});

// --------------------------------------------------------- lite URL surface

test('a dork query uses the modern SERP surface, not the basic-HTML one', () => {
  const dorkUrl = googleLite
    .buildLiteUrl({ q: 'site:python.org asyncio', hl: 'en', gl: 'us', classic: false })
    .url;
  const basicUrl = googleLite
    .buildLiteUrl({ q: 'asyncio tutorial', hl: 'en', gl: 'us', classic: true })
    .url;

  // gbv=2 is the basic-HTML backend; it ignores site:/filetype: entirely.
  assert.ok(!dorkUrl.includes('gbv=2'), `dork url must not use gbv=2: ${dorkUrl}`);
  assert.ok(basicUrl.includes('gbv=2'), 'plain query keeps the cheap basic-HTML surface');
  // The operator itself must survive into the query string.
  assert.match(dorkUrl, /site(?:%3A|:)python\.org/);
});

test('httpIsUseful disables the basic-HTML HTTP path for dorks', () => {
  assert.equal(googleLite.httpIsUseful([], true), false, 'dorks must not use gbv=2 over plain HTTP');
  assert.equal(typeof googleLite.httpIsUseful([], false), 'boolean');
});

// ------------------------------------------------------ fallback ordering

test('operator-capable engines are tried before chrome for a dork', () => {
  const info = dork.parseDork('site:python.org');
  const list = search.withFallbacks(['duckduckgo', 'bing', 'chrome'], info);
  const chromeIdx = list.indexOf('chrome');
  const capable = list.filter(
    (e) => e !== 'chrome' && dork.engineSupport(e, info).supported.includes('site'),
  );
  assert.ok(capable.length > 0, 'expected at least one site-capable engine');
  for (const e of capable) {
    assert.ok(
      list.indexOf(e) < chromeIdx,
      `${e} must be tried before chrome (order: ${list.join(', ')})`,
    );
  }
});

test('a plain query keeps the configured fallback order', () => {
  const list = search.withFallbacks(['duckduckgo', 'bing', 'chrome'], null);
  assert.deepEqual(list, ['duckduckgo', 'bing', 'chrome']);
});

// ------------------------------------------------------------- geo / locale

test('the lite url carries the requested locale', () => {
  const url = googleLite.buildLiteUrl({ q: 'asyncio', hl: 'en', gl: 'us', classic: true }).url;
  assert.match(url, /hl=en/);
  assert.match(url, /gl=us/);
});

test('geoFromUrl recovers the locale a lite url was built with', () => {
  const uk = googleLite.geoFromUrl('https://www.google.co.uk/search?q=x&hl=en&gl=uk');
  assert.equal(uk.gl, 'uk');
  assert.equal(uk.hl, 'en');
  assert.ok(uk.acceptLanguage.includes('en'));
});

// ------------------------------------------------------------ request budget

test('a dork render is clamped to the request budget', async () => {
  // A dork must not spend the whole budget on the browser: the engines that
  // honour site: without a browser still need their slice. The transport is
  // stubbed so the assertion is about the plumbing, not about the network.
  const chromeFetch = require('../api/lib/chromeFetch');
  const original = chromeFetch.fetchHtml;
  const seen = [];
  chromeFetch.fetchHtml = async (url, opts) => {
    seen.push(opts);
    const e = new Error('stubbed');
    e.code = 'STUB';
    throw e;
  };
  try {
    await googleLite
      .fetchGoogleLite({
        url: 'https://www.google.com/search?q=site%3Apython.org+asyncio',
        geo: { hl: 'en', gl: 'us', acceptLanguage: 'en-US,en;q=0.9' },
        proxies: [],
        timeoutMs: 3500,
        dork: true,
        deadlineAt: Date.now() + 1500,
      })
      .then(() => 'ok')
      .catch(() => 'failed');
  } finally {
    chromeFetch.fetchHtml = original;
  }
  assert.ok(seen.length >= 1, 'the browser transport should have been used');
  for (const opts of seen) {
    assert.ok(opts.timeoutMs <= 1500, `render timeout must fit the budget (${opts.timeoutMs}ms)`);
    assert.ok(
      opts.checkoutMs <= 1500,
      `browser checkout must fit the budget (${opts.checkoutMs}ms)`,
    );
  }
});

test('a dork render is capped so the fallback engines keep their slice', async () => {
  const chromeFetch = require('../api/lib/chromeFetch');
  const original = chromeFetch.fetchHtml;
  const seen = [];
  chromeFetch.fetchHtml = async (url, opts) => {
    seen.push(opts);
    const e = new Error('stubbed');
    e.code = 'STUB';
    throw e;
  };
  try {
    await googleLite
      .fetchGoogleLite({
        url: 'https://www.google.com/search?q=site%3Apython.org',
        geo: { hl: 'en', gl: 'us', acceptLanguage: 'en-US,en;q=0.9' },
        proxies: [],
        timeoutMs: 15000,
        dork: true,
        deadlineAt: Date.now() + 12000,
      })
      .then(() => 'ok')
      .catch(() => 'failed');
  } finally {
    chromeFetch.fetchHtml = original;
  }
  assert.ok(seen.length >= 1);
  for (const opts of seen) {
    // LITE_DORK_CHROME_MS defaults to 6000: a dork must not burn the whole
    // budget on Google when bing/duckduckgo can still answer it.
    assert.ok(opts.timeoutMs <= 6000, `dork render must be capped (${opts.timeoutMs}ms)`);
  }
});
