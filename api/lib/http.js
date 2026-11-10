'use strict';

const crypto = require('node:crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, body, status = 200) {
  cors(res);
  const code = body && body.http_status ? body.http_status : status;
  if (code === 200 && body && body.success === true && Array.isArray(body.results)) {
    const json = JSON.stringify(body);
    const etag = '"' + crypto.createHash('sha256').update(json).digest('hex').slice(0, 16) + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=60');
  }
  if (res && res.req && require('./streamJson').wantsStream(res.req) && body && Array.isArray(body.results)) {
    res.statusCode = code;
    return require('./streamJson').writeNdjson(res, body);
  }
  return res.status(code).json(body);
}

// When API_TOKEN is set, every request must present it either as
// "Authorization: Bearer <token>" or "?token=<token>". Hosted instances should
// set this so the renderer is not an open proxy for arbitrary callers.
function authOk(req) {
  const tenant = require('./tenantAuth').authorize(req);
  req.tenant = tenant;
  return tenant.ok;
}

function unauthorized(res, req) {
  cors(res);
  const code = (req && req.tenant && req.tenant.code) || 'UNAUTHORIZED';
  const status = code === 'RATE_LIMITED' ? 429 : code === 'FORBIDDEN' ? 403 : 401;
  return res.status(status).json({ success: false, code, error: 'Missing or invalid API token', count: 0, results: [] });
}

function maskProxy(proxy) {
  if (!proxy) return null;
  return String(proxy).replace(/\/\/[^@/]*@/, '//***@');
}

module.exports = { cors, send, authOk, unauthorized, maskProxy };
