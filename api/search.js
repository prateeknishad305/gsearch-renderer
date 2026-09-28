'use strict';

const { ENGINES, names } = require('./lib/engines');
const { fastLiteSearch, ENDPOINTS } = require('./lib/lite');
const { runQuery } = require('./lib/runner');
const { getShardPool, getUserProxies, poolInfo, intEnv } = require('./lib/proxyPool');
const { getCache } = require('./lib/cache');
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');
const circuit = require('./lib/circuit');
const stats = require('./lib/stats');

const MAX_NUM = 100;
const MAX_PAGES = 10;
const MAX_QUERY_LEN = 512;
const GOOGLE_PAGE_SIZE = 10;
const FIXED_PAGE_SIZE = { google: 10, yahoo: 10 };

// Google removed &num=100 (10 organic hits/page). Yahoo also ignores n>10 and
// serves ~7-10. Paginate those with start=0,10,20,... Other engines keep a
// higher per-page num.
function pageStep(engine, num) {
  if (FIXED_PAGE_SIZE[engine]) return FIXED_PAGE_SIZE[engine];
  return Math.max(1, num);
}

function perPageNum(engine, num) {
  if (FIXED_PAGE_SIZE[engine]) return FIXED_PAGE_SIZE[engine];
  return Math.min(MAX_NUM, Math.max(1, num));
}

function autoPageCount(engine, num) {
  if (!FIXED_PAGE_SIZE[engine]) return 1;
  const step = FIXED_PAGE_SIZE[engine];
  return Math.min(MAX_PAGES, Math.max(1, Math.ceil(Math.max(1, num) / step)));
}

// Engines that have a plain-HTTP fast path. Turn the whole feature off with
// env LITE_FAST=0, or skip per-engine with LITE_FAST_<ENGINE>=0.
const LITE_ENGINES = new Set(Object.keys(ENDPOINTS));
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
  const user = getUserProxies().length > 0;
  const picks = Math.min(pool.length, intEnv('PROXY_ATTEMPTS', user ? 1 : 2));
  const tries = pool.slice(0, picks);
  const fallbackDefault = user ? '0' : '1';
  const fallbackDirect = String(process.env.PROXY_FALLBACK_DIRECT || fallbackDefault) !== '0';
  if (fallbackDirect || tries.length === 0) tries.push(null);
  return tries;
}

// Runs one engine, optionally across multiple result pages, merging unique URLs.
// autoPages=true keeps fetching until `num` unique URLs (or MAX_PAGES).
async function searchEngine({ engine, query, num, pages = 1, start = 0, hl = 'en', gl = 'us', proxy, debug, autoPages = false }) {
  const pageCount = Math.min(Math.max(1, pages), MAX_PAGES);
  const step = pageStep(engine, num);
  const perPage = perPageNum(engine, num);
  const cap = Math.min(MAX_NUM, autoPages ? Math.max(num, 1) : num * pageCount);

  if (!debug && liteEnabled(engine)) {
    try {
      const lite = await fastLiteSearch({ engine, query, num: cap, hl, gl });
      if (lite.results && lite.results.length) {
        circuit.record(engine, 'OK');
        return {
          results: lite.results.slice(0, cap),
          duration_ms: lite.duration_ms,
          attempts: 1,
          proxy: null,
          source: 'lite',
          pages_fetched: 1,
          pages_requested: pageCount,
        };
      }
    } catch {
      /* fall through to Chromium */
    }
  }

  if (circuit.isOpen(engine)) {
    const e = new Error(`Engine "${engine}" circuit open after repeated failures`);
    e.code = 'CIRCUIT_OPEN';
    throw e;
  }

  const deadline = Date.now() + intEnv('PROXY_WINDOW_MS', 28000) * pageCount;
  const merged = [];
  const seen = new Set();
  let attempts = 0;
  let pagesFetched = 0;
  let proxyUsed = null;
  let duration = 0;
  let lastErr = new Error('no search attempt could be made');

  async function fetchPage(offset) {
    let pageResults = null;
    let used = null;
    let dur = 0;
    let localAttempts = 0;
    let err = lastErr;
    for (const candidate of buildTries(proxy)) {
      if (Date.now() > deadline) break;
      localAttempts += 1;
      try {
        const r = await runQuery({ engine, query, num: perPage, start: offset, hl, gl, proxy: candidate, debug });
        pageResults = r.results;
        dur = r.duration_ms;
        used = candidate;
        break;
      } catch (caught) {
        err = caught;
        if (caught && caught.code === 'UNKNOWN_ENGINE') throw caught;
      }
    }
    return { pageResults, used, dur, localAttempts, err };
  }

  const parallel = pageCount > 1 && String(process.env.PAGE_PARALLEL || '1') !== '0';
  if (parallel) {
    const jobs = [];
    for (let i = 0; i < pageCount; i++) jobs.push(fetchPage(start + i * step));
    const settled = await Promise.all(jobs);
    for (const one of settled) {
      attempts += one.localAttempts;
      lastErr = one.err || lastErr;
      if (!one.pageResults) continue;
      pagesFetched += 1;
      duration += one.dur;
      if (one.used) proxyUsed = one.used;
      for (const item of one.pageResults) {
        if (item && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
    }
  } else {
    for (let i = 0; i < pageCount; i++) {
      if (Date.now() > deadline) break;
      const one = await fetchPage(start + i * step);
      attempts += one.localAttempts;
      lastErr = one.err || lastErr;
      if (!one.pageResults) {
        if (merged.length === 0) throw lastErr;
        break;
      }
      pagesFetched += 1;
      duration += one.dur;
      proxyUsed = one.used;
      for (const item of one.pageResults) {
        if (item && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
      if (one.pageResults.length === 0) break;
      if (autoPages && merged.length >= num) break;
    }
  }

  if (merged.length === 0) {
    circuit.record(engine, lastErr && lastErr.code ? lastErr.code : 'ERROR');
    throw lastErr;
  }
  circuit.record(engine, 'OK');
  return {
    results: merged.slice(0, autoPages ? Math.min(MAX_NUM, merged.length) : cap),
    duration_ms: duration,
    attempts,
    proxy: proxyUsed,
    source: 'render',
    pages_fetched: pagesFetched,
    pages_requested: pageCount,
  };
}

// Backwards-compatible single-engine entry point used by the gsearch-api
// integration and by callers that import renderSearch directly.
async function renderSearch(opts) {
  return searchEngine({ pages: 1, ...opts });
}

function parseEngineList(req) {
  const raw = req.query.engines ? String(req.query.engines) : String(req.query.engine || 'google');
  if (raw.trim() === '*' || raw.trim().toLowerCase() === 'all') return names();
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ['google'];
}

function mergeUnique(lists, cap) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= cap) return out;
    }
  }
  return out;
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
        'GET /api/search?q=<query>&engine=<name>  OR  engines=<name,name,...|&*>  mode=fallback|merge  num= pages= hl= gl= proxy= nocache= token=',
      engines: names(),
      pool: poolInfo(),
      note:
        'engines= fallback in order (default). mode=merge runs listed engines in parallel and unions unique URLs. engines=* tries every engine. Lite HTTP is used first when the engine serves static SERP HTML.',
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
  const pagesGiven = req.query.pages !== undefined && req.query.pages !== '';
  const autoPages = !pagesGiven;
  const pages = pagesGiven
    ? Math.min(Math.max(1, Number(req.query.pages) || 1), MAX_PAGES)
    : Math.max(...engineList.map((e) => autoPageCount(e, num)));
  const start = Math.max(0, Number(req.query.start) || 0);
  const hl = String(req.query.hl || 'en').slice(0, 8);
  const gl = String(req.query.gl || 'us').slice(0, 8);
  const proxy = String(req.query.proxy || '').trim();
  const debug = req.query.debug === '1';
  const mode = String(req.query.mode || 'fallback').toLowerCase() === 'merge' ? 'merge' : 'fallback';
  const useCache = req.query.nocache !== '1' && !debug && !proxy;
  const t0 = Date.now();

  const cache = getCache();
  const cacheKey = JSON.stringify(['v4', engineList.join(','), mode, q, num, pagesGiven ? pages : 'auto', start, hl, gl]);
  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return send(res, { ...hit, cached: true, response_time_ms: Date.now() - t0 });
    }
  }

  if (mode === 'merge' && engineList.length > 1) {
    const settled = await Promise.all(
      engineList.map(async (engine) => {
        try {
          const r = await searchEngine({ engine, query: q, num, pages, start, hl, gl, proxy, debug, autoPages });
          return { engine, ok: true, r };
        } catch (err) {
          return { engine, ok: false, err };
        }
      })
    );
    const ok = settled.filter((s) => s.ok && s.r && s.r.results && s.r.results.length);
    const results = mergeUnique(ok.map((s) => s.r.results), num);
    const duration = Math.max(0, ...ok.map((s) => s.r.duration_ms || 0));
    const body = {
      engine: ok.length ? ok.map((s) => s.engine).join(',') : engineList[0],
      engines_tried: engineList,
      engines_ok: ok.map((s) => s.engine),
      mode: 'merge',
      query: q,
      success: results.length > 0,
      count: results.length,
      results,
      duration_ms: duration,
      response_time_ms: Date.now() - t0,
      source: ok.map((s) => s.r.source).filter(Boolean).join(',') || 'none',
    };
    stats.recordSearch({
      engine: body.engine,
      ok: body.success,
      source: ok[0] && ok[0].r.source,
      duration_ms: Date.now() - t0,
      code: body.success ? 'OK' : 'EMPTY_RESULTS',
    });
    if (useCache && results.length) cache.set(cacheKey, body);
    return send(res, body);
  }

  let lastErr = new Error('no engine produced a result');
  for (const engine of engineList) {
    try {
      const r = await searchEngine({ engine, query: q, num, pages, start, hl, gl, proxy, debug, autoPages });
      const body = {
        engine,
        engines_tried: engineList.slice(0, engineList.indexOf(engine) + 1),
        query: q,
        success: true,
        count: r.results.length,
        results: r.results,
        duration_ms: r.duration_ms,
        response_time_ms: Date.now() - t0,
        attempts: r.attempts,
        pages_fetched: r.pages_fetched,
        pages_requested: r.pages_requested,
        source: r.source,
        proxy: maskProxy(r.proxy),
      };
      stats.recordSearch({ engine, ok: true, source: r.source, duration_ms: Date.now() - t0, code: 'OK' });
      if (useCache && r.results.length) cache.set(cacheKey, body);
      return send(res, body);
    } catch (err) {
      if (err && err.code === 'UNKNOWN_ENGINE') {
        return send(res, { error: err.message, http_status: 400, response_time_ms: Date.now() - t0 });
      }
      lastErr = err;
    }
  }

  stats.recordSearch({
    engine: engineList[0],
    ok: false,
    source: null,
    duration_ms: Date.now() - t0,
    code: lastErr.code || 'ERROR',
  });
  return send(res, {
    engine: engineList[0],
    engines_tried: engineList,
    query: q,
    success: false,
    code: lastErr.code || 'ERROR',
    error: lastErr.message,
    count: 0,
    results: [],
    duration_ms: Date.now() - t0,
    response_time_ms: Date.now() - t0,
  });
};

module.exports.config = { maxDuration: 60, memory: 1024 };
module.exports.renderSearch = renderSearch;
module.exports.searchEngine = searchEngine;
module.exports.pageStep = pageStep;
module.exports.perPageNum = perPageNum;
module.exports.autoPageCount = autoPageCount;
module.exports.GOOGLE_PAGE_SIZE = GOOGLE_PAGE_SIZE;
module.exports.MAX_PAGES = MAX_PAGES;
