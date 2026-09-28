'use strict';

const { crawl, MAX_PAGES, MAX_DEPTH } = require('./lib/crawler');
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');
const stats = require('./lib/stats');

function parseBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).toLowerCase();
  if (s === '0' || s === 'false' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'yes') return true;
  return defaultVal;
}

function paramsFrom(req) {
  const src = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : req.query || {};
  return {
    url: String(src.url || src.start_url || '').trim(),
    maxPages: src.max_pages !== undefined ? src.max_pages : src.maxPages,
    maxDepth: src.max_depth !== undefined ? src.max_depth : src.maxDepth,
    sameOrigin: src.same_origin !== undefined ? src.same_origin : src.sameOrigin,
    proxy: String(src.proxy || '').trim(),
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);

  if (req.method === 'POST' && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      return send(res, { error: 'Invalid JSON body', http_status: 400 });
    }
  }

  const p = paramsFrom(req);
  if (!p.url) {
    return send(res, {
      service: 'gsearch-renderer',
      ok: true,
      usage:
        'GET /api/crawl?url=<https://example.com>&max_pages=&max_depth=&same_origin=1&proxy=&token=. POST JSON is also accepted.',
      note:
        'Same-origin BFS crawler with private/local host block, Chromium render, and page/depth/budget caps (MAX_PAGES=20, MAX_DEPTH=3).',
    });
  }

  const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(p.maxPages) || 8));
  const maxDepth = Math.min(MAX_DEPTH, Math.max(0, Number(p.maxDepth) || 1));
  const sameOriginOnly = parseBool(p.sameOrigin, true);
  const t0 = Date.now();

  try {
    const r = await crawl({
      url: p.url,
      maxPages,
      maxDepth,
      sameOriginOnly,
      proxy: p.proxy || undefined,
    });
    stats.recordCrawl();
    return send(res, {
      success: true,
      start_url: r.start_url,
      crawled: r.crawled,
      queued: r.queued,
      pages: r.pages,
      duration_ms: Date.now() - t0,
      response_time_ms: Date.now() - t0,
      proxy: maskProxy(r.proxy),
      max_pages: maxPages,
      max_depth: maxDepth,
      same_origin: sameOriginOnly,
    });
  } catch (err) {
    const code = (err && err.code) || 'ERROR';
    const bad = code === 'INVALID_URL' || code === 'BLOCKED_URL';
    return send(res, {
      success: false,
      code,
      error: err.message,
      crawled: 0,
      pages: [],
      duration_ms: Date.now() - t0,
      response_time_ms: Date.now() - t0,
      http_status: bad ? 400 : undefined,
    });
  }
};

module.exports.config = { maxDuration: 60, memory: 1024 };
module.exports.parseBool = parseBool;
module.exports.paramsFrom = paramsFrom;
