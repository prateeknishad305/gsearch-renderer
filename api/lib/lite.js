'use strict';

const http = require('http');
const http2 = require('http2');
const tls = require('tls');
const zlib = require('zlib');
const { URL } = require('url');
const { isGarbageUrl, isAiModeTitle } = require('./resultFilter');

const CHROME_MAJOR = '155';
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not.A/Brand";v="24"`;

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
  // Google lite URLs are built by googleLite.buildLiteUrl so the plain-HTTP
  // path resolves locale, country and site: dorks exactly like the Chromium
  // path does.
  google_lite: ({ q, s, num, gl, hl, tbs, before, after }) =>
    require('./googleLite').buildLiteUrl({ q, num, start: s, gl, hl, tbs, before, after }).url,
  google: ({ q, s, num, gl, hl, tbs, before, after }) =>
    require('./googleLite').buildLiteUrl({ q, num, start: s, gl, hl, tbs, before, after }).url,
  archive: ({ q, s, num }) => {
    const rows = Math.min(50, Math.max(1, Number(num) || 10));
    const page = Math.floor(Math.max(0, Number(s) || 0) / 10) + 1;
    const p = new URLSearchParams({
      q: String(q || ''),
      output: 'json',
      rows: String(rows),
      page: String(page),
    });
    p.append('fl[]', 'identifier');
    p.append('fl[]', 'title');
    p.append('fl[]', 'description');
    p.append('fl[]', 'mediatype');
    return `https://archive.org/advancedsearch.php?${p.toString()}`;
  },
  wikipedia: ({ q, hl, num }) => {
    const lang = String(hl || 'en').slice(0, 8) || 'en';
    const p = new URLSearchParams({
      action: 'opensearch',
      search: String(q || ''),
      limit: String(Math.min(50, Math.max(1, Number(num) || 10))),
      namespace: '0',
      format: 'json',
      origin: '*',
    });
    return `https://${lang}.wikipedia.org/w/api.php?${p.toString()}`;
  },
  github: ({ q, s }) => {
    const p = new URLSearchParams({ q, type: 'repositories' });
    if (s) p.set('p', String(Math.floor(s / 10) + 1));
    return `https://github.com/search?${p.toString()}`;
  },
  wiby: ({ q }) => `https://wiby.me/?q=${encodeURIComponent(q)}`,
  qwant: ({ q, s, hl, gl }) => {
    const localeMap = { fr: 'fr_FR', de: 'de_DE', en: 'en_GB', us: 'en_GB' };
    const locale = localeMap[(hl || '').toLowerCase()] || localeMap[(gl || '').toLowerCase()] || 'en_GB';
    const p = new URLSearchParams({ q, t: 'web', locale, safesearch: '0' });
    if (s) p.set('offset', String(s));
    return `https://www.qwant.com/?${p.toString()}`;
  },
  yandex: ({ q, s }) => {
    const p = new URLSearchParams({ text: q });
    if (s) p.set('p', String(Math.floor(s / 10)));
    return `https://yandex.com/search/?${p.toString()}`;
  },
};

const JSON_ENGINES = new Set(['archive', 'wikipedia']);

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").trim();
}

// Bing wraps every result in a click tracker: /ck/a?...&u=a1<base64url>.
// The real destination only exists in that base64 payload, so a result that is
// not decoded keeps the bing.com host and is dropped by every site: filter.
function decodeBingHref(href) {
  const url = decodeEntities(String(href || '').trim());
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'bing.com' && !host.endsWith('.bing.com')) return url;
  const encoded = parsed.searchParams.get('u');
  if (!encoded) return url;
  let raw = encoded;
  // Bing prefixes the payload with "a1".
  if (/^a1/.test(raw)) raw = raw.slice(2);
  raw = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (raw.length % 4) raw += '=';
  let decoded = '';
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return url;
  }
  decoded = decodeEntities(decoded.trim());
  return /^https?:\/\//i.test(decoded) ? decoded : url;
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
    decode: decodeBingHref,
  }),
  brave: (html) => parseAnchorBlocks(html, {
    hostRe: /brave\.com$/i,
    titleRe: /<a[^>]+class="[^"]*\bl1\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  mojeek: (html) => parseMojeekLite(html),
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
  google_lite: (html) => parseGoogleLite(html),
  archive: (body) => parseArchiveLite(body),
  wikipedia: (body) => parseWikipediaLite(body),
  github: (html) => parseGithubLite(html),
  wiby: (html) => parseAnchorBlocks(html, {
    hostRe: /wiby\.me$/i,
    titleRe: /<a[^>]+class="[^"]*\btlink\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  qwant: (html) => parseAnchorBlocks(html, {
    hostRe: /qwant\.com$/i,
    titleRe: /<(?:h2|h3)[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
  yandex: (html) => parseAnchorBlocks(html, {
    hostRe: /yandex\.(com|ru|by|kz)$|ya\.ru$|yandex\.net$/i,
    titleRe: /<a[^>]+class="[^"]*(?:organic__url|OrganicTitle-Link)[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  }),
};

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function parseAnchorBlocks(html, { hostRe, titleRe, decode }) {
  const results = [];
  const seen = new Set();
  // A malformed pattern must not turn into an empty regex: an empty regex
  // matches at every position and would spin here forever.
  const src = titleRe instanceof RegExp ? titleRe.source : String(titleRe || '');
  if (!src) return results;
  const re = new RegExp(src, titleRe instanceof RegExp ? titleRe.flags : 'gi');
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === "") re.lastIndex++;  // zero-length match would loop forever
    let url = decode ? decode(m[1]) : decodeEntities(m[1]);
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
  return require('./googleExtract').extractFromHtml(html);
}

function parseMojeekLite(html) {
  const hostRe = /mojeek\.com$|altcha\.org$/i;
  if (/<title>\s*captcha\s*<\/title>/i.test(html) || /altcha\.js|data-altcha/i.test(html)) return [];
  const news = parseAnchorBlocks(html, {
    hostRe,
    titleRe: /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
  if (news.length) return news;
  return parseAnchorBlocks(html, {
    hostRe,
    titleRe: /<a[^>]+class="[^"]*\bob\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
}

function parseYahooLite(html) {
  const results = [];
  const seen = new Set();
  const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === "") re.lastIndex++;  // zero-length match would loop forever
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

function parseArchiveLite(body) {
  const results = [];
  const seen = new Set();
  let docs = [];
  try {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    docs = (data && data.response && Array.isArray(data.response.docs) && data.response.docs) || [];
  } catch {
    return parseArchiveHtmlLite(body);
  }
  for (const doc of docs) {
    const id = String((doc && doc.identifier) || '').trim();
    if (!id || /[/\s]/.test(id)) continue;
    const url = `https://archive.org/details/${encodeURIComponent(id)}`;
    if (seen.has(url)) continue;
    const rawTitle = Array.isArray(doc.title) ? doc.title[0] : doc.title;
    const title = String(rawTitle || id).replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) continue;
    let snippet = doc.description;
    if (Array.isArray(snippet)) snippet = snippet[0];
    seen.add(url);
    results.push({
      title,
      url,
      snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
  return results;
}

function parseWikipediaLite(body) {
  const results = [];
  const seen = new Set();
  let data;
  try {
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return results;
  }
  if (!Array.isArray(data) || data.length < 4) return results;
  const titles = Array.isArray(data[1]) ? data[1] : [];
  const descs = Array.isArray(data[2]) ? data[2] : [];
  const urls = Array.isArray(data[3]) ? data[3] : [];
  for (let i = 0; i < urls.length; i++) {
    const url = String(urls[i] || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    try {
      const h = new URL(url).hostname;
      if (!/(^|\.)wikipedia\.org$/i.test(h)) continue;
    } catch {
      continue;
    }
    const title = String(titles[i] || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: String(descs[i] || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
  return results;
}

const GITHUB_SKIP = new Set([
  'search', 'login', 'signup', 'topics', 'orgs', 'settings', 'marketplace',
  'explore', 'about', 'pricing', 'features', 'collections', 'sponsors',
  'notifications', 'pulls', 'issues', 'codespaces', 'copilot', 'customer-stories',
  'security', 'enterprise', 'team', 'solutions', 'resources', 'open-source',
]);

function parseGithubLite(html) {
  const results = [];
  const seen = new Set();
  function repoUrl(href) {
    try {
      const u = /^https?:\/\//i.test(href) ? new URL(href) : new URL(href, 'https://github.com');
      if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return '';
      const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length < 2 || GITHUB_SKIP.has(parts[0].toLowerCase())) return '';
      if (parts[0].startsWith('@') || parts[1] === 'search') return '';
      return `https://github.com/${parts[0]}/${parts[1]}`;
    } catch {
      return '';
    }
  }
  const re = /class="[^"]*search-title[^"]*"[\s\S]{0,400}?href="([^"]+)"[\s\S]{0,400}?>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[0] === "") re.lastIndex++;  // zero-length match would loop forever
    const url = repoUrl(decodeEntities(m[1]));
    if (!url || seen.has(url)) continue;
    const title = decodeEntities(stripTags(m[2])) || url.replace('https://github.com/', '');
    if (!title || title.length < 2) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  return results;
}

function parseArchiveHtmlLite(html) {
  const results = [];
  const seen = new Set();
  const re = /href="(\/details\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[0] === "") re.lastIndex++;  // zero-length match would loop forever
    const id = decodeEntities(m[1]).replace(/^\/details\//, '').split('/')[0];
    if (!id || /[/\s]/.test(id)) continue;
    const url = `https://archive.org/details/${encodeURIComponent(id)}`;
    if (seen.has(url)) continue;
    const title = decodeEntities(stripTags(m[2])) || id;
    if (!title || title.length < 2) continue;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  return results;
}

function googleCookieHeader() {
  const stamp = Date.now().toString(36);
  return `CONSENT=YES+cb.20210328-17-p0.en+FX+${stamp}; SOCS=CAI`;
}

function isBlockedPage(html, engine) {
  if (JSON_ENGINES.has(engine)) return false;
  const raw = String(html || '');
  const low = raw.toLowerCase();
  const google = engine === 'google' || engine === 'google_lite';
  if (google) {
    // Shared with the googleLite transport so both agree on what an
    // interstitial is: the JS gate, /sorry, captcha and consent walls.
    const gl = require('./googleLite');
    if (gl.isGoogleBlocked(raw)) return true;
    // A real SERP carries result markers; without them the payload is an
    // unrecognised block page or an empty shell.
    return !gl.looksLikeSerp(raw);
  }
  if (/\banomaly/i.test(low)) return true;
  if (engine === 'duckduckgo' && /id="captcha"/i.test(low)) return true;
  if (/<title>\s*(captcha|are you not a robot|вы не робот|service unavailable)\s*<\/title>/i.test(raw)) return true;
  if (/altcha\.js|data-altcha|smartcaptcha|showcaptcha|are you not a robot|вы не робот/i.test(low)) return true;
  if (/unusual traffic|prove you are human|verify you are human|protected by altcha|verification required|just a moment|wait a moment|aggressive bot activity|barraged by queries from bots|service unavailable/i.test(low)) return true;
  return false;
}

function chromeHeaders(target) {
  const h = {
    'user-agent': UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
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
  if (target.hostname.includes('google')) h.cookie = googleCookieHeader();
  return h;
}

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

function fetchViaProxy(targetUrl, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let req;
    let tlsSock;
    let session;
    const done = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (session) session.close();
      } catch {
        /* ignore */
      }
      if (tlsSock) tlsSock.destroy();
      if (req) req.destroy();
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
    const timer = setTimeout(() => done(new Error('proxy fetch timeout')), timeoutMs);
    const connectHeaders = { Host: `${target.hostname}:443` };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password || '');
      connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: connectHeaders,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        if (socket) socket.destroy();
        done(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      tlsSock = tls.connect(
        {
          socket,
          servername: target.hostname,
          ALPNProtocols: ['h2', 'http/1.1'],
          rejectUnauthorized: true,
        },
        () => {
          const hdrs = chromeHeaders(target);
          const path = `${target.pathname}${target.search}`;
          if (tlsSock.alpnProtocol === 'h2') {
            session = http2.connect(`https://${target.hostname}`, { createConnection: () => tlsSock });
            session.on('error', (err) => done(err));
            const h2h = {
              ':method': 'GET',
              ':path': path,
              ':authority': target.hostname,
              ':scheme': 'https',
            };
            for (const [k, v] of Object.entries(hdrs)) h2h[k] = v;
            const stream = session.request(h2h);
            const chunks = [];
            let resp = {};
            stream.on('response', (h) => {
              resp = h;
            });
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
              const status = resp[':status'] || 0;
              const loc = resp.location || '';
              const html = decodeBody(Buffer.concat(chunks), resp['content-encoding']);
              done(null, { status, html, location: loc });
            });
            stream.on('error', (err) => done(err));
            stream.end();
            return;
          }
          const lines = [`GET ${path} HTTP/1.1`, `Host: ${target.hostname}`];
          for (const [k, v] of Object.entries(hdrs)) lines.push(`${k}: ${v}`);
          lines.push('Connection: close', '', '');
          tlsSock.write(lines.join('\r\n'));
          const chunks = [];
          tlsSock.on('data', (c) => chunks.push(c));
          tlsSock.on('end', () => {
            const raw = Buffer.concat(chunks);
            const sep = raw.indexOf('\r\n\r\n');
            const header = sep >= 0 ? raw.slice(0, sep).toString('utf8') : '';
            const body = sep >= 0 ? raw.slice(sep + 4) : raw;
            const status = parseInt((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1], 10) || 0;
            const loc = ((header.match(/^location:\s*(.+)$/im) || [])[1] || '').trim();
            const enc = ((header.match(/^content-encoding:\s*(.+)$/im) || [])[1] || '').trim();
            let htmlBuf = body;
            if (/^transfer-encoding:\s*chunked/im.test(header) && Buffer.isBuffer(body)) {
              htmlBuf = Buffer.from(decodeChunked(body.toString('utf8')), 'utf8');
            }
            done(null, { status, html: decodeBody(htmlBuf, enc), location: loc });
          });
        }
      );
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

function liveProxies(engine) {
  try {
    const { getShardPool, otherProxyPool, googleProxyPool, getUserProxies } = require('./proxyPool');
    try {
      const { getLivePool, refreshLivePool } = require('./proxyFetch');
      if (!getLivePool().length) refreshLivePool().catch(() => {});
    } catch {
      /* ignore */
    }
    if (engine === 'google' || engine === 'google_lite' || engine === 'chrome') {
      const user = getUserProxies().filter(Boolean);
      if (user.length) return user;
      return googleProxyPool(getShardPool()).filter(Boolean);
    }
    return otherProxyPool(getShardPool()).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchViaProxyFollow(url, proxyUrl, timeoutMs, hops = 2) {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    const r = await fetchViaProxy(current, proxyUrl, timeoutMs);
    if (r.status >= 300 && r.status < 400 && r.location) {
      try {
        current = new URL(r.location, current).href;
      } catch {
        return r;
      }
      if (!/^https:/i.test(current)) return r;
      continue;
    }
    return r;
  }
  return fetchViaProxy(current, proxyUrl, timeoutMs);
}

function raceProxyFetch(url, engine, timeoutMs, n) {
  const { raceWidth } = require('./proxyRace');
  const width = n || raceWidth();
  const pool = liveProxies(engine).sort(() => Math.random() - 0.5).slice(0, width);
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
      fetchViaProxyFollow(url, p, timeoutMs)
        .then(({ status, html }) => {
          if (status >= 200 && status < 300 && html && !isBlockedPage(html, engine)) done(null, html);
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
    signal: AbortSignal.timeout(Math.max(1000, parseInt(process.env.LITE_TIMEOUT_MS, 10) || 4000)),
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

async function fetchChromeGoogle(url, engine) {
  const chromeFetch = require('./chromeFetch');
  if (!chromeFetch.fetchOn()) {
    const e = new Error('chrome fetch off');
    e.code = 'SKIP';
    throw e;
  }
  const timeoutMs = Math.max(8000, parseInt(process.env.CHROME_FETCH_MS, 10) || 12000);
  const pool = liveProxies(engine).filter(Boolean).sort(() => Math.random() - 0.5);
  const { firstOk } = require('./proxyRace');
  const n = Math.max(1, Math.min(6, parseInt(process.env.CHROME_FETCH_WORKERS, 10) || 3));
  const tries = pool.slice(0, n);
  if (!tries.length) {
    const e = new Error('no proxy');
    e.code = 'NO_PROXY';
    throw e;
  }
  // Race the exits in parallel and keep the first usable page; sequential
  // tries made one blocked exit cost a whole extra render timeout.
  const attempt = async (proxy) => {
    const r = await chromeFetch.fetchHtml(url, { proxy, timeoutMs, engine });
    const loc = r && r.finalUrl;
    if (loc && /\/sorry\//i.test(loc)) {
      throw Object.assign(new Error('sorry'), { code: 'BLOCKED' });
    }
    if (r.status && r.status !== 200 && r.status !== 0 && r.status !== 302) {
      throw Object.assign(new Error(`status ${r.status}`), { code: 'LITE_HTTP_ERROR' });
    }
    let html = r && r.html;
    if (!html || isBlockedPage(html, engine)) {
      throw Object.assign(new Error('blocked'), { code: 'BLOCKED' });
    }
    if (r.extras && html && !/<!--gsearch-extras:/.test(html)) {
      const { extrasComment } = require('./googleExtract');
      html += extrasComment(r.extras);
    }
    return { html, extras: r.extras || null, results: r.results || null };
  };
  return firstOk(tries.map((proxy) => () => attempt(proxy)));
}

async function fetchLitePage(url, engine) {
  const headers = {
    'user-agent': UA,
    'accept-language': 'en-US,en;q=0.9',
    accept: JSON_ENGINES.has(engine) ? 'application/json' : 'text/html,application/xhtml+xml',
  };
  if (engine === 'google' || engine === 'google_lite') {
    // The Google path lives in googleLite.js: one transport ladder, one set of
    // block rules and one exit memory. This branch stays only so the engine
    // keeps working if it is called directly.
    const googleLite = require('./googleLite');
    const timeoutMs = Math.max(1200, Math.min(15000, parseInt(process.env.LITE_GOOGLE_TIMEOUT_MS, 10) || 3500));
    return googleLite.fetchGoogleLite({
      url,
      geo: googleLite.geoFromUrl(url),
      proxies: await googleExits(),
      timeoutMs,
    });
  }
  if (engine === 'mojeek') {
    try {
      return await fetchChromeGoogle(url, engine);
    } catch (err) {
      const e = new Error(`Lite fetch failed: ${(err && err.message) || 'chrome'}`);
      e.code = (err && err.code) || 'LITE_FETCH_ERROR';
      throw e;
    }
  }
  try {
    return { html: await fetchDirect(url, engine, headers) };
  } catch (directErr) {
    try {
      return { html: await raceProxyFetch(url, engine, 4000) };
    } catch {
      const e = new Error(`Lite fetch failed: ${directErr.message}`);
      e.code = directErr.code || 'LITE_FETCH_ERROR';
      throw e;
    }
  }
}

// Exits for the Google transport. The live pool is refreshed in the
// background; exits that were proven unable to tunnel are skipped so a request
// never pays the same timeout twice for the same dead exit.
async function googleExits() {
  try {
    const { getShardPool, googleProxyPool, getUserProxies } = require('./proxyPool');
    const { getLivePool, refreshLivePool } = require('./proxyFetch');
    const exitState = require('./exitState');
    const user = getUserProxies().filter(Boolean);
    if (user.length) return user.filter((p) => exitState.canUse(p));
    let live = getLivePool();
    if (!live.length) {
      // Warm the pool once. On a cold start the live list is still downloading
      // and every exit we could race would come from the dead fallback file,
      // which is exactly how a request ends up "blocked" for no reason.
      const budget = Math.max(0, parseInt(process.env.LITE_POOL_WARM_MS, 10) || 2500);
      if (budget > 0) {
        try {
          await Promise.race([
            refreshLivePool(),
            new Promise((r) => setTimeout(r, budget)),
          ]);
        } catch {
          /* ignore */
        }
      }
      live = getLivePool();
    }
    const pool = live.length ? live : googleProxyPool(getShardPool());
    return pool.filter(Boolean).filter((p) => exitState.canUse(p));
  } catch {
    return [];
  }
}

// A site: dork is only honoured by some of the exits that serve Google, so
// the lite path has to be able to tell that a page did not respect it.
function matchesSite(url, targets) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const { hostMatchesSite } = require('./dork');
  return targets.some((t) => hostMatchesSite(host, t));
}

// Google lite search: geo-correct URL, hardened transport, and a page loop
// that tops up short pages so a request for N results actually returns N.
async function googleLiteSearch({ engine, query, num, hl, gl, start, tbs, before, after, deadlineAt }) {
  const googleLite = require('./googleLite');
  const { parseExtras } = require('./googleExtract');
  const { parseDork, isHostSiteTarget, hostMatchesSite } = require('./dork');
  const t0 = Date.now();
  const want = Math.max(1, Number(num) || 10);
  const base = Math.max(0, Number(start) || 0);
  const results = [];
  const seen = new Set();
  const dorkInfo = parseDork(String(query || ''));
  const siteTargets = dorkInfo.site_targets.filter(isHostSiteTarget);
  // A dork is answered through Google's modern surface: the basic-HTML
  // surface is tried first because it is cheap, but the operator travels as
  // as_sitesearch/as_filetype and every hit is checked, so a surface that
  // ignores the operator is detected and escalated.
  const dork = dorkInfo.has_operators;
  const triedExits = new Set();
  let extras = null;
  let lastErr = null;
  let transport = null;
  const topUp = String(process.env.LITE_TOPUP || '1') !== '0';
  const slack = topUp ? Math.max(0, parseInt(process.env.LITE_TOPUP_SLACK, 10) || 1) : 0;
  const maxPages = Math.min(10, Math.ceil(want / 10) + slack);
  const timeoutMs = Math.max(1200, Math.min(15000, parseInt(process.env.LITE_GOOGLE_TIMEOUT_MS, 10) || 3500));
  const rounds = Math.max(1, Math.min(4, parseInt(process.env.LITE_GOOGLE_ROUNDS, 10) || 3));
  const proxies = await googleExits();
  const parser = PARSERS[engine] || PARSERS.google;
  // When the plain-HTTP path cannot serve this query (no residential exit),
  // the browser is not the last resort but the only option, so it is allowed
  // straight away.
  const httpUseful = googleLite.httpIsUseful(proxies, dork);

  for (let page = 0; page < maxPages; page += 1) {
    if (results.length >= want) break;
    if (deadlineAt && Date.now() + 800 > deadlineAt) break;
    let pack = null;
    let err = null;
    let exhausted = false;
    let added = 0;
    // A dork starts on the cheap surface, where the operator travels as
    // as_sitesearch/as_filetype. When that surface does not honour it, the
    // next round asks for the modern surface, and the round after that for a
    // browser. A plain query stays on the cheap surface.
    let classic = !dork;
    for (let round = 0; round < rounds; round += 1) {
      const lastRound = round === rounds - 1;
      // Respect the request budget. Without this the retry rounds can eat the
      // whole budget and leave nothing for the fallback engines, which is how a
      // dork ended up with no answer at all.
      if (deadlineAt && Date.now() + 1200 > deadlineAt) {
        exhausted = true;
        break;
      }
      // Exits that already answered without honouring the site: constraint are
      // skipped, so the retry lands on a different exit.
      const pool = proxies.filter((p) => !triedExits.has(p));
      const { url, geo } = googleLite.buildLiteUrl({
        q: query,
        num: Math.min(10, want - results.length),
        start: base + page * 10,
        hl,
        gl,
        tbs,
        before,
        after,
        classic,
      });
      try {
        const fetched = await googleLite.fetchGoogleLite({
          url,
          geo,
          proxies: pool.length ? pool : proxies,
          timeoutMs,
          // Chromium is by far the most expensive transport, so it is only used
          // once the cheap ones have used up their rounds. Without this a
          // single query could spend 12s per page inside the renderer.
          allowChrome: lastRound || !httpUseful,
          deadlineAt,
          // Reuse whatever worked for the previous page.
          prefer: transport,
          dork,
        });
        transport = fetched.transport || transport;
        if (!extras) extras = fetched.extras || parseExtras(fetched.html);
        let pageAdded = 0;
        for (const r of parser(fetched.html)) {
          if (!r || !r.url || seen.has(r.url)) continue;
          if (siteTargets.length && !matchesSite(r.url, siteTargets)) continue;
          seen.add(r.url);
          results.push(r);
          pageAdded += 1;
          if (results.length >= want) break;
        }
        pack = fetched;
        added += pageAdded;
        if (siteTargets.length && pageAdded === 0) {
          // Google answered, but it ignored the site: constraint here. That
          // happens on the cheap surface and on the exits that serve a
          // degraded SERP, so the answer is worth another try on the modern
          // surface and on another exit before it is given up on.
          if (fetched.proxy) triedExits.add(fetched.proxy);
          if (classic) {
            classic = false;
            continue;
          }
          if (!lastRound) continue;
          exhausted = true;
          lastErr = Object.assign(
            new Error(`Google did not honour the site: constraint for ${siteTargets.join(', ')}`),
            { code: 'DORK_UNMATCHED' },
          );
          break;
        }
        break;
      } catch (caught) {
        err = caught;
        if (lastRound) exhausted = true;
      }
    }
    if (!pack) {
      lastErr = err;
      break;
    }
    if (lastErr && lastErr.code === 'DORK_UNMATCHED') break;
    // Nothing new on this page means the next one will not help either.
    if (added === 0) break;
  }

  if (results.length === 0) {
    if (lastErr) throw lastErr;
    const e = new Error(`Engine "${engine}" returned no organic results on plain-HTTP page`);
    e.code = 'EMPTY_RESULTS';
    throw e;
  }

  return {
    results: results.slice(0, want),
    duration_ms: Date.now() - t0,
    extras,
    transport,
  };
}

async function fastLiteSearch({ engine, query, num = 10, hl = 'en', gl = 'us', start = 0, tbs, before, after, deadlineAt }) {
  const build = ENDPOINTS[engine];
  if (!build) {
    const e = new Error(`No lite endpoint for engine "${engine}"`);
    e.code = 'NO_LITE_ENDPOINT';
    throw e;
  }
  const google = engine === 'google' || engine === 'google_lite';
  if (google) {
    return googleLiteSearch({ engine, query, num, hl, gl, start, tbs, before, after, deadlineAt });
  }
  const kl = `${gl || 'us'}-${hl || 'en'}`;
  const parser = PARSERS[engine];
  const t0 = Date.now();
  const pageCount = Math.min(5, Math.max(1, Math.ceil(num / 10)));
  const results = [];
  const seen = new Set();
  let extras = null;
  let lastErr = null;
  const base = Math.max(0, Number(start) || 0);

  for (let i = 0; i < pageCount; i++) {
    if (results.length >= num) break;
    const url = build({ q: query, kl, s: base + i * 10, num, gl, hl, tbs, before, after });
    try {
      const pack = await fetchLitePage(url, engine);
      const html = typeof pack === 'string' ? pack : pack.html;
      if (google && !extras) extras = (pack && pack.extras) || require('./googleExtract').parseExtras(html);
      let added = 0;
      const parsed = google && pack && Array.isArray(pack.results) && pack.results.length ? pack.results : parser(html);
      for (const r of parsed) {
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
    extras,
  };
}

module.exports = {
  fastLiteSearch,
  ENDPOINTS,
  PARSERS,
  JSON_ENGINES,
  isBlockedPage,
  // Exported for tests and for the dork filter, which needs the real host.
  decodeBingHref,
  parseAnchorBlocks,
  matchesSite,
};
