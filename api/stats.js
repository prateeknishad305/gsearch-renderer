'use strict';

const { snapshot: statsSnapshot } = require('./lib/stats');
const { snapshot: circuitSnapshot } = require('./lib/circuit');
const { poolInfo } = require('./lib/proxyPool');
const { stats: browserStats } = require('./lib/browserPool');
const { send, cors, authOk, unauthorized } = require('./lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);
  return send(res, {
    success: true,
    stats: statsSnapshot(),
    circuit: circuitSnapshot(),
    pool: poolInfo(),
    browser: browserStats(),
  });
};

module.exports.config = { maxDuration: 10, memory: 256 };
