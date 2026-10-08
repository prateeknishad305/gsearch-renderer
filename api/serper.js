'use strict';

const { ENGINES, names } = require('./lib/engines');
const { searchEngine, autoPageCount } = require('./search');
const { getCache } = require('./lib/cache');
const { send, cors, authOk } = require('./lib/http');
const stats = require('./lib/stats');
const { toSerperBody, parseSerperInput, fallbackEngines } = require('./lib/serperShape');

function usage() {
  return {
    service: 'gsearch-renderer',
    ok: true,
    usage: 'POST /search JSON { "q": "<query>", "gl": "us", "hl": "en", "num": 10, "page": 1 }  (serper.dev compatible)',
    drop_in: {
      serper: 'https://google.serper.dev/search',
      here: 'POST /search  or  POST /api/serper',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': '<API_TOKEN if set>' },
    },
    engines: names(),
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method === 'GET' && !String((req.query && req.query.q) || '').trim()) {
    return send(res, usage());
  }
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'GET') {
    return send(res, { message: 'Method not allowed', statusCode: 405, http_status: 405 });
  }
  if (!authOk(req)) {
    cors(res);
    return res.status(401).json({ message: 'Unauthorized', statusCode: 401 });
  }

  let body = req.body;
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, { message: 'Invalid JSON body', statusCode: 400, http_status: 400 });
      }
    }
  }
  req.body = body;
  const input = parseSerperInput(req);
  if (!input.q) {
    return send(res, { message: 'Query is required', statusCode: 400, http_status: 400 });
  }
  if (!ENGINES[input.engine]) {
    return send(res, {
      message: `Unknown engine "${input.engine}". Available: ${names().join(', ')}`,
      statusCode: 400,
      http_status: 400,
    });
  }

  const start = (input.page - 1) * 10;
  const pages = autoPageCount(input.engine, input.num);
  const t0 = Date.now();
  const cache = getCache();
  const cacheKey = JSON.stringify(['serper', input.engine, input.q, input.num, input.page, input.hl, input.gl]);
  if (!input.nocache) {
    const hit = cache.get(cacheKey);
    if (hit) return send(res, { ...hit, cached: true });
  }

  let lastErr = null;
  const engines = [input.engine, ...fallbackEngines(input.engine, start)];

  async function tryOne(engine, liteOnly) {
    if (!ENGINES[engine]) return null;
    const r = await searchEngine({
      engine,
      query: input.q,
      num: input.num,
      pages: engine === input.engine ? pages : 1,
      start: engine === input.engine ? start : 0,
      hl: input.hl,
      gl: input.gl,
      autoPages: true,
      liteOnly,
    });
    if (!r || !r.results || !r.results.length) return null;
    const out = toSerperBody({
      q: input.q,
      gl: input.gl,
      hl: input.hl,
      num: input.num,
      page: input.page,
      type: input.type,
      engine: input.engine,
      results: r.results,
      durationMs: Date.now() - t0,
    });
    if (!out.organic.length) return null;
    stats.recordSearch({ engine, ok: true, source: r.source, duration_ms: Date.now() - t0, code: 'OK' });
    if (!input.nocache) cache.set(cacheKey, out);
    return out;
  }

  try {
    const lite = await tryOne(input.engine, true);
    if (lite) return send(res, lite);
  } catch (err) {
    lastErr = err;
  }

  if (String(process.env.SERPER_RENDER || '0') === '1') {
    for (const engine of engines) {
      try {
        const out = await tryOne(engine, false);
        if (out) return send(res, out);
      } catch (err) {
        lastErr = err;
      }
    }
  }

  stats.recordSearch({
    engine: input.engine,
    ok: false,
    source: null,
    duration_ms: Date.now() - t0,
    code: (lastErr && lastErr.code) || 'ERROR',
  });
  return send(res, {
    searchParameters: {
      q: input.q,
      gl: input.gl,
      hl: input.hl,
      type: input.type,
      num: input.num,
      page: input.page,
      engine: input.engine,
    },
    organic: [],
    credits: 1,
    duration_ms: Date.now() - t0,
  });
};

module.exports.config = { maxDuration: 60, memory: 1024 };
