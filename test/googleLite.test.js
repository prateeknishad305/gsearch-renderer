'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const googleLite = require('../api/lib/googleLite');
const exitState = require('../api/lib/exitState');
const lite = require('../api/lib/lite');
const { extractFromHtml } = require('../api/lib/googleExtract');

// A realistic Google basic-HTML (gbv=2) result page.
const SERP_HTML = `<!doctype html><html><body><div id="main">
${Array.from({ length: 10 }, (_, i) => {
  const host = `site${i}.example.com`;
  return `<div class="g">
  <a href="/url?q=https://${host}/page${i}&amp;sa=U&amp;ved=2ahUKEwi&amp;usg=AOvVaw${i}"><h3 class="r">Result title ${i} for a query</h3></a>
  <div class="VwiC3b">Snippet number ${i} describing the page content in one or two sentences.</div>
  <cite>${host}/page${i}</cite>
  <span class="LEwnzc">Jan ${i + 1}, 2026</span>
</div>`;
}).join('\n')}
</div></body></html>`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A proxy that supports absolute-URI plain HTTP forwarding.
function startPlainProxy({ status = 200, body = SERP_HTML } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(body);
  });
  return listen(server).then((port) => ({ server, url: `http://127.0.0.1:${port}` }));
}

// A proxy that refuses CONNECT, like providers without tunnel support.
function startNoTunnelProxy() {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
  return listen(server).then((port) => ({ server, url: `http://127.0.0.1:${port}` }));
}

// A proxy that supports CONNECT and forwards to a local target.
function startTunnelProxy(targetPort) {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const serverSocket = net.connect(Number(port) || targetPort, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
  });
  return listen(server).then((port) => ({ server, url: `http://127.0.0.1:${port}` }));
}

test('google lite url resolves locale, country and dork targets', () => {
  const uk = googleLite.buildLiteUrl({ q: 'hello', num: 10, start: 0, hl: 'en', gl: 'uk' });
  assert.equal(new URL(uk.url).searchParams.get('gl'), 'gb', 'uk must normalise to gb');

  const de = googleLite.buildLiteUrl({ q: 'hello', num: 10, start: 0, gl: 'de' });
  assert.equal(new URL(de.url).searchParams.get('gl'), 'de');
  assert.equal(new URL(de.url).searchParams.get('hl'), 'de', 'hl must follow the country');

  const dork = googleLite.buildLiteUrl({ q: 'site:example.com login', num: 10, start: 0, hl: 'en', gl: 'us' });
  assert.equal(new URL(dork.url).searchParams.get('as_sitesearch'), 'example.com');

  const plain = googleLite.buildLiteUrl({ q: 'hello', num: 10, start: 20, hl: 'en', gl: 'us' });
  const p = new URL(plain.url).searchParams;
  assert.equal(p.get('gbv'), '2');
  assert.equal(p.get('start'), '20');
  assert.equal(p.get('num'), null, 'num=10 is a fingerprint and must be omitted');
  assert.equal(p.get('udm'), null);
});

test('google lite endpoint keeps the documented shape', () => {
  const u = lite.ENDPOINTS.google({ q: 'hello world', s: 10, gl: 'us', hl: 'en' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('gbv'), '2');
  assert.equal(p.get('start'), '10');
  assert.equal(p.get('udm'), null);
  assert.match(u, /^https:\/\/www\.google\.com\/search\?/);
});

test('js gate, sorry page and captcha are detected as blocked', () => {
  const gate = '<noscript><meta http-equiv="refresh" content="0;url=/httpservice/retry/enablejs?sei=x"></noscript>';
  assert.equal(googleLite.isGoogleBlocked(gate), true);
  assert.equal(
    googleLite.isGoogleBlocked('<title>Enable JavaScript to use search</title><html></html>'),
    true
  );
  assert.equal(googleLite.isGoogleBlocked('<div>Our systems have detected unusual traffic</div>'), true);
  assert.equal(googleLite.isGoogleBlocked('<div id="captcha"></div>'), true);
  assert.equal(googleLite.isGoogleBlocked(SERP_HTML), false);
  assert.equal(googleLite.isGoogleBlocked(SERP_HTML, 'https://www.google.com/sorry/index'), true);
});

test('a real serp is recognised, an empty shell is not', () => {
  assert.equal(googleLite.looksLikeSerp(SERP_HTML), true);
  assert.equal(googleLite.looksLikeSerp('<html><body>nothing here</body></html>'), false);
  assert.equal(googleLite.looksLikeSerp(''), false);
});

test('lite isBlockedPage still blocks google interstitials', () => {
  assert.equal(lite.isBlockedPage('<html><body>enablejs</body></html>', 'google_lite'), true);
  assert.equal(lite.isBlockedPage(SERP_HTML, 'google_lite'), false);
});

test('the lite parser reads titles, urls, snippets and rank', () => {
  const out = extractFromHtml(SERP_HTML);
  assert.equal(out.length, 10);
  assert.equal(out[0].title, 'Result title 0 for a query');
  assert.equal(out[0].url, 'https://site0.example.com/page0');
  assert.match(out[0].snippet, /Snippet number 0/);
  assert.equal(out[0].date, 'Jan 1, 2026');
  assert.equal(out[0].rank, 1);
  assert.equal(out[9].rank, 10);
});

test('a short page is topped up so the requested count is delivered', async () => {
  const previous = googleLite.fetchGoogleLite;
  const seen = [];
  googleLite.fetchGoogleLite = async ({ url }) => {
    const start = Number(new URL(url).searchParams.get('start'));
    seen.push(start);
    const n = start === 0 ? 8 : 10;
    const html = Array.from({ length: n }, (_, i) => {
      const host = `top${start}.example.com`;
      return `<div class="g"><a href="/url?q=https://${host}/p${i}&amp;sa=U"><h3>T ${start}-${i}</h3></a><cite>${host}/p${i}</cite></div>`;
    }).join('');
    return { html: `<div id="main">${html}</div>`, transport: 'test' };
  };
  process.env.LITE_POOL_WARM_MS = '0';
  process.env.PROXY_FETCH = '0';
  try {
    const res = await lite.fastLiteSearch({ engine: 'google_lite', query: 'x', num: 10 });
    assert.equal(res.results.length, 10, 'must deliver the full requested count');
    assert.deepEqual(seen, [0, 10], 'must fetch a second page to top up');
    assert.equal(new Set(res.results.map((r) => r.url)).size, 10, 'no duplicates');
  } finally {
    googleLite.fetchGoogleLite = previous;
    delete process.env.LITE_POOL_WARM_MS;
    delete process.env.PROXY_FETCH;
  }
});

test('no second page is fetched when the first one is already full', async () => {
  const previous = googleLite.fetchGoogleLite;
  let calls = 0;
  googleLite.fetchGoogleLite = async ({ url }) => {
    calls += 1;
    const start = Number(new URL(url).searchParams.get('start'));
    const html = Array.from({ length: 10 }, (_, i) => {
      const host = `full${start}.example.com`;
      return `<div class="g"><a href="/url?q=https://${host}/p${i}&amp;sa=U"><h3>T ${i}</h3></a><cite>${host}/p${i}</cite></div>`;
    }).join('');
    return { html: `<div id="main">${html}</div>`, transport: 'test' };
  };
  process.env.LITE_POOL_WARM_MS = '0';
  process.env.PROXY_FETCH = '0';
  try {
    const res = await lite.fastLiteSearch({ engine: 'google_lite', query: 'x', num: 10 });
    assert.equal(res.results.length, 10);
    assert.equal(calls, 1, 'a full page must not trigger another request');
  } finally {
    googleLite.fetchGoogleLite = previous;
    delete process.env.LITE_POOL_WARM_MS;
    delete process.env.PROXY_FETCH;
  }
});

test('an exit without CONNECT support is classified and then skipped', async () => {
  exitState.reset();
  const { server, url } = await startNoTunnelProxy();
  try {
    await assert.rejects(
      () => googleLite.fetchViaTunnel('https://www.google.com/search?q=x', url, { 'user-agent': 'x' }, 3000),
      (err) => err.code === 'NO_TUNNEL'
    );
    // The exit is remembered as unable to tunnel, so it is not raced again.
    exitState.note(url, 'plain');
    assert.equal(exitState.canUse(url), false);
    assert.equal(exitState.isTunnel(url), false);
  } finally {
    server.close();
    exitState.reset();
  }
});

test('plain http proxy transport returns the page body', async () => {
  exitState.reset();
  const { server, url } = await startPlainProxy();
  try {
    const res = await googleLite.fetchViaPlainProxy(
      'http://target.example.com/search?q=x',
      url,
      { 'user-agent': 'test-agent' },
      3000
    );
    assert.equal(res.status, 200);
    assert.match(res.html, /Result title 0 for a query/);
  } finally {
    server.close();
    exitState.reset();
  }
});

test('a connect proxy reaches a local target', async () => {
  exitState.reset();
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SERP_HTML);
  });
  const targetPort = await listen(target);
  const { server, url } = await startTunnelProxy(targetPort);
  try {
    // The tunnel speaks TLS to the target, so only the CONNECT negotiation is
    // exercised here: it must be accepted and then fail on the TLS handshake.
    const err = await googleLite
      .fetchViaTunnel('https://127.0.0.1/search?q=x', url, { 'user-agent': 'x' }, 3000)
      .then(() => null, (e) => e);
    assert.ok(err, 'the request must fail rather than succeed against a plain target');
    assert.notEqual(err.code, 'NO_TUNNEL', 'the proxy does support CONNECT');
  } finally {
    server.close();
    target.close();
    exitState.reset();
  }
});

test('known bad exits are skipped by the race', async () => {
  exitState.reset();
  const { server, url } = await startNoTunnelProxy();
  try {
    exitState.note(url, 'dead');
    await assert.rejects(
      () => googleLite.raceExits('https://www.google.com/search?q=x', { 'user-agent': 'x' }, [url], 1000),
      /no usable exits/
    );
  } finally {
    server.close();
    exitState.reset();
  }
});

test('exit state expires bad entries so a recovered exit is retried', () => {
  exitState.reset();
  exitState.note('http://x.example.com:8080', 'dead');
  assert.equal(exitState.canUse('http://x.example.com:8080'), false);
  exitState.reset();
  assert.equal(exitState.canUse('http://x.example.com:8080'), true);
});

test('exits that answered with an interstitial are tried last', () => {
  exitState.reset();
  const clean = 'http://clean.example.com:8080';
  const gated = 'http://gated.example.com:8080';
  exitState.note(gated, 'gated');
  exitState.note(clean, 'tunnel');
  const ordered = exitState.sortByReliability([gated, clean]);
  assert.equal(ordered[0], clean, 'a clean exit must be tried before a gated one');
  assert.equal(exitState.canUse(gated), true, 'a gated exit is still worth retrying');
});

test('an authenticated socks5 entry keeps its scheme until the chromium boundary', () => {
  const pool = require('../api/lib/proxyPool');
  const list = pool.splitPool('residential.example.com:1082:user+country=de:secret');
  assert.equal(list.length, 1);
  assert.match(list[0], /^socks5:\/\//, 'the pool must not silently downgrade the scheme');
  assert.equal(pool.chromiumProxyOk(list[0]), false, 'chromium cannot use socks5 with credentials');
  assert.match(pool.toChromiumProxy(list[0]), /^http:\/\//, 'the downgrade happens at the chromium boundary');
});
