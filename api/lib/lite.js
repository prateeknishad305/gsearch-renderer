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
  google_lite: ({ q, s, gl, hl }) => {
    try {
      return require('./google').buildSearchUrl({ q, num: 10, start: s || 0, hl, gl });
    } catch {
      const p = new URLSearchParams({ q, hl: hl || 'en', gl: gl || 'us', start: String(s || 0) });
      return `https://www.google.com/search?${p.toString()}`;
    }
  },
  google: ({ q, s, gl, hl }) => {
    try {
      return require('./google').buildSearchUrl({ q, num: 10, start: s || 0, hl, gl });
    } catch {
      const p = new URLSearchParams({ q, hl: hl || 'en', gl: gl || 'us', start: String(s || 0) });
      return `https://www.google.com/search?${p.toString()}`;
    }
  },
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
  function citeToUrl(cite) {
    let t = decodeEntities(stripTags(cite)).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const parts = t.split(/\s*›\s*/).map((s) => s.trim()).filter(Boolean);
    let hostPart = parts[0] || '';
    if (!hostPart) return '';
    if (!/^https?:\/\//i.test(hostPart)) hostPart = `https://${hostPart.replace(/^\/+/, '')}`;
    try {
      const u = new URL(hostPart);
      const extra = parts[1] || '';
      if (extra && extra !== '...' && !/\s/.test(extra) && extra.length < 180) {
        const path = extra.startsWith('/') ? extra : `/${extra}`;
        return `${u.origin}${path}`;
      }
      return `${u.origin}/`;
    } catch {
      return '';
    }
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
  function push(title, url) {
    title = decodeEntities(stripTags(title));
    url = resolveUrl(url);
    if (!title || title.length < 3 || title.length > 200) return;
    if (isGarbageUrl(url) || isAiModeTitle(title)) return;
    if (!/^https?:\/\//i.test(url) || skipHost(url) || seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  }
  const re =
    /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  while ((m = re.exec(html))) {
    push(m[2] || m[4] || '', m[1] || m[3] || '');
  }
  if (results.length === 0) {
    const re2 = /href="(\/url\?q=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(html))) push(m[2], m[1]);
  }
  if (results.length === 0) {
    const re3 = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    while ((m = re3.exec(html))) push(m[2], m[1]);
  }
  if (results.length === 0) {
    const h3re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    while ((m = h3re.exec(html))) {
      const after = html.slice(m.index, m.index + 1800);
      const cite = after.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
      if (cite) push(m[1], citeToUrl(cite[1]));
    }
  }
  return results;
}

function parseMojeekLite(html) {
  const news = parseAnchorBlocks(html, {
    hostRe: /mojeek\.com$/i,
    titleRe: /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
  if (news.length) return news;
  return parseAnchorBlocks(html, {
    hostRe: /mojeek\.com$/i,
    titleRe: /<a[^>]+class="[^"]*\bob\b[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
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
    if (/\/sorry\//i.test(raw) || /id="captcha"/i.test(low)) return true;
    if (/<h3/i.test(raw) || /<cite/i.test(raw) || /\/url\?q=/i.test(raw)) return false;
    return true;
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
    if (engine === 'google' || engine === 'google_lite') {
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
  const timeoutMs = Math.max(12000, parseInt(process.env.CHROME_FETCH_MS, 10) || 15000);
  const pool = liveProxies(engine).filter(Boolean);
  const tries = pool.length ? pool.slice(0, 1) : [];
  if (!tries.length) {
    const e = new Error('no proxy');
    e.code = 'NO_PROXY';
    throw e;
  }
  let lastErr = null;
  for (const proxy of tries) {
    try {
      const r = await chromeFetch.fetchHtml(url, { proxy, timeoutMs });
      const loc = r && r.finalUrl;
      if (loc && /\/sorry\//i.test(loc)) {
        lastErr = Object.assign(new Error('sorry'), { code: 'BLOCKED' });
        continue;
      }
      if (r.status && r.status !== 200 && r.status !== 0 && r.status !== 302) {
        lastErr = Object.assign(new Error(`status ${r.status}`), { code: 'LITE_HTTP_ERROR' });
        continue;
      }
      const html = r && r.html;
      if (!html || isBlockedPage(html, engine)) {
        lastErr = Object.assign(new Error('blocked'), { code: 'BLOCKED' });
        continue;
      }
      return html;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  const e = new Error('chrome fetch empty');
  e.code = 'LITE_EMPTY';
  throw e;
}

async function fetchLitePage(url, engine) {
  const headers = {
    'user-agent': UA,
    'accept-language': 'en-US,en;q=0.9',
    accept: JSON_ENGINES.has(engine) ? 'application/json' : 'text/html,application/xhtml+xml',
  };
  if (engine === 'google' || engine === 'google_lite') {
    try {
      return await fetchChromeGoogle(url, engine);
    } catch (err) {
      const e = new Error(`Lite fetch failed: ${(err && err.message) || 'chrome'}`);
      e.code = (err && err.code) || 'LITE_FETCH_ERROR';
      throw e;
    }
  }
  try {
    return await fetchDirect(url, engine, headers);
  } catch (directErr) {
    try {
      return await raceProxyFetch(url, engine, 4000);
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

module.exports = { fastLiteSearch, ENDPOINTS, PARSERS, JSON_ENGINES, isBlockedPage };
