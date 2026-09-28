'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxies = require('../api/proxies');
const { clearUserProxies } = require('../api/lib/proxyPool');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('POST /api/proxies stores personal proxies and masks credentials', async () => {
  clearUserProxies();
  const res = mockRes();
  await proxies(
    { method: 'POST', headers: {}, query: {}, body: { proxies: ['http://user:secret@1.2.3.4:8080'] } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.user_count, 1);
  assert.equal(res.body.source, 'user');
  assert.deepEqual(res.body.user_proxies, ['http://***@1.2.3.4:8080']);
  assert.equal(typeof res.body.proxies_available, 'number');
  assert.equal(res.body.pool, undefined);
  clearUserProxies();
});

test('GET /api/proxies does not leak fetcher URL', async () => {
  clearUserProxies();
  const res = mockRes();
  await proxies({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pool.fetcher.url, undefined);
  assert.equal(typeof res.body.proxies_available, 'number');
  const dumped = JSON.stringify(res.body);
  assert.equal(dumped.includes('etherealproxyfetch'), false);
  assert.equal(dumped.includes('PROXY_FETCH_URL'), false);
});

test('DELETE /api/proxies clears personal pool', async () => {
  const { setUserProxies } = require('../api/lib/proxyPool');
  setUserProxies(['http://a:1']);
  const res = mockRes();
  await proxies({ method: 'DELETE', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user_count, 0);
  assert.notEqual(res.body.source, 'user');
});

test('POST rejects empty proxy list', async () => {
  const res = mockRes();
  await proxies({ method: 'POST', headers: {}, query: {}, body: { proxies: [] } }, res);
  assert.equal(res.statusCode, 400);
});
