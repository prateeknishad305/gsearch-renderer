'use strict';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, body, status = 200) {
  cors(res);
  return res.status(body && body.http_status ? body.http_status : status).json(body);
}

// When API_TOKEN is set, every request must present it either as
// "Authorization: Bearer <token>" or "?token=<token>". Hosted instances should
// set this so the renderer is not an open proxy for arbitrary callers.
function authOk(req) {
  const token = String(process.env.API_TOKEN || '').trim();
  if (!token) return true;
  const header = String(req.headers['authorization'] || '');
  const query = String((req.query && req.query.token) || '');
  return header === `Bearer ${token}` || query === token;
}

function unauthorized(res) {
  cors(res);
  return res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: 'Missing or invalid API token', count: 0, results: [] });
}

function maskProxy(proxy) {
  if (!proxy) return null;
  return String(proxy).replace(/\/\/[^@/]*@/, '//***@');
}

module.exports = { cors, send, authOk, unauthorized, maskProxy };
