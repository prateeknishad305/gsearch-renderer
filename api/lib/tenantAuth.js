'use strict';

const crypto = require('node:crypto');

function parseKeys() {
  const raw = String(process.env.API_KEYS || process.env.API_TOKEN || '').trim();
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [token, rest] = entry.split(':');
      const parts = String(rest || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const rpm = parts.find((p) => /^\d+$/.test(p));
      const scopes = parts.filter((p) => !/^\d+$/.test(p));
      return {
        token: String(token || '').trim(),
        rpm: rpm ? Number(rpm) : parseInt(process.env.API_RPM || '0', 10) || 0,
        scopes: scopes.length ? scopes : ['*'],
      };
    })
    .filter((k) => k.token);
}

function presented(req) {
  const header = String((req && req.headers && req.headers.authorization) || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = String((req && req.query && req.query.token) || '').trim();
  if (q) return q;
  return String((req && req.headers && req.headers['x-api-key']) || '').trim();
}

const hits = new Map();

function allowRpm(token, rpm) {
  if (!rpm) return true;
  const now = Date.now();
  const windowStart = now - 60000;
  let arr = hits.get(token) || [];
  arr = arr.filter((t) => t > windowStart);
  if (arr.length >= rpm) {
    hits.set(token, arr);
    return false;
  }
  arr.push(now);
  hits.set(token, arr);
  return true;
}

function authorize(req, scope) {
  const keys = parseKeys();
  if (!keys.length) return { ok: true, tenant: 'open', scopes: ['*'] };
  const token = presented(req);
  const row = keys.find((k) => k.token === token);
  if (!row) return { ok: false, code: 'UNAUTHORIZED' };
  if (scope && row.scopes[0] !== '*' && !row.scopes.includes(scope)) {
    return { ok: false, code: 'FORBIDDEN', tenant: hash(token) };
  }
  if (!allowRpm(token, row.rpm)) return { ok: false, code: 'RATE_LIMITED', tenant: hash(token) };
  return { ok: true, tenant: hash(token), scopes: row.scopes, rpm: row.rpm };
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function reset() {
  hits.clear();
}

module.exports = { parseKeys, presented, authorize, reset, hash };
