'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const challenge = require('../api/lib/challenge');
const proxyChain = require('../api/lib/proxyChain');
const intent = require('../api/lib/intent');
const heal = require('../api/lib/healSelectors');
const sandbox = require('../api/lib/sandbox');
const geo = require('../api/lib/geoInject');
const media = require('../api/lib/mediaBlock');
const llm = require('../api/lib/llmParse');
const cluster = require('../api/lib/clusterSync');
const tenant = require('../api/lib/tenantAuth');
const stream = require('../api/lib/streamJson');
const redis = require('../api/lib/redisCache');
const queue = require('../api/lib/workQueue');
const fd = require('../api/lib/fdTune');
const features = require('../api/lib/features');
const uaMask = require('../api/lib/uaMask');
const { isSorryUrl, extraHeaders, FIXES } = require('../api/lib/google');
const { isBlockedPage } = require('../api/lib/lite');
const chromeFetch = require('../api/lib/chromeFetch');
const { route } = require('../server');

test('captcha and turnstile detect as BLOCKED and never route to a solver', () => {
  const recap = challenge.detectChallenge({
    url: 'https://www.google.com/sorry/index',
    html: '<div id="captcha"></div>',
  });
  assert.equal(recap.code, 'BLOCKED');
  assert.equal(recap.type, 'sorry');
  const turn = challenge.detectChallenge({
    html: '<div class="cf-turnstile"></div>',
    url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform',
  });
  assert.equal(turn.code, 'BLOCKED');
  assert.equal(turn.type, 'turnstile');
  const routed = challenge.routeToSolver(turn);
  assert.equal(routed.routed, false);
  assert.equal(routed.solver, null);
  const err = challenge.blockedError(turn, 'google');
  assert.equal(err.code, 'BLOCKED');
  assert.equal(challenge.rotateOnChallenge(err), true);
  assert.equal(challenge.rotateOnChallenge({ code: 'SORRY' }), true);
  assert.equal(challenge.rotateOnChallenge({ code: 'TIMEOUT' }), false);
  assert.equal(isSorryUrl('https://challenges.cloudflare.com/turnstile'), true);
  assert.equal(isBlockedPage('<div class="cf-turnstile"></div>', 'google'), true);
  assert.equal(
    isBlockedPage(
      '<h3>Hello world</h3><cite>https://example.com</cite><div class="g-recaptcha"></div><script src="https://www.google.com/recaptcha/api.js"></script>',
      'google'
    ),
    false
  );
  assert.equal(isBlockedPage('<div class="g-recaptcha"></div>', 'google'), true);
  assert.equal(
    challenge.detectChallenge({
      url: 'https://www.google.com/search?q=hello',
      html: '<h3>Hello</h3><cite>https://en.wikipedia.org/wiki/Hello</cite><div class="g-recaptcha"></div>',
    }),
    null
  );
  const recapOnly = challenge.detectChallenge({
    url: 'https://www.google.com/search?q=hello',
    html: '<div class="g-recaptcha"></div>',
  });
  assert.equal(recapOnly.code, 'BLOCKED');
  assert.equal(recapOnly.type, 'recaptcha');
});

test('proxy chain parses hops and uses the last hop as Chromium egress', () => {
  const chain = proxyChain.parseChain('http://dc:1@a:8080 -> http://resi:2@b:8000');
  assert.equal(chain.length, 2);
  assert.match(chain.egress, /b:8000/);
  assert.equal(proxyChain.chromiumProxy(chain), chain.egress);
  assert.equal(proxyChain.describe(chain).chained, true);
  assert.equal(proxyChain.parseChain(''), null);
});

test('intent classifies buy vs how-to vs url queries', () => {
  assert.equal(intent.classify('buy cheap checkout cart').intent, 'transactional');
  assert.equal(intent.classify('how to reset a router').intent, 'informational');
  assert.equal(intent.classify('https://example.com login').intent, 'navigational');
  process.env.INTENT_ROUTING = '1';
  const r = intent.preferEngines('buy shoes', ['mojeek']);
  assert.equal(r.list[0], 'google');
  assert.ok(r.list.includes('mojeek'));
  delete process.env.INTENT_ROUTING;
});

test('selector healer harvests http anchors when organic parse is empty', () => {
  assert.equal(heal.needsHeal([]), true);
  const html = '<a href="https://shop.example.com/a">Alpha Store</a><a href="/rel">x</a>';
  const out = heal.harvest(html, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://shop.example.com/a');
  assert.equal(out[0].healed, true);
  assert.ok(heal.fallbackSelectors().includes('h3.LC20lb'));
});

test('sandbox blocks private hosts and file schemes', () => {
  assert.equal(sandbox.inspectUrl('http://127.0.0.1/').ok, false);
  assert.equal(sandbox.inspectUrl('http://10.0.0.5/x').reason, 'private');
  assert.equal(sandbox.inspectUrl('file:///etc/passwd').ok, false);
  assert.equal(sandbox.inspectUrl('https://example.com/a').ok, true);
  const q = sandbox.inspectQuery('site:127.0.0.1 index of');
  assert.equal(q.ok, false);
});

test('geo inject maps gl and proxy lat/lng', () => {
  const us = geo.coordsFor({ gl: 'us' });
  assert.ok(us.latitude);
  const gb = geo.fromCountry('gb');
  assert.notEqual(gb.latitude, us.latitude);
  const p = geo.coordsFor({ proxy: 'http://x:1@host:80?lat=40.7&lng=-74.0' });
  assert.equal(p.latitude, 40.7);
  assert.equal(geo.parseCoords('91,0'), null);
});

test('media blocker drops video and trackers but can keep small images', () => {
  assert.equal(media.shouldAbort({ url: 'https://cdn.example/a.mp4', resourceType: 'media' }), 'video');
  assert.equal(media.shouldAbort({ url: 'https://www.google-analytics.com/g.js', resourceType: 'script' }), 'tracker');
  const prev = process.env.BLOCK_IMAGES;
  process.env.BLOCK_IMAGES = '1';
  assert.equal(media.shouldAbort({ url: 'https://x/a.png', resourceType: 'image' }), 'image');
  if (prev === undefined) delete process.env.BLOCK_IMAGES;
  else process.env.BLOCK_IMAGES = prev;
});

test('llm parse stays off without USER_LLM_PARSE_URL', async () => {
  delete process.env.LLM_PARSE;
  delete process.env.USER_LLM_PARSE_URL;
  assert.equal(llm.enabled(), false);
  assert.equal(await llm.extract('<a href="https://x">x</a>'), null);
});

test('cluster sync stores short-lived node state in memory', () => {
  cluster.reset();
  cluster.set('cookies', { n: 1 }, 1000);
  assert.deepEqual(cluster.get('cookies'), { n: 1 });
  assert.equal(cluster.snapshot().backend, 'memory');
  cluster.reset();
  assert.equal(cluster.get('cookies'), null);
});

test('tenant keys support rpm and reject unknown tokens', () => {
  tenant.reset();
  const prev = process.env.API_TOKEN;
  process.env.API_TOKEN = 'sekret:12|search';
  const bad = tenant.authorize({ headers: {}, query: {} });
  assert.equal(bad.ok, false);
  const ok = tenant.authorize({ headers: { authorization: 'Bearer sekret' }, query: {} }, 'search');
  assert.equal(ok.ok, true);
  if (prev === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = prev;
  tenant.reset();
});

test('ndjson stream writer emits meta then rows', () => {
  const chunks = [];
  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(s) {
      chunks.push(s);
    },
    end(s) {
      if (s) chunks.push(s);
    },
  };
  stream.writeNdjson(res, { success: true, results: [{ url: 'https://a' }] });
  assert.match(chunks[0], /"type":"meta"/);
  assert.match(chunks[1], /"type":"result"/);
  assert.match(chunks.join(''), /"type":"end"/);
  assert.equal(stream.wantsStream({ query: { stream: '1' }, headers: {} }), true);
});

test('redis cache wrapper falls back to memory and reports backend', () => {
  const c = redis.wrap();
  c.set('k', { v: 1 });
  assert.deepEqual(c.get('k'), { v: 1 });
  assert.equal(c.stats().backend, 'memory');
});

test('work queue serializes over concurrency and times out', async () => {
  queue.reset();
  process.env.QUEUE_CONCURRENCY = '1';
  process.env.QUEUE_WAIT_MS = '20';
  let parallel = 0;
  let max = 0;
  await Promise.all([
    queue.run(async () => {
      parallel += 1;
      max = Math.max(max, parallel);
      await new Promise((r) => setTimeout(r, 5));
      parallel -= 1;
    }),
    queue.run(async () => {
      parallel += 1;
      max = Math.max(max, parallel);
      await new Promise((r) => setTimeout(r, 5));
      parallel -= 1;
    }),
  ]);
  assert.equal(max, 1);
  delete process.env.QUEUE_CONCURRENCY;
  delete process.env.QUEUE_WAIT_MS;
  queue.reset();
});

test('fd tuner suggests a nofile floor from workers', () => {
  const n = fd.suggested();
  assert.ok(n >= 256);
  assert.equal(fd.apply().applied, false);
});

test('feature flags keep solvers and canvas/mouse jitter off', () => {
  const f = features.list();
  assert.equal(f.captcha_block, true);
  assert.equal(f.captcha_solver, false);
  assert.equal(f.captcha_surface, false);
  assert.equal(f.captcha_rotate, true);
  assert.equal(f.ua_page_mask, true);
  assert.equal(f.turnstile_solver, false);
  assert.equal(f.canvas_mutate, false);
  assert.equal(f.mouse_bezier, false);
  assert.equal(f.selector_heal, true);
  assert.equal(f.maps_shopping, true);
  assert.equal(route('/api/dashboard'), require('../api/dashboard'));
});

test('ua mask strips HeadlessChrome and fills page + client-hint profile', () => {
  const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36';
  assert.equal(uaMask.sanitizeUa(raw).includes('Headless'), false);
  assert.match(uaMask.sanitizeUa(raw), /Chrome\/155/);
  const p = uaMask.profileFrom({ ua: raw, flavorId: 'chromium', langs: ['en-US', 'en'] });
  assert.equal(p.ua.includes('Headless'), false);
  assert.equal(p.platform, 'Win32');
  assert.equal(p.vendor, 'Google Inc.');
  assert.equal(p.mobile, false);
  assert.equal(p.brands[0].brand, 'Google Chrome');
  const h = uaMask.chHeaders(p);
  assert.match(h['sec-ch-ua'], /Google Chrome/);
  assert.equal(h['sec-ch-ua-mobile'], '?0');
  assert.equal(h['sec-ch-ua-platform'], '"Windows"');
  assert.match(h['sec-ch-ua-full-version-list'], /155\.0\.0\.0/);
  const ff = uaMask.profileFrom({ ua: uaMask.sanitizeUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'), flavorId: 'firefox' });
  assert.equal(Object.keys(uaMask.chHeaders(ff)).length, 0);
  assert.ok(FIXES.includes('ua_page_mask'));
  assert.ok(FIXES.includes('ua_worker_mask'));
});

test('ua mask apply covers page navigator, uaData, workers, no canvas or mouse', () => {
  const src = uaMask.apply.toString();
  assert.doesNotMatch(src, /toDataURL|getImageData|bezier|mouseMove|dispatchEvent/);
  assert.match(src, /userAgent/);
  assert.match(src, /userAgentData/);
  assert.match(src, /webdriver/);
  assert.match(src, /Worker/);
  assert.match(src, /chrome/);
  assert.match(src, /plugins/);
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  const profile = uaMask.profileFrom({ ua, flavorId: 'chromium' });
  const root = {
    navigator: {
      userAgent: 'HeadlessChrome/1',
      appVersion: '5.0 Headless',
      vendor: '',
      platform: 'Linux x86_64',
      language: 'fr',
      languages: ['fr'],
      hardwareConcurrency: 2,
      deviceMemory: 2,
      maxTouchPoints: 1,
      plugins: { length: 0 },
      webdriver: true,
    },
    Navigator: function Navigator() {},
  };
  root.Navigator.prototype = {};
  root.window = root;
  const origThis = globalThis;
  const applyWithRoot = Function(
    'profile',
    'root',
    `const globalThis = root; const self = root; const window = root; const navigator = root.navigator; const Navigator = root.Navigator; (${src})(profile);`
  );
  applyWithRoot(profile, root);
  assert.equal(root.navigator.userAgent, ua);
  assert.equal(root.navigator.webdriver, undefined);
  assert.equal(root.navigator.platform, 'Win32');
  assert.equal(root.navigator.vendor, 'Google Inc.');
  assert.equal(root.navigator.language, 'en-US');
  assert.deepEqual([...root.navigator.languages], ['en-US', 'en']);
  assert.equal(root.navigator.userAgentData.platform, 'Windows');
  assert.equal(root.navigator.userAgentData.mobile, false);
  assert.ok(root.chrome.runtime);
  assert.equal(typeof root.chrome.loadTimes, 'function');
  void origThis;
});

test('google extraHeaders stay off by default so lite HTTP is not fingerprint-blocked', () => {
  const h = extraHeaders({ acceptLanguage: 'en-US,en;q=0.9' }, 155);
  assert.equal(h['User-Agent'], undefined);
  assert.equal(h['sec-ch-ua'], undefined);
  assert.equal(h['sec-ch-ua-full-version'], undefined);
  const prev = process.env.GOOGLE_CH_UA;
  process.env.GOOGLE_CH_UA = '1';
  try {
    const on = extraHeaders({ acceptLanguage: 'en-US,en;q=0.9' }, 155);
    assert.match(on['sec-ch-ua'], /Google Chrome";v="155"/);
    assert.equal(on['sec-ch-ua-mobile'], '?0');
    assert.equal(on['sec-ch-ua-platform'], '"Windows"');
    assert.equal(on['sec-ch-ua-full-version'], undefined);
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_CH_UA;
    else process.env.GOOGLE_CH_UA = prev;
  }
});

test('google_lite HTTP headers match the pre-mask Chrome set', () => {
  const { chromeHeaders } = require('../api/lib/lite');
  const h = chromeHeaders(new URL('https://www.google.com/search?q=hello'));
  assert.match(h['user-agent'], /Chrome\/155/);
  assert.doesNotMatch(h['user-agent'], /Headless/);
  assert.equal(h['sec-ch-ua'], '"Google Chrome";v="155", "Chromium";v="155", "Not.A/Brand";v="24"');
  assert.equal(h['sec-ch-ua-mobile'], '?0');
  assert.equal(h['sec-ch-ua-platform'], '"Windows"');
  assert.equal(h['sec-ch-ua-full-version'], undefined);
  assert.equal(h['sec-ch-ua-full-version-list'], undefined);
  assert.match(h.cookie, /CONSENT=YES/);
});

test('chrome fetch keeps organic SERPs even when recaptcha scripts are present', () => {
  const page = { url: () => 'https://www.google.com/search?q=hello', _lastTitle: 'hello - Google Search' };
  const serp =
    '<h3>Hello world</h3><cite>https://en.wikipedia.org/wiki/Hello_world</cite>' +
    '<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha"></div>';
  assert.equal(chromeFetch.hasOrganicHits(serp), true);
  assert.equal(chromeFetch.isBlocked('google', page, serp), false);
  assert.equal(chromeFetch.isBlocked('google', page, '<div class="g-recaptcha"></div>'), true);
  const sorry = { url: () => 'https://www.google.com/sorry/index?continue=x', _lastTitle: '' };
  assert.equal(chromeFetch.isBlocked('google', sorry, serp), true);
  assert.equal(chromeFetch.fetchOn(), true);
  const src = chromeFetch.fetchHtml.toString();
  assert.doesNotMatch(src, /NO_PROXY/);
  assert.doesNotMatch(src, /no proxy/);
});
