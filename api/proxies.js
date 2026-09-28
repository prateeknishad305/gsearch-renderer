'use strict';

const {
  getUserProxies,
  setUserProxies,
  clearUserProxies,
  poolInfo,
  MAX_USER_PROXIES,
} = require('./lib/proxyPool');
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');

function parseList(body) {
  if (body == null) return [];
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object') return [];
  if (Array.isArray(body.proxies)) return body.proxies;
  if (typeof body.proxies === 'string') return body.proxies;
  if (typeof body.proxy === 'string') return body.proxy;
  return [];
}

function publicList() {
  return getUserProxies().map(maskProxy);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (!authOk(req)) return unauthorized(res);

  if (req.method === 'GET') {
    const info = poolInfo();
    return send(res, {
      success: true,
      usage:
        'POST /api/proxies JSON { "proxies": ["http://user:pass@host:port"] } to use your own exits. DELETE /api/proxies to clear. Live/env pool is used when no personal proxies are set.',
      user_count: getUserProxies().length,
      user_proxies: publicList(),
      max: MAX_USER_PROXIES,
      proxies_available: info.proxies_available,
      source: info.source,
      pool: info,
    });
  }

  if (req.method === 'DELETE') {
    clearUserProxies();
    const info = poolInfo();
    return send(res, {
      success: true,
      user_count: 0,
      user_proxies: [],
      proxies_available: info.proxies_available,
      source: info.source,
    });
  }

  if (req.method !== 'POST' && req.method !== 'PUT') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }

  let body = req.body;
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { proxies: raw };
      }
    }
  }
  const parsed = setUserProxies(parseList(body));
  if (!parsed.length) {
    return send(res, {
      error: 'No valid proxies. Send { "proxies": ["http://user:pass@host:port"] } (also host:port or host:port:user:pass).',
      http_status: 400,
    });
  }
  const info = poolInfo();
  return send(res, {
    success: true,
    user_count: parsed.length,
    user_proxies: publicList(),
    max: MAX_USER_PROXIES,
    proxies_available: info.proxies_available,
    source: info.source,
  });
};

module.exports.config = { maxDuration: 10, memory: 512 };
module.exports.parseList = parseList;
