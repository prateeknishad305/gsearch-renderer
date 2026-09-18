'use strict';

const { names } = require('./lib/engines');
const { poolInfo } = require('./lib/proxyPool');
const { stats: browserStats } = require('./lib/browserPool');
const { getCache } = require('./lib/cache');
const { runtimeInfo } = require('./lib/chromium');
const { send, cors } = require('./lib/http');

// GET /api/health - cheap liveness/rotation introspection for load balancers
// and for the operator to confirm which proxy shard an instance owns.
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  return send(res, {
    service: 'gsearch-renderer',
    ok: true,
    uptime_s: Math.round(process.uptime()),
    node: process.version,
    runtime: runtimeInfo(),
    engines: names(),
    pool: poolInfo(),
    browser: browserStats(),
    cache: getCache().stats(),
    features: {
      lite_fast: String(process.env.LITE_FAST || '1') !== '0',
      browser_reuse: String(process.env.BROWSER_REUSE || '1') !== '0',
      engine_fallback: true,
      pagination: true,
      batch: true,
      proxy_fetch: String(process.env.PROXY_FETCH || '1') !== '0',
    },
  });
};

module.exports.config = { maxDuration: 10, memory: 512 };
