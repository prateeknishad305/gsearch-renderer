'use strict';

// Two Google surfaces that are not behind the JavaScript gate and therefore
// keep working from a datacenter IP, where the regular SERP is gated:
//
//   * Google Suggest  -> query completions
//   * Google News RSS -> recent articles
//
// The Programmable Search JSON API offers neither, so surfacing them is a
// direct quality win over GOOGLE_CSE_KEY / GOOGLE_CSE_CX.

const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`;

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function geoTags(hl, gl) {
  const lang = String(hl || 'en').slice(0, 8) || 'en';
  const country = String(gl || 'us').slice(0, 4).toUpperCase() || 'US';
  return { lang, country };
}

// Parses the JSONP-ish payload Google Suggest returns:
//   ["openai chat",["openai chat gpt","openai chat", ...]]
function parseSuggestPayload(body) {
  let raw = String(body || '').trim();
  if (!raw) return [];
  // Some clients get a XSSI prefix.
  raw = raw.replace(/^\)]}'[^\n]*\n/, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  const out = [];
  for (const item of data[1]) {
    const s = decodeEntities(stripTags(item));
    if (s) out.push(s);
  }
  return out;
}

async function suggest(query, { hl = 'en', gl = 'us', limit = 10, timeoutMs } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const { lang, country } = geoTags(hl, gl);
  const ms = Math.max(800, timeoutMs || intEnv('GOOGLE_SUGGEST_MS', 2500));
  const p = new URLSearchParams({
    client: 'firefox',
    q,
    hl: lang,
    gl: country.toLowerCase(),
  });
  const urls = [
    `https://suggestqueries.google.com/complete/search?${p.toString()}`,
    `https://www.google.com/complete/search?${p.toString()}&client=chrome`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(ms),
      });
      if (!resp.ok) continue;
      const body = await resp.text();
      const list = parseSuggestPayload(body);
      if (list.length) return list.slice(0, Math.max(1, limit));
    } catch {
      /* try the next host */
    }
  }
  return [];
}

// Parses the Google News RSS channel into plain records.
function parseNewsRss(xml) {
  const raw = String(xml || '');
  const out = [];
  const items = raw.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    const title = decodeEntities(stripTags((item.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    if (!title) continue;
    const link = decodeEntities((item.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    const pubDate = decodeEntities((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '').trim();
    const sourceTag = (item.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '';
    const sourceUrl = ((item.match(/<source[^>]*url="([^"]*)"/i) || [])[1] || '').trim();
    const source = decodeEntities(stripTags(sourceTag));
    const record = { title, link, pubDate };
    if (source) record.source = source;
    if (sourceUrl) record.sourceUrl = sourceUrl;
    out.push(record);
  }
  return out;
}

async function news(query, { hl = 'en', gl = 'us', limit = 10, timeoutMs } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const { lang, country } = geoTags(hl, gl);
  const ms = Math.max(1000, timeoutMs || intEnv('GOOGLE_NEWS_MS', 4000));
  const p = new URLSearchParams({ q, hl: `${lang}-${country}`, gl: country, ceid: `${country}:${lang}` });
  try {
    const resp = await fetch(`https://news.google.com/rss/search?${p.toString()}`, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(ms),
    });
    if (!resp.ok) return [];
    const body = await resp.text();
    return parseNewsRss(body).slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

module.exports = { suggest, news, parseSuggestPayload, parseNewsRss };
