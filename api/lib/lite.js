'use strict';

const http = require('http');
const tls = require('tls');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENDPOINTS = {
  duckduckgo: ({ q, kl, s }) => {
    const p = new URLSearchParams({ q, kl });
    if (s) p.set('s', String(s));
    return `https://html.duckduckgo.com/html/?${p.toString()}`;
  },
  duckduckgo_lite: ({ q, s }) => {
    const p = new URLSearchParams({ q });
    if (s) p.set('s', String(s));
    return `https://lite.duckduckgo.com/lite/?${p.toString()}`;
  },
  bing: ({ q, num, s, gl }) => {
    const p = new URLSearchParams({ q, count: String(num || 10) });
    if (gl) p.set('cc', gl);
    if (s) p.set('first', String(s + 1));
    return `https://www.bing.com/search?${p.toString()}`;
  },
  brave: ({ q, s, gl }) => {
    const p = new URLSearchParams({ q, source: 'web' });
    if (gl) p.set('country', gl);
    if (s) p.set('offset', String(s));
    return `https://search.brave.com/search?${p.toString()}`;
  },
  mojeek: ({ q, s }) => {
    const p = new URLSearchParams({ q });
    if (s) p.set('s', String(s));
    return `https://www.mojeek.com/search?${p.toString()}`;
  },
  yahoo: ({ q, s }) => {
    const p = new URLSearchParams({ p: q, n: '10' });
    if (s) p.set('b', String(s + 1));
    return `https://search.yahoo.com/search?${p.toString()}`;
  },
  ecosia: ({ q, s, gl }) => {
    const p = new URLSearchParams({ q });
    if (gl) p.set('c', String(gl).toLowerCase());
    if (s) p.set('p', String(Math.floor(s / 10) + 1));
    return `https://www.ecosia.org/search?${p.toString()}`;
  },
  startpage: ({ q, s }) => {
    const p = new URLSearchParams({ query: q });
    if (s) p.set('page', String(Math.floor(s / 10) + 1));
    return `https://www.startpage.com/sp/search?${p.toString()}`;
  },
  google: ({ q, s, gl, hl }) => {
    const p = new URLSearchParams({
      q,
      hl: hl || 'en',
      gl: gl || 'us',
      start: String(s || 0),
      gbv: '2',
    });
    return `https://www.google.com/search?${p.toString()}`;
  },
};

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").trim();
}

function decodeHref(raw) {
  let href = String(raw || '').trim();
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && (u.pathname === '/l/' || u.pathname === '/l')) {
      const target = u.searchParams.get('uddg');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
    return /^https?:\/\//i.test(u.href) ? u.href : '';
  } catch {
    return '';
  }
}

// Parsers keyed by engine. Each returns [{ title, url, snippet }]. Pure regex
// because lite pages are tiny and deterministic; avoids a cheerio dependency.
const PARSERS = {
  // html.duckduckgo.com/html layout:
  //   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=...">Title</a>
  //   <a class="result__snippet" ...>Snippet</a>
  duckduckgo: (html) => {
    const results = [];
    const blocks = html.split(/class="result[^"]*"/i).slice(1);
    for (const block of blocks) {
      const m = block.match(/href="([^"]+)"[^>]*>(.*?)<\/a>/i);
      if (!m) continue;
      const url = decodeHref(m[1]);
      const title = decodeEntities(stripTags(m[2]));
      if (!url || !title) continue;
      const sn = block.match(/class="result__snippet"[^>]*>(.*?)<\/a>/i);
      results.push({ title, url, snippet: sn ? decodeEntities(stripTags(sn[1])) : '' });
    }
    return results;
  },
  // lite.duckduckgo.com/lite layout:
  //   <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=...">Title</a>
  //   <td class="result-snippet">...</td>
  duckduckgo_lite: (html) => {
    const results = [];
    const blocks = html.split(/class="result-link"/i).slice(1);
    for (const block of blocks) {
      const m = block.match(/href="([^"]+)"[^>]*>(.*?)<\/a>/i);
      if (!m) continue;
      const url = decodeHref(m[1]);
      const title = decodeEntities(stripTags(m[2]));
      if (!url || !title) continue;
      const sn = block.match(/class="result-snippet"[^>]*>(.*?)<\/td>/i);
      results.push({ title, url, snippet: sn ? decodeEntities(stripTags(sn[1])) : '' });
    }
    return results;
  },
  bing: (html) => parseAnchorBlocks(html, {
    hostRe: /bing\.com$/i,
    titleRe: /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  brave: (html) => parseAnchorBlocks(html, {
    hostRe: /brave\.com$/i,
    titleRe: /<a[^>]+class="[^"]*\bl1\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  mojeek: (html) => parseAnchorBlocks(html, {
    hostRe: /mojeek\.com$/i,
    titleRe: /<a[^>]+class="[^"]*\bob\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  yahoo: (html) => parseYahooLite(html),
  ecosia: (html) => parseAnchorBlocks(html, {
    hostRe: /ecosia\.org$/i,
    titleRe: /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*result-title[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  startpage: (html) => parseAnchorBlocks(html, {
    hostRe: /startpage\.com$/i,
    titleRe: /<(?:h2|h3)[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  google: (html) => parseGoogleLite(html),
};

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function parseAnchorBlocks(html, { hostRe, titleRe }) {
  const results = [];
  const seen = new Set();
  const re = new RegExp(titleRe.source, titleRe.flags);
  let m;
  while ((m = re.exec(html))) {
    let url = decodeEntities(m[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    if (hostRe.test(hostOf(url))) continue;
    const title = decodeEntities(stripTags(m[2]));
    if (!title || title.length < 2 || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  return results;
}

function parseGoogleLite(html) {
  const results = [];
  const seen = new Set();
  function resolveUrl(href) {
    let url = decodeEntities(String(href || '').trim());
    if (url.startsWith('/url?')) {
      try {
        const u = new URL(url, 'https://www.google.com');
        url = u.searchParams.get('q') || u.searchParams.get('url') || url;
      } catch {
        /* ignore */
      }
    }
    if (url.startsWith('/url?q=')) {
      url = decodeEntities(url.slice('/url?q='.length).split('&')[0]);
    }
    try {
      url = decodeURIComponent(url);
    } catch {
      /* ignore */
    }
    return url;
  }
  function skipHost(url) {
    try {
      const h = new URL(url).hostname;
      return (
        h === 'google.com' ||
        h.endsWith('.google.com') ||
        /googleusercontent\.com$|gstatic\.com$|googleadservices\.com$/i.test(h)
      );
    } catch {
      return true;
    }
  }
  const re =
    /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = resolveUrl(m[1] || m[3] || '');
    const title = decodeEntities(stripTags(m[2] || m[4] || ''));
    if (!title || title.length < 3 || title.length > 200) continue;
    if (!/^https?:\/\//i.test(url) || skipHost(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  if (results.length === 0) {
    const re2 = /href="(\/url\?q=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(html))) {
      const url = resolveUrl(m[1]);
      const title = decodeEntities(stripTags(m[2]));
      if (!title || title.length < 3 || title.length > 200) continue;
      if (!/^https?:\/\//i.test(url) || skipHost(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
  }
  return results;
}

function parseYahooLite(html) {
  const results = [];
  const seen = new Set();
  const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url = decodeEntities(m[1]);
    if (url.includes('/RU=')) {
      const ru = url.match(/\/RU=([^/]+)/);
      if (ru) {
        try {
          const dec = decodeURIComponent(ru[1]);
          if (/^https?:\/\//i.test(dec)) url = dec;
        } catch {
          /* ignore */
        }
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const h = hostOf(url);
    if (/yahoo\.com$|yimg\.com$/i.test(h)) continue;
    const title = decodeEntities(stripTags(m[2]));
    if (!title || title.length < 2 || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  return results;
}

function isBlockedPage(html, engine) {
  const low = html.toLowerCase();
  if (/\banomaly/i.test(low)) return true;
  if (engine === 'duckduckgo' && /id="captcha"/i.test(low)) return true;
  if (engine === 'google' && (/\/sorry\//i.test(html) || /id="captcha"/i.test(low))) return true;
  if (/unusual traffic|enablejs|prove you are human|verify you are human|protected by altcha|verification required/i.test(low)) return true;
  return false;
}

function fetchViaProxy(targetUrl, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    let target;
    let proxy;
    try {
      target = new URL(targetUrl);
      proxy = new URL(proxyUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      req.destroy();
      done(new Error('proxy fetch timeout'));
    }, timeoutMs);
    const headers = { Host: `${target.hostname}:443` };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password || '');
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        if (socket) socket.destroy();
        done(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true }, () => {
        const path = `${target.pathname}${target.search}`;
        tlsSock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: ${UA}\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Language: en-US,en;q=0.9\r\nConnection: close\r\n\r\n`
        );
      });
      const chunks = [];
      tlsSock.on('data', (c) => chunks.push(c));
      tlsSock.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const sep = raw.indexOf('\r\n\r\n');
        const header = sep >= 0 ? raw.slice(0, sep) : '';
        let body = sep >= 0 ? raw.slice(sep + 4) : raw;
        const status = parseInt((header.match(/^HTTP\/\d\.\d\s+(\d+)/) || [])[1], 10) || 0;
        if (/^transfer-encoding:\s*chunked/im.test(header)) body = decodeChunked(body);
        done(null, { status, html: body });
      });
      tlsSock.on('error', (err) => done(err));
    });
    req.on('error', (err) => done(err));
    req.end();
  });
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

function liveProxies() {
  try {
    const { getShardPool, otherProxyPool } = require('./proxyPool');
    return otherProxyPool(getShardPool()).filter(Boolean);
  } catch {
    return [];
  }
}

function raceProxyFetch(url, engine, timeoutMs, n) {
  const pool = liveProxies().sort(() => Math.random() - 0.5).slice(0, n);
  if (!pool.length) return Promise.reject(new Error('no proxies'));
  return new Promise((resolve, reject) => {
    let pending = pool.length;
    let finished = false;
    let lastErr = null;
    const done = (err, html) => {
      if (finished) return;
      if (html) {
        finished = true;
        resolve(html);
        return;
      }
      lastErr = err || lastErr;
      pending -= 1;
      if (pending <= 0) reject(lastErr || new Error('all proxies failed'));
    };
    for (const p of pool) {
      fetchViaProxy(url, p, timeoutMs)
        .then(({ status, html }) => {
          if (status >= 200 && status < 400 && html && !isBlockedPage(html, engine)) done(null, html);
          else done(new Error(`status ${status}`));
        })
        .catch((err) => done(err));
    }
  });
}

async function fetchDirect(url, engine, headers) {
  const resp = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const html = await resp.text();
  if (resp.status === 202 || resp.status === 403 || resp.status === 429 || isBlockedPage(html, engine)) {
    const e = new Error(`Engine "${engine}" blocked plain-HTTP fetch (status ${resp.status})`);
    e.code = 'BLOCKED';
    throw e;
  }
  if (!resp.ok) {
    const e = new Error(`Engine "${engine}" plain-HTTP fetch status ${resp.status}`);
    e.code = 'LITE_HTTP_ERROR';
    throw e;
  }
  return html;
}

async function fetchLitePage(url, engine) {
  const headers = {
    'user-agent': UA,
    'accept-language': 'en-US,en;q=0.9',
    accept: 'text/html,application/xhtml+xml',
  };
  if (engine === 'google') {
    try {
      return await raceProxyFetch(url, engine, 2200, 3);
    } catch {
      /* DC race failed — fall through to direct IP */
    }
    try {
      return await fetchDirect(url, engine, headers);
    } catch (err) {
      const e = new Error(`Lite fetch failed: ${(err && err.message) || 'direct'}`);
      e.code = (err && err.code) || 'LITE_FETCH_ERROR';
      throw e;
    }
  }
  try {
    return await fetchDirect(url, engine, headers);
  } catch (directErr) {
    try {
      return await raceProxyFetch(url, engine, 4000, 3);
    } catch {
      const e = new Error(`Lite fetch failed: ${directErr.message}`);
      e.code = directErr.code || 'LITE_FETCH_ERROR';
      throw e;
    }
  }
}

async function fastLiteSearch({ engine, query, num = 10, hl = 'en', gl = 'us', start = 0 }) {
  const build = ENDPOINTS[engine];
  if (!build) {
    const e = new Error(`No lite endpoint for engine "${engine}"`);
    e.code = 'NO_LITE_ENDPOINT';
    throw e;
  }
  const kl = `${gl || 'us'}-${hl || 'en'}`;
  const parser = PARSERS[engine];
  const t0 = Date.now();
  const pageCount = Math.min(5, Math.max(1, Math.ceil(num / 10)));
  const results = [];
  const seen = new Set();
  let lastErr = null;
  const base = Math.max(0, Number(start) || 0);

  for (let i = 0; i < pageCount; i++) {
    if (results.length >= num) break;
    const url = build({ q: query, kl, s: base + i * 10, num, gl, hl });
    try {
      const html = await fetchLitePage(url, engine);
      let added = 0;
      for (const r of parser(html)) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
        added += 1;
      }
      if (added === 0) break;
    } catch (err) {
      lastErr = err;
      if (results.length === 0) throw err;
      break;
    }
  }

  if (results.length === 0) {
    if (lastErr) throw lastErr;
    const e = new Error(`Engine "${engine}" returned no organic results on plain-HTTP page`);
    e.code = 'EMPTY_RESULTS';
    throw e;
  }

  return {
    results: results.slice(0, Math.min(num, results.length)),
    duration_ms: Date.now() - t0,
  };
}

module.exports = { fastLiteSearch, ENDPOINTS, PARSERS };
