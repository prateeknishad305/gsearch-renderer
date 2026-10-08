'use strict';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toOrganic(results) {
  const organic = [];
  const seen = new Set();
  let position = 0;
  for (const r of results || []) {
    if (!r || !r.url || !r.title) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    position += 1;
    organic.push({
      title: String(r.title).trim(),
      link: r.url,
      snippet: r.snippet ? String(r.snippet).trim() : '',
      position,
    });
  }
  return organic;
}

function toSerperBody({ q, gl, hl, num, page, type, engine, results, durationMs }) {
  return {
    searchParameters: {
      q,
      gl: gl || 'us',
      hl: hl || 'en',
      type: type || 'search',
      num: num || 10,
      page: page || 1,
      engine: engine || 'google',
    },
    organic: toOrganic(results),
    credits: 1,
    duration_ms: durationMs || 0,
  };
}

const SERPER_FALLBACKS = [];

function fallbackEngines(primary, start) {
  void primary;
  void start;
  return [];
}

function parseSerperInput(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const q = String(body.q || body.query || (req.query && req.query.q) || '').trim();
  const gl = String(body.gl || (req.query && req.query.gl) || 'us').slice(0, 8);
  const hl = String(body.hl || (req.query && req.query.hl) || 'en').slice(0, 8);
  const num = Math.min(100, Math.max(1, Number(body.num != null ? body.num : req.query && req.query.num) || 10));
  const page = Math.min(10, Math.max(1, Number(body.page != null ? body.page : req.query && req.query.page) || 1));
  const type = String(body.type || (req.query && req.query.type) || 'search').toLowerCase();
  const engine = String(body.engine || (req.query && req.query.engine) || 'google').toLowerCase();
  const nocache = body.nocache === true || (req.query && req.query.nocache === '1');
  return { q, gl, hl, num, page, type, engine, nocache };
}

module.exports = { hostOf, toOrganic, toSerperBody, parseSerperInput, fallbackEngines, SERPER_FALLBACKS };
