'use strict';

const http = require('http');

function enabled(req) {
  const q = req && req.query && String(req.query.backend || req.query.google_backend || '').toLowerCase();
  if (q === 'go' || q === 'golang') return true;
  if (q === 'node' || q === 'chromium') return false;
  return String(process.env.GOOGLE_BACKEND || 'node').toLowerCase() === 'go';
}

function goBase() {
  return String(process.env.GO_GOOGLE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
}

function get(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(goBase() + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          authorization: process.env.API_TOKEN ? `Bearer ${process.env.API_TOKEN}` : '',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('go google bad json'));
          }
        });
      }
    );
    req.setTimeout(timeoutMs || Math.max(8000, parseInt(process.env.SEARCH_BUDGET_MS || '25000', 10) || 25000), () => {
      req.destroy();
      reject(new Error('go google timeout'));
    });
    req.on('error', (err) => {
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        const e = new Error('go google down');
        e.code = 'GO_DOWN';
        reject(e);
        return;
      }
      reject(err);
    });
    req.end();
  });
}

async function search({ query, num = 10, hl = 'en', gl = 'us', start = 0 }) {
  const q = new URLSearchParams({
    q: query,
    engine: 'google',
    num: String(num),
    hl,
    gl,
    start: String(start || 0),
    nocache: '1',
  });
  const body = await get(`/api/search?${q.toString()}`);
  if (!body || body.success !== true || !Array.isArray(body.results) || !body.results.length) {
    const e = new Error((body && body.error) || 'go google empty');
    e.code = (body && body.code) || 'EMPTY_RESULTS';
    throw e;
  }
  return {
    results: body.results,
    duration_ms: body.duration_ms || 0,
    attempts: body.attempts || 1,
    proxy: body.proxy || null,
    source: 'go',
    pages_fetched: 1,
    pages_requested: 1,
  };
}

async function ping() {
  try {
    const h = await get('/api/health', 1500);
    return !!(h && h.ok);
  } catch {
    return false;
  }
}

module.exports = { enabled, search, ping, goBase };
