'use strict';

const { ENGINES, names } = require('./lib/engines');
const { fastLiteSearch } = require('./lib/lite');
const { runQuery } = require('./lib/runner');
const { getShardPool, poolInfo, intEnv } = require('./lib/proxyPool');
const { getCache } = require('./lib/cache');
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');

const MAX_NUM = 100;
const MAX_PAGES = 5;
const MAX_QUERY_LEN = 512;

// Engines that have a plain-HTTP fast path. Turn the whole feature off with
// env LITE_FAST=0, or skip per-engine with LITE_FAST_<ENGINE>=0.
const LITE_ENGINES = new Set(['duckduckgo', 'duckduckgo_lite']);
function liteEnabled(engine) {
  return (
    LITE_ENGINES.has(engine) &&
    String(process.env.LITE_FAST || '1') !== '0' &&
    String(process.env[`LITE_FAST_${engine.toUpperCase()}`] || '1') !== '0'
  );
}

// Builds the ordered list of proxies to try for one page: random pool members
// (bounded by PROXY_ATTEMPTS) followed by a direct attempt unless disabled.
function buildTries(explicitProxy) {
  if (explicitProxy) return [explicitProxy];
  try {
    const { getLivePool, refreshLivePool } = require('./lib/proxyFetch');
    if (!getLivePool().length) refreshLivePool().catch(() => {});
  } catch {
    /* ignore */
  }
  const pool = getShardPool().sort(() => Math.random() - 0.5);
  const picks = Math.min(pool.length, intEnv('PROXY_ATTEMPTS', 2));
  const tries = pool.slice(0, picks);
  if (String(process.env.PROXY_FALLBACK_DIRECT) !== '0' || tries.length === 0) tries.push(null);
  return tries;
}

// Runs one engine, optionally across multiple result pages, merging unique URLs.
// Returns { results, duration_ms, attempts, proxy, source }.
async function searchEngine({ engine, query, num, pages = 1, start = 0, hl = 'en', gl = 'us', proxy, debug }) {
  if (!debug && liteEnabled(engine)) {
    try {
      const lite = await fastLiteSearch({ engine, query, num: num * pages, hl, gl });
      if (lite.results && lite.results.length) {
        return { results: lite.results.slice(0, num * pages), duration_ms: lite.duration_ms, attempts: 1, proxy: null, source: 'lite' };
      }
    } catch {
      /* fall through to Chromium */
    }
  }

  const pageCount = Math.min(Math.max(1, pages), MAX_PAGES);
  const offsets = [];
  for (let i = 0; i < pageCount; i++) offsets.push(start + i * num);

  const deadline = Date.now() + intEnv('PROXY_WINDOW_MS', 28000) * pageCount;
  const merged = [];
  const seen = new Set();
  let attempts = 0;
  let proxyUsed = null;
  let duration = 0;
  let lastErr = new Error('no search attempt could be made');

  for (const offset of offsets) {
    if (Date.now() > deadline) break;
    let pageResults = null;

    for (const candidate of buildTries(proxy)) {
      if (Date.now() > deadline) break;
      attempts += 1;
      try {
        const r = await runQuery({ engine, query, num, start: offset, hl, gl, proxy: candidate, debug });
        pageResults = r.results;
        duration += r.duration_ms;
        proxyUsed = candidate;
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'UNKNOWN_ENGINE') throw err;
      }
    }

    if (!pageResults) {
      if (merged.length === 0) throw lastErr;
      break; // got something from earlier pages; don't fail the whole request
    }
    for (const item of pageResults) {
      if (item && item.url && !seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    }
  }

  if (merged.length === 0) throw lastErr;
  return { results: merged.slice(0, num * pageCount), duration_ms: duration, attempts, proxy: proxyUsed, source: 'render' };
}

// Backwards-compatible single-engine entry point used by the gsearch-api
// integration and by callers that import renderSearch directly.
async function renderSearch(opts) {
  return searchEngine({ pages: 1, ...opts });
}

function parseEngineList(req) {
  const raw = req.query.engines ? String(req.query.engines) : String(req.query.engine || 'google');
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ['google'];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);

  const q = String(req.query.q || '').trim();
  if (!q) {
    return send(res, {
      service: 'gsearch-renderer',
      ok: true,
      usage:
        'GET /api/search?q=<query>&engine=<name>  OR  engines=<name,name,...>&num=&start=&pages=&hl=&gl=&proxy=&nocache=&token=',
      engines: names(),
      pool: poolInfo(),
      note:
        'engines= enables server-side fallback (tries each in order until one returns results). pages= merges multiple result pages per dork for more URLs. Results of successful queries are cached (CACHE_TTL_MS); pass nocache=1 to bypass.',
    });
  }
  if (q.length > MAX_QUERY_LEN) {
    return send(res, { error: `Query too long (max ${MAX_QUERY_LEN} chars)`, http_status: 400 });
  }

  const engineList = parseEngineList(req);
  const unknown = engineList.filter((e) => !ENGINES[e]);
  if (unknown.length) {
    return send(res, {
      error: `Unknown engine(s) "${unknown.join(', ')}". Available: ${names().join(', ')}`,
      http_status: 400,
    });
  }

  const num = Math.min(Math.max(1, Number(req.query.num) || 20), MAX_NUM);
  const pages = Math.min(Math.max(1, Number(req.query.pages) || 1), MAX_PAGES);
  const start = Math.max(0, Number(req.query.start) || 0);
  const hl = String(req.query.hl || 'en').slice(0, 8);
  const gl = String(req.query.gl || 'us').slice(0, 8);
  const proxy = String(req.query.proxy || '').trim();
  const debug = req.query.debug === '1';
  const useCache = req.query.nocache !== '1' && !debug && !proxy;

  const cache = getCache();
  const cacheKey = JSON.stringify(['v2', engineList.join(','), q, num, pages, start, hl, gl]);
  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit) return send(res, { ...hit, cached: true });
  }

  let lastErr = new Error('no engine produced a result');
  for (const engine of engineList) {
    try {
      const r = await searchEngine({ engine, query: q, num, pages, start, hl, gl, proxy, debug });
      const body = {
        engine,
        engines_tried: engineList.slice(0, engineList.indexOf(engine) + 1),
        query: q,
        success: true,
        count: r.results.length,
        results: r.results,
        duration_ms: r.duration_ms,
        attempts: r.attempts,
        source: r.source,
        proxy: maskProxy(r.proxy),
      };
      if (useCache && r.results.length) cache.set(cacheKey, body);
      return send(res, body);
    } catch (err) {
      if (err && err.code === 'UNKNOWN_ENGINE') {
        return send(res, { error: err.message, http_status: 400 });
      }
      lastErr = err;
    }
  }

  return send(res, {
    engine: engineList[0],
    engines_tried: engineList,
    query: q,
    success: false,
    code: lastErr.code || 'ERROR',
    error: lastErr.message,
    count: 0,
    results: [],
  });
};

module.exports.config = { maxDuration: 60, memory: 1024 };
module.exports.renderSearch = renderSearch;
module.exports.searchEngine = searchEngine;
