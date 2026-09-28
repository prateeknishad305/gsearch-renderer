'use strict';

const { ENGINES, names } = require('./lib/engines');
const { ENDPOINTS } = require('./lib/lite');
const { snapshot: circuit } = require('./lib/circuit');
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

  const circ = circuit();
  const engines = names().map((name) => {
    const cfg = ENGINES[name];
    return {
      name,
      lite: !!ENDPOINTS[name],
      page_size: name === 'google' || name === 'yahoo' ? 10 : null,
      ready: cfg.ready || null,
      circuit: circ[name] || { ok: 0, blocked: 0, empty: 0, error: 0, open: false },
    };
  });
  return send(res, {
    success: true,
    count: engines.length,
    engines,
    usage: 'GET /api/search?q=<query>&engine=<name>  engines=google,bing  engines=*  mode=merge',
  });
};

module.exports.config = { maxDuration: 10, memory: 256 };
