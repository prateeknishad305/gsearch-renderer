'use strict';

const { send, cors, authOk, unauthorized } = require('./lib/http');
const stats = require('./lib/stats');
const circuit = require('./lib/circuit');
const { poolInfo } = require('./lib/proxyPool');
const { stats: browserStats } = require('./lib/browserPool');
const { getCache } = require('./lib/cache');
const { wrap: redisWrap } = require('./lib/redisCache');
const cluster = require('./lib/clusterSync');
const queue = require('./lib/workQueue');
const { list: featureList } = require('./lib/features');
const { apply: fdTune } = require('./lib/fdTune');

function payload() {
  return {
    success: true,
    service: 'gsearch-renderer',
    stats: stats.snapshot(),
    circuit: circuit.snapshot(),
    pool: poolInfo(),
    browser: browserStats(),
    cache: redisWrap().stats(),
    cluster: cluster.snapshot(),
    queue: queue.snapshot(),
    features: featureList(),
    fd: fdTune(),
    generated_at: Date.now(),
  };
}

function htmlPage(data) {
  const s = data.stats || {};
  const lat = s.latency_ms || {};
  const totals = s.totals || {};
  return `<!doctype html><html><head><meta charset="utf-8"><title>gsearch dashboard</title>
<meta http-equiv="refresh" content="15">
<style>
body{font-family:sans-serif;background:#111;color:#eee;margin:24px}
h1{font-size:20px}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #333;text-align:left}
.ok{color:#7d7}.bad{color:#d77}
</style></head><body>
<h1>gsearch-renderer</h1>
<p>uptime ${s.uptime_s || 0}s &middot; search ok ${totals.search_ok || 0} / fail ${totals.search_fail || 0}</p>
<p>p50 ${lat.p50 || 0}ms &middot; p95 ${lat.p95 || 0}ms &middot; cache ${data.cache.size || 0}/${data.cache.max || 0} (${data.cache.backend || 'memory'})</p>
<p>queue active ${data.queue.active} wait ${data.queue.waiting} conc ${data.queue.concurrency}</p>
<pre>${JSON.stringify(data.features, null, 2)}</pre>
</body></html>`;
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
  const data = payload();
  const accept = String((req.headers && req.headers.accept) || '');
  if ((req.query && req.query.format === 'html') || /text\/html/i.test(accept)) {
    cors(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).end(htmlPage(data));
    return;
  }
  return send(res, data);
};

module.exports.payload = payload;
module.exports.config = { maxDuration: 10, memory: 256 };
