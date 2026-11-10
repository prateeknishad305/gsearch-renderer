'use strict';

function endpoint() {
  return String(process.env.USER_LLM_PARSE_URL || '').trim();
}

function enabled() {
  return String(process.env.LLM_PARSE || '0') === '1' && !!endpoint();
}

async function extract(html, { timeoutMs = 4000 } = {}) {
  if (!enabled()) return null;
  const url = endpoint();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: String(html || '').slice(0, 120000) }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body) return null;
    const results = Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : [];
    const clean = results
      .filter((r) => r && /^https?:\/\//i.test(r.url || '') && (r.title || '').trim())
      .map((r) => ({ title: String(r.title).trim(), url: String(r.url), snippet: String(r.snippet || '') }));
    return clean.length ? clean : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { extract, enabled, endpoint };
