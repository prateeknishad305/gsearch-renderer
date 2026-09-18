'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

(function loadDotEnv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] !== undefined) continue;
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
})();

const { closeAll } = require('./api/lib/browserPool');
const { detectPlatform } = require('./api/lib/chromium');

const searchHandler = require('./api/search');
const batchHandler = require('./api/batch');
const healthHandler = require('./api/health');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = Math.max(1024, parseInt(process.env.BODY_LIMIT || '1048576', 10) || 1048576);

function parseQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (query[key] === undefined) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }
  return query;
}

function wrapRes(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function json(body) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error('Request body too large');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      const ctype = String(req.headers['content-type'] || '');
      if (ctype.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          const err = new Error('Invalid JSON body');
          err.code = 'INVALID_JSON';
          reject(err);
        }
        return;
      }
      resolve(raw);
    });
    req.on('error', reject);
  });
}

function route(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/api/search' || path === '/search') return searchHandler;
  if (path === '/api/batch' || path === '/batch') return batchHandler;
  if (path === '/api/health' || path === '/health') return healthHandler;
  return null;
}

async function handle(req, res) {
  wrapRes(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  req.query = parseQuery(url.searchParams);

  const handler = route(url.pathname);
  if (!handler) {
    res.status(404).json({
      success: false,
      error: 'Not found',
      usage: {
        search: 'GET /api/search?q=<query>&engine=<name>',
        batch: 'POST /api/batch',
        health: 'GET /api/health',
      },
    });
    return;
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      req.body = await readBody(req);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        res.status(413).json({ error: err.message, http_status: 413 });
        return;
      }
      res.status(400).json({ error: err.message || 'Invalid request body', http_status: 400 });
      return;
    }
  } else {
    req.body = undefined;
  }

  await handler(req, res);
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: err.message || 'Internal error' }));
    } else {
      res.end();
    }
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

function shutdown(signal) {
  console.log(`[gsearch-renderer] ${signal} received, shutting down`);
  server.close(() => {
    closeAll()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

function listen() {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  server.listen(PORT, HOST, () => {
    console.log(`[gsearch-renderer] listening on http://${HOST}:${PORT} (${detectPlatform()})`);
  });
  return server;
}

if (require.main === module) listen();

module.exports = { server, handle, route, parseQuery, wrapRes, listen };
