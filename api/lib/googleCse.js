'use strict';

// Official Google Programmable Search (Custom Search JSON API) client.
// This is the only datacenter-friendly, ToS-compliant way to get real Google
// results without residential proxies. Free tier: 100 queries/day.
//
// Enable by setting:
//   GOOGLE_CSE_KEY=<api key from console.cloud.google.com>
//   GOOGLE_CSE_CX=<programmable search engine id (https://programmablesearchengine.google.com)>
//
// Optional:
//   GOOGLE_CSE_SAFE=active|off        (default off)
//   GOOGLE_CSE_GL / GOOGLE_CSE_HL     (defaults come from the request)

const MAX_PER_PAGE = 10;

function configured() {
  return Boolean(String(process.env.GOOGLE_CSE_KEY || '').trim() && String(process.env.GOOGLE_CSE_CX || '').trim());
}

function normalizeLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link);
    return u.href;
  } catch {
    return /^https?:\/\//i.test(link) ? link : '';
  }
}

function mapItems(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const url = normalizeLink(it.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(it.title || '').replace(/\s+/g, ' ').trim(),
      url,
      snippet: String(it.snippet || '').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

async function fetchPage({ q, num, start, hl, gl }) {
  const key = String(process.env.GOOGLE_CSE_KEY || '').trim();
  const cx = String(process.env.GOOGLE_CSE_CX || '').trim();
  const p = new URLSearchParams({
    key,
    cx,
    q,
    num: String(Math.min(MAX_PER_PAGE, Math.max(1, num || MAX_PER_PAGE))),
    start: String(Math.max(1, (Number(start) || 0) + 1)),
  });
  if (hl) p.set('hl', hl);
  if (gl) p.set('gl', gl);
  const safe = String(process.env.GOOGLE_CSE_SAFE || '').toLowerCase();
  if (safe === 'active' || safe === 'off') p.set('safe', safe);

  const timeoutMs = Math.max(2000, parseInt(process.env.GOOGLE_CSE_MS, 10) || 8000);
  const resp = await fetch(`https://www.googleapis.com/customsearch/v1?${p.toString()}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (body && body.error && (body.error.message || body.error.status)) || `status ${resp.status}`;
    const e = new Error(`Google CSE: ${msg}`);
    e.code = resp.status === 429 || /quota|rate/i.test(String(msg)) ? 'CSE_QUOTA' : 'CSE_ERROR';
    throw e;
  }
  return mapItems(body.items);
}

async function cseSearch({ query, num = 10, hl = 'en', gl = 'us', start = 0 }) {
  if (!configured()) {
    const e = new Error('Google CSE not configured (set GOOGLE_CSE_KEY and GOOGLE_CSE_CX)');
    e.code = 'CSE_DISABLED';
    throw e;
  }
  const want = Math.max(1, Math.min(100, Number(num) || 10));
  const base = Math.max(0, Number(start) || 0);
  const results = [];
  const seen = new Set();
  const t0 = Date.now();
  let offset = base;
  // CSE returns max 10/request and only the first 100 results are reachable.
  while (results.length < want && offset < base + 100) {
    const page = await fetchPage({ q: query, num: Math.min(MAX_PER_PAGE, want - results.length), start: offset, hl, gl });
    if (!page.length) break;
    for (const r of page) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
    offset += MAX_PER_PAGE;
  }
  return { results: results.slice(0, want), duration_ms: Date.now() - t0 };
}

module.exports = { configured, cseSearch };
