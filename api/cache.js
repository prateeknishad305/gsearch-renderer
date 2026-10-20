'use strict';

const { getCache } = require('./lib/cache');
const circuit = require('./lib/circuit');
const googleIp = require('./lib/googleIp');
const googleSession = require('./lib/googleSession');
const stats = require('./lib/stats');
const internetdb = require('./lib/internetdb');
const { send, cors, authOk, unauthorized } = require('./lib/http');

const BLOCKED_ENGINES = ['mojeek', 'yandex', 'qwant', 'ecosia', 'brave'];

function parseEngines(raw) {
  if (raw == null || raw === '') return null;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

function flush(engines) {
  const cache = getCache();
  cache.clear();
  if (engines) {
    for (const name of engines) circuit.resetEngine(name);
  } else {
    circuit.reset();
  }
  googleIp.reset();
  googleSession.reset();
  stats.reset();
  internetdb._reset();
  return {
    success: true,
    cleared: engines && engines.length ? engines : 'all',
    cache: cache.stats(),
    circuit: circuit.snapshot(),
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (!authOk(req)) return unauthorized(res);

  if (req.method === 'GET') {
    return send(res, {
      success: true,
      cache: getCache().stats(),
      circuit: circuit.snapshot(),
      google_ip: googleIp.snapshot(),
      usage: 'DELETE /api/cache  or  DELETE /api/cache?engines=mojeek,yandex,qwant,ecosia,brave',
    });
  }

  if (req.method !== 'DELETE') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }

  const q = (req.query && (req.query.engines || req.query.engine)) || '';
  const engines = parseEngines(q) || (String((req.query && req.query.blocked) || '') === '1' ? BLOCKED_ENGINES : null);
  return send(res, flush(engines));
};

module.exports.config = { maxDuration: 10, memory: 256 };
module.exports.flush = flush;
module.exports.BLOCKED_ENGINES = BLOCKED_ENGINES;
