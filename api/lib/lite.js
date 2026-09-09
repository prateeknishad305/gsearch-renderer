'use strict';

// Plain-HTTP (no Chromium) SERP fetcher for engines that tolerate scraping.
// Used as a fast path before any browser render is attempted, so a dork that
// would normally take 15-19s through headless Chromium + proxy rotation can
// resolve in ~1s. Engines here must serve enough organic links to static HTML.
//
// Supported engines (config key => endpoint):
//   duckduckgo       -> https://html.duckduckgo.com/html/
//   duckduckgo_lite  -> https://lite.duckduckgo.com/lite/

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENDPOINTS = {
  duckduckgo: ({ q, kl }) =>
    `https://html.duckduckgo.com/html/?${new URLSearchParams({ q, kl }).toString()}`,
  duckduckgo_lite: ({ q }) =>
    `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q }).toString()}`,
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
};

function isBlockedPage(html, engine) {
  const low = html.toLowerCase();
  if (/\banomaly/i.test(low)) return true; // DDG robot detection
  if (engine === 'duckduckgo' && /id="captcha"/i.test(low)) return true;
  return false;
}

async function fastLiteSearch({ engine, query, num = 20, hl = 'en', gl = 'us' }) {
  const build = ENDPOINTS[engine];
  if (!build) {
    const e = new Error(`No lite endpoint for engine "${engine}"`);
    e.code = 'NO_LITE_ENDPOINT';
    throw e;
  }
  const kl = `${gl || 'us'}-${hl || 'en'}`;
  const url = build({ q: query, kl });
  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`Lite fetch failed: ${err.message}`);
    e.code = 'LITE_FETCH_ERROR';
    throw e;
  }

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

  const parser = PARSERS[engine];
  const results = [];
  const seen = new Set();
  for (const r of parser(html)) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    results.push(r);
  }

  if (results.length === 0) {
    const e = new Error(`Engine "${engine}" returned no organic results on plain-HTTP page`);
    e.code = 'EMPTY_RESULTS';
    throw e;
  }

  return {
    results: results.slice(0, Math.min(num, results.length)),
    duration_ms: Date.now() - t0,
  };
}

module.exports = { fastLiteSearch, ENDPOINTS };
