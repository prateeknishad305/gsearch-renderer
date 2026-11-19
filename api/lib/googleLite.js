'use strict';

// Hardened Google "lite" (plain-HTTP) transport.
//
// The plain-HTTP Google path is the cheapest way to get a real SERP, but the
// original implementation had three problems that made it look "blocked" and
// slow:
//
//   1. It ignored the geo/locale resolution the Chromium path already used, so
//      `gl=uk` was sent as the invalid `gl=uk`, `hl` was never derived from the
//      country, and site: dorks were never turned into `as_sitesearch`.
//   2. It never topped up a short page, so a request for 10 results could
//      silently return 8.
//   3. It raced a fixed set of exits on every call, including exits that had
//      already been proven unable to reach Google. Every request paid the full
//      timeout again for the same dead exits.
//
// This module fixes all three: geo-correct URLs, a transport ladder that fails
// fast, and a per-exit capability memory (see exitState.js).

const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const { URL } = require('url');

const g = require('./google');
const exitState = require('./exitState');
const { buildTbs } = require('./googleExtract');
const { parseDork, isHostSiteTarget } = require('./dork');

const CHROME_MAJOR = '155';
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not.A/Brand";v="24"`;

// Google's JS gate: the page it serves to clients that cannot run JavaScript.
// It is not a captcha, it is a "please enable JS" shell, and it must never be
// mistaken for a result page.
const JS_GATE =
  /enablejs|httpservice\/retry|if you are not redirected|table,div,span,p\{display:none\}|window\.google\.c\s*=\s*window\.google\.c/i;

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function boolEnv(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  return raw !== '0' && String(raw).toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// URL + headers
// ---------------------------------------------------------------------------

// Builds a geo-correct Google lite URL. Mirrors google.buildSearchUrl so the
// plain-HTTP path and the Chromium path target exactly the same SERP.
function buildLiteUrl({ q, num = 10, start = 0, hl, gl, tbs, before, after, proxy } = {}) {
  const geo = g.resolveGeo({ gl, hl, proxy });
  const query = g.normalizeQuery(q);
  const p = new URLSearchParams();
  p.set('q', query);
  p.set('hl', geo.hl);
  p.set('gl', geo.gl);
  p.set('start', String(Math.max(0, Number(start) || 0)));
  // gbv=2 is Google's basic-HTML surface: it is a much smaller page, it does
  // not need JavaScript to contain the results, and it is far cheaper to parse.
  p.set('gbv', '2');
  const n = Math.min(10, Math.max(1, Number(num) || 10));
  // Google ignores num=10 and the parameter itself is a fingerprint, so it is
  // only sent when it actually changes the page size.
  if (n !== 10) p.set('num', String(n));
  const targets = parseDork(query).site_targets.filter(isHostSiteTarget);
  if (targets.length === 1) p.set('as_sitesearch', targets[0]);
  const tbsVal = buildTbs({ tbs, before, after });
  if (tbsVal) p.set('tbs', tbsVal);
  return { url: `https://${geo.host}/search?${p.toString()}`, geo };
}

function liteHeaders(geo, extra) {
  const h = {
    'user-agent': UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': (geo && geo.acceptLanguage) || 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  };
  const stamp = Date.now().toString(36);
  h.cookie = `CONSENT=YES+cb.20210328-17-p0.en+FX+${stamp}; SOCS=CAI`;
  return Object.assign(h, extra || {});
}

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

// True when the response is a Google interstitial (JS gate, sorry page,
// captcha, consent wall) rather than a result page.
function isGoogleBlocked(html, finalUrl) {
  const raw = String(html || '');
  const low = raw.toLowerCase();
  const url = String(finalUrl || '');
  if (/\/sorry\/|\/recaptcha\/|\/consent\?/i.test(url)) return true;
  if (/\/sorry\/|\/recaptcha\/|id="captcha"|g-recaptcha/i.test(raw)) return true;
  if (JS_GATE.test(raw)) return true;
  if (/<title>\s*enable javascript to use search\s*<\/title>/i.test(raw)) return true;
  if (/unusual traffic|our systems have detected|to continue, please type the characters/i.test(low)) return true;
  // A consent wall is a distinct page from the SERP. Real result pages carry
  // <h3>/<cite> markers, so those win over a stray "consent" mention.
  if (!/<h3/i.test(raw) && /consent\.google\.com|before you continue to google/i.test(raw)) return true;
  return false;
}

// True when the payload actually carries organic results. Used to tell "we
// were blocked" apart from "the query legitimately matched nothing".
function looksLikeSerp(html) {
  const raw = String(html || '');
  if (!raw) return false;
  const h3 = (raw.match(/<h3/gi) || []).length;
  const urlq = (raw.match(/\/url\?q=/gi) || []).length;
  const cite = (raw.match(/<cite/gi) || []).length;
  return h3 >= 2 || urlq >= 1 || cite >= 1;
}

function blockedError(message) {
  const e = new Error(message || 'google blocked');
  e.code = 'BLOCKED';
  return e;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch {
    /* keep raw */
  }
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
}

function decodeChunked(body) {
  let rest = body;
  let out = '';
  while (rest.length) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const size = parseInt(rest.slice(0, nl), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += rest.slice(nl + 2, nl + 2 + size);
    rest = rest.slice(nl + 2 + size);
    if (rest.startsWith('\r\n')) rest = rest.slice(2);
  }
  return out || body;
}

function proxyAuth(proxy) {
  if (!proxy.username) return null;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function fetchDirect(url, headers, timeoutMs) {
  const resp = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });
  const html = await resp.text();
  return { status: resp.status, html, finalUrl: resp.url || url };
}

// CONNECT tunnel to the target. This is the only transport that can reach an
// https target such as google.com.
function fetchViaTunnel(url, proxyUrl, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let req;
    let sock;
    const finish = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (sock) sock.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (req) req.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(val);
    };
    let target;
    let proxy;
    try {
      target = new URL(url);
      proxy = new URL(proxyUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => finish(new Error('tunnel timeout')), timeoutMs);
    const connectHeaders = { Host: `${target.hostname}:443` };
    const auth = proxyAuth(proxy);
    if (auth) connectHeaders['Proxy-Authorization'] = auth;
    req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: connectHeaders,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        // 404/405/501 mean the provider has no CONNECT support at all, which is
        // a different failure from a dead exit and must be remembered so the
        // exit is skipped instead of retried.
        if (res.statusCode === 407) {
          const e = new Error('proxy auth rejected');
          e.code = 'PROXY_AUTH';
          finish(e);
          return;
        }
        if ([404, 405, 501].includes(res.statusCode)) {
          const e = new Error(`proxy has no CONNECT support (${res.statusCode})`);
          e.code = 'NO_TUNNEL';
          e.status = res.statusCode;
          finish(e);
          return;
        }
        finish(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      sock = tls.connect(
        {
          socket,
          servername: target.hostname,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: true,
        },
        () => {
          const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.hostname}`];
          for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
          lines.push('Connection: close', '', '');
          try {
            sock.write(lines.join('\r\n'));
          } catch (err) {
            finish(err);
            return;
          }
          const chunks = [];
          sock.on('data', (c) => chunks.push(c));
          sock.on('end', () => {
            const raw = Buffer.concat(chunks);
            const sep = raw.indexOf('\r\n\r\n');
            const header = sep >= 0 ? raw.slice(0, sep).toString('utf8') : '';
            let body = sep >= 0 ? raw.slice(sep + 4) : raw;
            const status = parseInt((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1], 10) || 0;
            const location = ((header.match(/^location:\s*(.+)$/im) || [])[1] || '').trim();
            const enc = ((header.match(/^content-encoding:\s*(.+)$/im) || [])[1] || '').trim();
            if (/^transfer-encoding:\s*chunked/im.test(header) && Buffer.isBuffer(body)) {
              body = Buffer.from(decodeChunked(body.toString('utf8')), 'utf8');
            }
            finish(null, { status, html: decodeBody(body, enc), finalUrl: location || url });
          });
        }
      );
      sock.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    req.end();
  });
}

// Absolute-URI plain HTTP through the proxy. Used as a cheap capability probe:
// a provider that only forwards plain HTTP can reach google.com over http but
// google forces https, so such an exit can never serve a SERP.
function fetchViaPlainProxy(url, proxyUrl, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (req) req.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(val);
    };
    let target;
    let proxy;
    try {
      target = new URL(url);
      proxy = new URL(proxyUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const plain = new URL(url);
    plain.protocol = 'http:';
    const h = Object.assign({}, headers, { Host: target.hostname });
    const auth = proxyAuth(proxy);
    if (auth) h['Proxy-Authorization'] = auth;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'GET',
      path: plain.href,
      headers: h,
    });
    const timer = setTimeout(() => finish(new Error('plain proxy timeout')), timeoutMs);
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const enc = ((res.headers['content-encoding'] || '') || '').toLowerCase();
        finish(null, {
          status: res.statusCode || 0,
          html: decodeBody(Buffer.concat(chunks), enc),
          finalUrl: res.headers.location || url,
        });
      });
    });
    req.on('error', (err) => finish(err));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Exit racing
// ---------------------------------------------------------------------------

// Classifies an exit from the failure it produced, so a later request can skip
// it instead of paying the timeout again.
function classifyFailure(proxy, err) {
  const code = err && err.code;
  if (code === 'NO_TUNNEL') {
    exitState.note(proxy, 'plain');
    return;
  }
  if (code === 'PROXY_AUTH') {
    exitState.note(proxy, 'dead');
    return;
  }
  if (err && (err.status === 403 || err.status === 407)) {
    exitState.note(proxy, 'dead');
    return;
  }
  exitState.note(proxy, 'dead');
}

// One exit, one attempt. Resolves with the HTML of a usable SERP.
async function attemptExit(url, proxy, headers, timeoutMs) {
  let res;
  try {
    res = await fetchViaTunnel(url, proxy, headers, timeoutMs);
    exitState.note(proxy, 'tunnel');
  } catch (err) {
    if (err && err.code === 'NO_TUNNEL') {
      // Confirm with one cheap plain-HTTP probe before giving up on the exit.
      try {
        await fetchViaPlainProxy(url, proxy, headers, Math.min(timeoutMs, 4000));
        exitState.note(proxy, 'plain');
      } catch {
        exitState.note(proxy, 'dead');
      }
    } else {
      classifyFailure(proxy, err);
    }
    throw err;
  }
  if (res.status >= 300 && res.status < 400) {
    exitState.note(proxy, 'tunnel');
    throw blockedError(`exit answered with redirect ${res.status}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`exit answered with status ${res.status}`);
  }
  if (isGoogleBlocked(res.html, res.finalUrl)) {
    // The exit tunnels fine, Google just served it an interstitial. Remember
    // that so it is tried after the clean exits instead of first.
    exitState.note(proxy, 'gated');
    throw blockedError('exit returned an interstitial');
  }
  if (!looksLikeSerp(res.html)) {
    exitState.note(proxy, 'gated');
    throw blockedError('exit returned no organic results');
  }
  exitState.note(proxy, 'tunnel');
  return { html: res.html, transport: 'proxy', proxy };
}

// Races exits and resolves with the first usable SERP.
function raceExits(url, headers, proxies, timeoutMs) {
  const usable = exitState.sortByReliability((proxies || []).filter((p) => exitState.canUse(p)));
  if (!usable.length) return Promise.reject(new Error('no usable exits'));
  const tasks = usable.map((proxy) => () => attemptExit(url, proxy, headers, timeoutMs));
  return firstGood(tasks);
}

function firstGood(tasks) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    let lastErr = null;
    if (!pending) {
      reject(new Error('no attempts'));
      return;
    }
    for (const task of tasks) {
      Promise.resolve()
        .then(task)
        .then(resolve)
        .catch((err) => {
          lastErr = err || lastErr;
          pending -= 1;
          if (pending <= 0) reject(lastErr || new Error('all attempts failed'));
        });
    }
  });
}

// ---------------------------------------------------------------------------
// Chromium fallback
// ---------------------------------------------------------------------------

async function fetchViaChrome(url, proxies, timeoutMs) {
  const chromeFetch = require('./chromeFetch');
  if (!chromeFetch.fetchOn()) {
    const e = new Error('chrome fetch off');
    e.code = 'SKIP';
    throw e;
  }
  const timeout = Math.max(8000, timeoutMs || intEnv('CHROME_FETCH_MS', 12000));
  const list = (proxies || []).filter(Boolean).filter((p) => exitState.canUse(p));
  const workers = Math.max(1, Math.min(3, intEnv('CHROME_FETCH_WORKERS', 2)));
  // Without a usable exit, render on the host IP: on a residential or clean
  // machine that is the only way to get a SERP at all.
  const tries = list.length ? list.slice(0, workers) : [null];
  let lastErr = null;
  const render = async (proxy) => {
    const r = await chromeFetch.fetchHtml(url, { proxy, timeoutMs: timeout, engine: 'google' });
    const html = r && r.html;
    if (!html || isGoogleBlocked(html, r.finalUrl)) {
      throw blockedError('chromium returned an interstitial');
    }
    if (r.extras && !/<!--gsearch-extras:/.test(html)) {
      const { extrasComment } = require('./googleExtract');
      return { html: html + extrasComment(r.extras), extras: r.extras || null, transport: 'chrome', proxy };
    }
    return { html, extras: (r && r.extras) || null, transport: 'chrome', proxy };
  };
  // Rendering on several exits at once keeps the latency at the speed of the
  // first usable exit instead of the sum of all the broken ones.
  try {
    return await Promise.any(tries.map((proxy) => render(proxy)));
  } catch (err) {
    lastErr = err;
  }
  if (lastErr) throw lastErr;
  throw new Error('chrome fetch empty');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Fetches a Google lite SERP. Transport ladder:
//
//   direct  ->  raced exits (CONNECT)  ->  Chromium
//
// Direct and the exits run concurrently: direct costs a few tens of
// milliseconds when it works and is the fastest possible path, while the exits
// are the only way to succeed from a blocked datacenter IP.
//
// `prefer` pins the ladder to the transport that already worked for this
// request, which is what makes a follow-up page cost the same as the first one
// instead of re-probing every dead exit.
async function fetchGoogleLite({
  url,
  geo,
  proxies = [],
  timeoutMs = intEnv('LITE_GOOGLE_TIMEOUT_MS', 3500),
  allowDirect = true,
  allowChrome = true,
  prefer = null,
} = {}) {
  const headers = liteHeaders(geo);
  const errors = [];

  const directAttempt = async () => {
    const r = await fetchDirect(url, headers, timeoutMs);
    if (r.status < 200 || r.status >= 300) throw new Error(`direct answered with status ${r.status}`);
    if (isGoogleBlocked(r.html, r.finalUrl)) throw blockedError('direct returned an interstitial');
    if (!looksLikeSerp(r.html)) throw blockedError('direct returned no organic results');
    return { html: r.html, transport: 'direct', proxy: null };
  };
  const exitsAttempt = () => raceExits(url, headers, proxies, timeoutMs);
  const chromeAttempt = () => fetchViaChrome(url, proxies, timeoutMs);

  let attempts;
  if (prefer === 'chrome') {
    attempts = [chromeAttempt];
  } else if (prefer === 'proxy') {
    attempts = [exitsAttempt].concat(allowDirect ? [directAttempt] : []);
  } else {
    attempts = (allowDirect ? [directAttempt] : []).concat([exitsAttempt]);
  }

  try {
    return await Promise.any(
      attempts.map((t) =>
        t().catch((err) => {
          errors.push(err);
          throw err;
        })
      )
    );
  } catch {
    /* fall through to Chromium */
  }

  if (allowChrome && prefer !== 'chrome') {
    try {
      return await chromeAttempt();
    } catch (err) {
      errors.push(err);
    }
  }

  const blocked = errors.find((e) => e && e.code === 'BLOCKED');
  const err = blocked || errors[errors.length - 1] || new Error('google lite fetch failed');
  if (!err.code) err.code = 'LITE_FETCH_ERROR';
  throw err;
}

module.exports = {
  buildLiteUrl,
  liteHeaders,
  isGoogleBlocked,
  looksLikeSerp,
  fetchGoogleLite,
  fetchViaTunnel,
  fetchViaPlainProxy,
  raceExits,
  fetchViaChrome,
  exitState,
  UA,
  CH_UA,
  JS_GATE,
};
