'use strict';

const { cors } = require('./http');

function wantsStream(req) {
  const q = req && req.query;
  if (q && (q.stream === '1' || q.stream === 'true' || q.format === 'ndjson')) return true;
  const accept = String((req && req.headers && req.headers.accept) || '');
  return /ndjson|stream/i.test(accept);
}

function writeNdjson(res, body) {
  cors(res);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const results = (body && body.results) || [];
  const meta = { ...body };
  delete meta.results;
  res.write(`${JSON.stringify({ type: 'meta', ...meta })}\n`);
  for (const row of results) {
    res.write(`${JSON.stringify({ type: 'result', ...row })}\n`);
  }
  res.write(`${JSON.stringify({ type: 'end', count: results.length })}\n`);
  res.end();
  return res;
}

function sendMaybe(req, res, body, status) {
  if (wantsStream(req) && body && Array.isArray(body.results)) {
    res.statusCode = (body && body.http_status) || status || 200;
    return writeNdjson(res, body);
  }
  return require('./http').send(res, body, status);
}

module.exports = { wantsStream, writeNdjson, sendMaybe };
