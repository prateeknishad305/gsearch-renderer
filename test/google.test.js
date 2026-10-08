'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../api/lib/google');
const ip = require('../api/lib/googleIp');
const lock = require('../api/lib/googleLock');
const session = require('../api/lib/googleSession');
const { ENGINES } = require('../api/lib/engines');

test('google ships 100+ named fixes', () => {
  assert.ok(g.FIXES.length >= 100, `only ${g.FIXES.length} fixes`);
  assert.equal(new Set(g.FIXES).size, g.FIXES.length);
});

test('google URL includes efficiency params and omits num=10', () => {
  const u = ENGINES.google.url({ q: 'hello world', num: 100, start: 10, hl: 'en', gl: 'us' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('q'), 'hello world');
  assert.equal(p.get('num'), null);
  assert.equal(p.get('start'), '10');
  assert.equal(p.get('hl'), 'en');
  assert.equal(p.get('gl'), 'us');
  assert.equal(p.get('udm'), '14');
  assert.equal(p.get('sourceid'), 'chrome');
  assert.equal(p.get('ie'), 'UTF-8');
  assert.equal(p.get('pws'), '0');
  assert.equal(p.get('nfpr'), '1');
  assert.match(u, /^https:\/\/www\.google\.com\/search\?/);
});

test('google geo matches proxy country=de', () => {
  const geo = g.resolveGeo({ gl: 'us', hl: 'en', proxy: 'http://user+country=de:x@host:80' });
  assert.equal(geo.gl, 'de');
  assert.equal(geo.tz, 'Europe/Berlin');
  assert.match(geo.acceptLanguage, /^de/);
});

test('uk gl normalizes to gb', () => {
  assert.equal(g.normalizeGl('uk'), 'gb');
});

test('query strips zwsp and extra spaces', () => {
  assert.equal(g.normalizeQuery('  a\u200B  b  '), 'a b');
});

test('preferHttp rewrites socks5', () => {
  assert.match(g.preferHttp('socks5://u:p@h:1082'), /^http:\/\//);
});

test('decodeHref reads /url?q= and /url?url=', () => {
  assert.equal(g.decodeHref('/url?q=https://example.com/a'), 'https://example.com/a');
  assert.equal(g.decodeHref('/url?url=https://example.com/b'), 'https://example.com/b');
});

test('junk urls drop imgres aclk webcache gstatic ads but keep /goto /url', () => {
  assert.equal(g.isJunkUrl('/goto?url=x'), false);
  assert.equal(g.isJunkUrl('/url?q=https://a.example/1'), false);
  assert.equal(g.isJunkUrl('/imgres?imgurl=x'), true);
  assert.equal(g.isJunkUrl('https://webcache.googleusercontent.com/search?q=cache:x'), true);
  assert.equal(g.isJunkUrl('https://www.gstatic.com/foo'), true);
  assert.equal(g.isJunkUrl('https://www.googleadservices.com/pagead'), true);
  assert.equal(g.isJunkUrl('https://example.com/ok'), false);
});

test('filterResults keeps unique http titles and google /url for followGoto', () => {
  const out = g.filterResults([
    { title: 'A', url: '/url?q=https://a.example/1' },
    { title: 'A2', url: 'https://a.example/1' },
    { title: '', url: 'https://b.example/' },
    { title: 'Ads', url: 'https://www.googleadservices.com/x' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, '/url?q=https://a.example/1');
  assert.equal(out[1].url, 'https://a.example/1');
});

test('asset blocker keeps document/script/stylesheet', () => {
  assert.equal(g.shouldBlockRequest('https://www.google.com/search', 'document'), false);
  assert.equal(g.shouldBlockRequest('https://www.google.com/x.js', 'script'), false);
  assert.equal(g.shouldBlockRequest('https://www.google.com/x.css', 'stylesheet'), false);
  assert.equal(g.shouldBlockRequest('https://www.google.com/x.png', 'image'), true);
  assert.equal(g.shouldBlockRequest('https://www.googletagmanager.com/gtm.js', 'script'), true);
});

test('sorry and soft-block detectors', () => {
  assert.equal(g.isSorryUrl('https://www.google.com/sorry/index?continue=x'), true);
  assert.equal(g.isSorryUrl('https://www.google.com/sorry/index?continue=x&q=unusual-traffic'), true);
  assert.equal(g.isSorryUrl('https://www.google.com/search?q=hello'), false);
  assert.equal(g.isSoftBlock({ navStatus: 200, h3: 8, textLen: 4000, url: 'https://www.google.com/search' }), false);
  assert.equal(g.isSoftBlock({ navStatus: 429, h3: 0, textLen: 10, url: 'https://www.google.com/search' }), true);
  assert.equal(g.isSoftBlock({ navStatus: 200, h3: 0, textLen: 40, url: 'https://www.google.com/search' }), true);
});

test('per-IP circuit opens and cools', () => {
  ip.reset();
  const p = 'http://u:p@exit.example:8080';
  assert.equal(ip.isOpen(p), false);
  for (let i = 0; i < ip.openAfter(); i++) ip.record(p, 'BLOCKED');
  assert.equal(ip.isOpen(p), true);
  ip.record(p, 'OK');
  assert.equal(ip.isOpen(p), false);
  ip.reset();
});

test('circuit does not skip the direct exit', () => {
  ip.reset();
  for (let i = 0; i < ip.openAfter(); i++) ip.record(null, 'BLOCKED');
  assert.equal(ip.isOpen(null), true);
  assert.equal(ip.shouldSkip(null), false);
  const p = 'http://u:p@skip.example:8080';
  for (let i = 0; i < ip.openAfter(); i++) ip.record(p, 'BLOCKED');
  assert.equal(ip.shouldSkip(p), true);
  ip.reset();
});

test('session sticky expires after N uses', () => {
  session.reset();
  const p = 'http://u:p@exit.example:8080';
  assert.equal(session.get(p), null);
  session.put(p, [{ name: 'NID', value: '1' }], true);
  assert.equal(session.get(p).minted, true);
  const n = g.stickyLimit();
  for (let i = 0; i < n; i++) session.put(p, [], true);
  assert.equal(session.get(p), null);
  session.reset();
});

test('one-nav lock serializes per IP', async () => {
  const p = 'http://u:p@lock.example:8080';
  const a = await lock.acquire(p);
  let released = false;
  const bP = lock.acquire(p).then((h) => {
    released = true;
    h.release();
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(released, false);
  a.release();
  await bP;
  assert.equal(released, true);
});

test('cookies skip random CONSENT when sticky', () => {
  const sticky = ENGINES.google.cookies({ sticky: true });
  assert.equal(sticky.some((c) => c.name === 'CONSENT' && /YES\+cb/.test(c.value)), false);
});

test('pageParallel default off for google', () => {
  assert.equal(g.pageParallel(), false);
});

test('google jitter defaults to 0', () => {
  const prev = process.env.GOOGLE_JITTER_MS;
  delete process.env.GOOGLE_JITTER_MS;
  assert.equal(g.jitterMs(), 0);
  if (prev === undefined) delete process.env.GOOGLE_JITTER_MS;
  else process.env.GOOGLE_JITTER_MS = prev;
});

test('NAVIGATION_TIMEOUT and RESULT_TIMEOUT alias google timeouts', () => {
  const prevNav = process.env.GOOGLE_NAV_MS;
  const prevReady = process.env.GOOGLE_READY_MS;
  const prevNt = process.env.NAVIGATION_TIMEOUT;
  const prevRt = process.env.RESULT_TIMEOUT;
  delete process.env.GOOGLE_NAV_MS;
  delete process.env.GOOGLE_READY_MS;
  process.env.NAVIGATION_TIMEOUT = '7000';
  process.env.RESULT_TIMEOUT = '2500';
  assert.equal(g.navTimeoutMs(), 7000);
  assert.equal(g.readyTimeoutMs(), 2500);
  process.env.GOOGLE_NAV_MS = '12000';
  assert.equal(g.navTimeoutMs(), 12000);
  for (const [k, v] of [
    ['GOOGLE_NAV_MS', prevNav],
    ['GOOGLE_READY_MS', prevReady],
    ['NAVIGATION_TIMEOUT', prevNt],
    ['RESULT_TIMEOUT', prevRt],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('countryFromProxy reads plus and query forms', () => {
  assert.equal(g.countryFromProxy('http://user+country=de:pass@h:80'), 'de');
  assert.equal(g.countryFromProxy('http://u:p@h:80?cc=fr'), 'fr');
});
