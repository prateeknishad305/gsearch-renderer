'use strict';

// Bulk IP enrichment via the official Shodan InternetDB endpoint.
//   GET  /api/shodan/ip?ips=1.2.3.4,5.6.7.8
//   POST /api/shodan/ip  { "ips": ["1.2.3.4", "5.6.7.8"] }
// No API key, no fallback. Each entry is independent: a bad IP does not fail
// the batch.

const { fetchHost, mergeInternetDb, isIp } = require('./lib/internetdb');
const { toShodanHost } = require('./lib/shodanShape');
const { send, cors, authOk, unauthorized } = require('./lib/http');

const MAX_IPS = 100;

function parseIps(req) {
  const raw =
    req.method === 'POST' && req.body && typeof req.body === 'object'
      ? req.body.ips
      : req.query.ips;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\s]+/);
  return list.map((s) => String(s || '').trim()).filter(Boolean).slice(0, MAX_IPS);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, { success: false, error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);

  const ips = parseIps(req);
  if (!ips.length) {
    return send(res, {
      success: false,
      error: 'Provide ips=1.2.3.4,5.6.7.8 (max 100)',
      http_status: 400,
    });
  }

  const started = Date.now();
  const results = await Promise.all(
    ips.map(async (ip) => {
      if (!isIp(ip)) return { ip, found: false, code: 'INVALID_IP', host: null };
      const host = toShodanHost({ title: ip, url: `http://${ip}`, ip });
      const data = await fetchHost(ip);
      if (!data) return { ip, found: false, code: 'NOT_FOUND', host };
      mergeInternetDb(host, data);
      return { ip, found: true, host };
    })
  );

  const found = results.filter((r) => r.found).length;
  return send(res, {
    success: true,
    source: 'internetdb',
    fallback: false,
    count: results.length,
    found,
    results,
    response_time_ms: Date.now() - started,
  });
};
