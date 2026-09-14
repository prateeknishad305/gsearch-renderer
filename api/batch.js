'use strict';

const { ENGINES, names } = require('./lib/engines');
const { searchEngine } = require('./search');
const { poolInfo } = require('./lib/proxyPool');
const { getCache } = require('./lib/cache');
const { send, cors, authOk, unauthorized } = require('./lib/http');

const MAX_QUERIES = Math.min(20, Math.max(1, parseInt(process.env.BATCH_MAX || '6', 10) || 6));
const BATCH_BUDGET_MS = Math.max(5000, parseInt(process.env.BATCH_BUDGET_MS || '50000', 10) || 50000);

function parseEngines(body) {
  const raw = body.engines || body.engine || 'google';
  const list = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ['google'];
}

// POST /api/batch
// body: { queries: ["dork1","dork2",...], engines?: "google,bing", num?, pages?, hl?, gl? }
//
// Runs several dorks in ONE HTTP call on the shared pooled browser. Fits the
// platform's single-connection / concurrency limits far better than N parallel
// requests, and amortises container warm-up across the whole batch. Stops early
// when the time budget is exhausted so the function always returns before the
// serverless timeout; remaining queries come back with code TIME_BUDGET.
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return send(res, { error: 'Invalid JSON body', http_status: 400 });
    }
  }
  if (!body || typeof body !== 'object') {
    return send(res, { error: 'JSON body required', http_status: 400 });
  }

  let queries = body.queries;
  if (!Array.isArray(queries)) return send(res, { error: 'queries must be an array', http_status: 400 });
  queries = queries.map((qq) => String(qq || '').trim()).filter(Boolean);
  if (!queries.length) return send(res, { error: 'queries is empty', http_status: 400 });
  if (queries.length > MAX_QUERIES) {
    return send(res, { error: `Too many queries (max ${MAX_QUERIES})`, http_status: 400 });
  }

  const engineList = parseEngines(body);
  const unknown = engineList.filter((e) => !ENGINES[e]);
  if (unknown.length) {
    return send(res, { error: `Unknown engine(s) "${unknown.join(', ')}". Available: ${names().join(', ')}`, http_status: 400 });
  }

  const num = Math.min(Math.max(1, Number(body.num) || 20), 100);
  const pages = Math.min(Math.max(1, Number(body.pages) || 1), 5);
  const hl = String(body.hl || 'en').slice(0, 8);
  const gl = String(body.gl || 'us').slice(0, 8);
  const useCache = body.nocache !== true;
  const cache = getCache();

  const started = Date.now();
  const out = [];

  for (const query of queries) {
    if (Date.now() - started > BATCH_BUDGET_MS) {
      out.push({ query, success: false, code: 'TIME_BUDGET', error: 'Batch time budget exhausted', count: 0, results: [] });
      continue;
    }

    const cacheKey = JSON.stringify(['v2', engineList.join(','), query, num, pages, 0, hl, gl]);
    if (useCache) {
      const hit = cache.get(cacheKey);
      if (hit) {
        out.push({ query, success: true, engine: hit.engine, cached: true, count: hit.count, results: hit.results });
        continue;
      }
    }

    let settled = null;
    let lastErr = new Error('no engine produced a result');
    for (const engine of engineList) {
      try {
        const r = await searchEngine({ engine, query, num, pages, start: 0, hl, gl });
        settled = r;
        const item = {
          query,
          success: true,
          engine,
          count: r.results.length,
          results: r.results,
          duration_ms: r.duration_ms,
          attempts: r.attempts,
          source: r.source,
        };
        out.push(item);
        if (useCache && r.results.length) {
          cache.set(cacheKey, { engine, count: r.results.length, results: r.results });
        }
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!settled) {
      out.push({ query, success: false, code: lastErr.code || 'ERROR', error: lastErr.message, count: 0, results: [] });
    }
  }

  return send(res, {
    success: true,
    batch_size: queries.length,
    completed: out.filter((o) => o.success).length,
    duration_ms: Date.now() - started,
    pool: poolInfo(),
    results: out,
  });
};

module.exports.config = { maxDuration: 60, memory: 1024 };
