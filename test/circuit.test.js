'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const circuit = require('../api/lib/circuit');
const { PARSERS, ENDPOINTS, isBlockedPage, isJsShell, chromeFetchTargets, chromeFetchDirectOk } = require('../api/lib/lite');

test('circuit opens after consecutive failures and closes on OK', () => {
  circuit.reset();
  const name = 'circuit_test_engine';
  for (let i = 0; i < circuit.OPEN_AFTER; i++) circuit.record(name, 'BLOCKED');
  assert.equal(circuit.isOpen(name), true);
  circuit.record(name, 'OK');
  assert.equal(circuit.isOpen(name), false);
  circuit.reset();
});

test('lite parsers extract organic urls from sample html', () => {
  const bing = PARSERS.bing('<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">Alpha</a></h2></li></ol>');
  assert.equal(bing.length, 1);
  assert.equal(bing[0].url, 'https://example.com/a');
  const yahoo = PARSERS.yahoo('<h3><a href="https://search.yahoo.com/RU=https%3A%2F%2Fnews.example%2Fx/RK=2">News</a></h3>');
  assert.ok(yahoo.length >= 1);
  assert.equal(yahoo[0].url, 'https://news.example/x');
  const ddg = PARSERS.duckduckgo('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fz">Zed</a></div>');
  assert.ok(ddg.some((r) => r.url === 'https://example.org/z'));
});

test('lite endpoints exist for extra engines', () => {
  for (const name of ['bing', 'brave', 'mojeek', 'yahoo', 'ecosia', 'startpage', 'duckduckgo', 'duckduckgo_lite', 'google', 'archive', 'wikipedia', 'github', 'wiby', 'qwant', 'yandex']) {
    assert.equal(typeof ENDPOINTS[name], 'function', name);
  }
});

test('archive lite uses advancedsearch json and parses docs', () => {
  const u = ENDPOINTS.archive({ q: 'hello world', s: 10, num: 10 });
  const parsed = new URL(u);
  assert.match(parsed.href, /archive\.org\/advancedsearch\.php/);
  assert.equal(parsed.searchParams.get('output'), 'json');
  assert.equal(parsed.searchParams.get('page'), '2');
  assert.equal(parsed.searchParams.get('rows'), '10');
  const json = JSON.stringify({
    response: {
      docs: [
        { identifier: 'hello_world', title: 'Hello World', description: 'An item' },
        { identifier: 'skip/me', title: 'Bad' },
      ],
    },
  });
  const out = PARSERS.archive(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://archive.org/details/hello_world');
  assert.equal(out[0].title, 'Hello World');
  assert.equal(out[0].snippet, 'An item');
});

test('wikipedia lite uses opensearch json', () => {
  const u = ENDPOINTS.wikipedia({ q: 'hello world', hl: 'en', num: 10 });
  const parsed = new URL(u);
  assert.match(parsed.href, /en\.wikipedia\.org\/w\/api\.php/);
  assert.equal(parsed.searchParams.get('action'), 'opensearch');
  assert.equal(parsed.searchParams.get('search'), 'hello world');
  const body = JSON.stringify([
    'hello world',
    ['Hello, world', 'Hello World (film)'],
    ['A greeting', 'A film'],
    ['https://en.wikipedia.org/wiki/Hello,_world', 'https://en.wikipedia.org/wiki/Hello_World_(film)'],
  ]);
  const out = PARSERS.wikipedia(body);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://en.wikipedia.org/wiki/Hello,_world');
  assert.equal(out[0].title, 'Hello, world');
  assert.equal(out[0].snippet, 'A greeting');
});

test('github lite parser reads search-title repo links', () => {
  const html =
    '<div class="search-title title__x"><a class="prc-Link-Link" href="/octocat/Hello-World"><span>octocat/Hello-World</span></a></div>' +
    '<div class="search-title"><a href="/login/signup">skip</a></div>';
  const out = PARSERS.github(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://github.com/octocat/Hello-World');
  assert.equal(out[0].title, 'octocat/Hello-World');
  const u = ENDPOINTS.github({ q: 'language', s: 10 });
  assert.equal(new URL(u).searchParams.get('p'), '2');
});

test('wiby lite parser reads tlink anchors', () => {
  const html = '<blockquote><a class="tlink" href="http://example.com/">Hello</a></blockquote>';
  const out = PARSERS.wiby(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'http://example.com/');
  assert.equal(out[0].title, 'Hello');
});

test('mojeek lite uses web search and parses a.ob', () => {
  const u = ENDPOINTS.mojeek({ q: 'hello world', s: 0 });
  assert.match(u, /mojeek\.com\/search/);
  assert.doesNotMatch(u, /\/news/);
  const html = '<ul class="results-standard"><li><a class="ob" href="https://example.com/a">Alpha</a></li></ul>';
  const out = PARSERS.mojeek(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://example.com/a');
  assert.equal(out[0].title, 'Alpha');
});

test('captcha and anti-bot html is blocked for mojeek qwant yandex', () => {
  assert.equal(isBlockedPage('<title>Captcha</title><script src="/js/vendor/altcha.js"></script>', 'mojeek'), true);
  assert.equal(isBlockedPage('<title>Service unavailable</title><p>Prove you are human</p>', 'qwant'), true);
  assert.equal(isBlockedPage('<title>Are you not a robot?</title><div class="smartcaptcha"></div>', 'yandex'), true);
  assert.equal(isBlockedPage('<ul class="results-standard"><li><a class="ob" href="https://example.com/a">Alpha</a></li></ul>', 'mojeek'), false);
  const q = ENDPOINTS.qwant({ q: 'hello', hl: 'en', s: 10 });
  assert.match(q, /qwant\.com/);
  assert.equal(new URL(q).searchParams.get('offset'), '10');
  const y = ENDPOINTS.yandex({ q: 'hello', s: 10 });
  assert.match(y, /yandex\.com\/search/);
  assert.equal(new URL(y).searchParams.get('p'), '1');
});

test('google js-shell html is blocked so chrome-fetch can run', () => {
  const shell =
    '<!DOCTYPE html><html><head><title>Google</title>' +
    '<noscript><meta http-equiv="refresh" content="0;url=/httpservice/retry/enablejs?continue=/search"></noscript>' +
    '</head><body><script>window.google=window.google||{};</script></body></html>';
  assert.equal(isJsShell(shell), true);
  assert.equal(isBlockedPage(shell, 'google'), true);
  assert.equal(isBlockedPage(shell, 'google_lite'), true);
  const serp = '<h3 class="r"><a href="/url?q=https://example.com/a">Alpha</a></h3><cite>example.com</cite>';
  assert.equal(isJsShell(serp), false);
  assert.equal(isBlockedPage(serp, 'google'), false);
});

test('google recaptcha widget on a real SERP is not a block', () => {
  const serp =
    '<h3 class="r"><a href="/url?q=https://en.wikipedia.org/wiki/Hello">Hello</a></h3>' +
    '<cite>https://en.wikipedia.org/wiki/Hello</cite>' +
    '<script src="https://www.google.com/recaptcha/api.js"></script>' +
    '<div class="g-recaptcha" data-sitekey="x"></div>';
  assert.equal(isBlockedPage(serp, 'google'), false);
  assert.equal(isBlockedPage(serp, 'google_lite'), false);
  assert.equal(isBlockedPage('<div class="g-recaptcha"></div>', 'google'), true);
  assert.equal(isBlockedPage('<div id="captcha"></div>', 'google'), true);
  assert.equal(isBlockedPage('<h3>Ok</h3><div id="captcha"></div>', 'google'), false);
});

test('chrome fetch falls back to a direct (no proxy) attempt', () => {
  const prev = process.env.PROXY_FALLBACK_DIRECT;
  delete process.env.PROXY_FALLBACK_DIRECT;
  try {
    assert.equal(chromeFetchDirectOk(), true);
    const targets = chromeFetchTargets('google_lite');
    assert.ok(targets.includes(null), 'direct hop must be present');
  } finally {
    if (prev === undefined) delete process.env.PROXY_FALLBACK_DIRECT;
    else process.env.PROXY_FALLBACK_DIRECT = prev;
  }
});

test('chrome fetch skips the direct hop when PROXY_FALLBACK_DIRECT=0 and proxies exist', () => {
  const prev = process.env.PROXY_FALLBACK_DIRECT;
  process.env.PROXY_FALLBACK_DIRECT = '0';
  try {
    assert.equal(chromeFetchDirectOk(), false);
  } finally {
    if (prev === undefined) delete process.env.PROXY_FALLBACK_DIRECT;
    else process.env.PROXY_FALLBACK_DIRECT = prev;
  }
});

test('google lite parser reads h3/url?q=', () => {
  const html =
    '<h3 class="r"><a href="/url?q=https://en.wikipedia.org/wiki/Hello_world&amp;sa=U">Hello world</a></h3>' +
    '<a href="/url?q=https://www.google.com/search"><h3>Skip me</h3></a>';
  const out = PARSERS.google(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://en.wikipedia.org/wiki/Hello_world');
  assert.equal(out[0].title, 'Hello world');
  const u = ENDPOINTS.google({ q: 'hello world', s: 10, gl: 'us', hl: 'en' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('gbv'), '2');
  assert.equal(p.get('start'), '10');
  assert.equal(p.get('udm'), null);
});

test('google extract unwraps absolute /url?url= and keeps full path', () => {
  const { decodeGoogleHref, extractFromHtml } = require('../api/lib/googleExtract');
  assert.equal(
    decodeGoogleHref('https://www.google.com/url?url=https://shop.example.com/cart/checkout&sa=t'),
    'https://shop.example.com/cart/checkout'
  );
  assert.equal(
    decodeGoogleHref('/url?q=https%3A%2F%2Fshop.example.com%2Fcart%2Fcheckout&sa=U'),
    'https://shop.example.com/cart/checkout'
  );
  const html =
    '<div class="g"><a href="https://www.google.com/url?url=https://shop.example.com/cart/checkout&amp;sa=t"><h3>Checkout</h3></a>' +
    '<cite>https://shop.example.com › cart › checkout</cite></div>';
  const out = extractFromHtml(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://shop.example.com/cart/checkout');
});

test('google extract keeps h3 href when cite is missing', () => {
  const { extractFromHtml } = require('../api/lib/googleExtract');
  const html = '<a href="/url?q=https://shop.example.com/cart/checkout"><h3>Checkout</h3></a>';
  const out = extractFromHtml(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://shop.example.com/cart/checkout');
});

test('google extract recovers Index of path from title when cite is truncated', () => {
  const { extractFromHtml } = require('../api/lib/googleExtract');
  const html =
    '<div class="g"><a href="https://www.google.com/url?url=https://www.vaughn.edu/wp-content/backup&amp;sa=t" ping="/url?url=https://www.vaughn.edu/wp-content/uploads/backup">' +
    '<h3>Index of /wp-content/uploads/backup</h3></a>' +
    '<cite>https://www.vaughn.edu › wp-content › backup</cite></div>';
  const out = extractFromHtml(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://www.vaughn.edu/wp-content/uploads/backup');
});
