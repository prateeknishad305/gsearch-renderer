'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cacheApi = require('../api/cache');
const { getCache } = require('../api/lib/cache');
const circuit = require('../api/lib/circuit');
const googleIp = require('../api/lib/googleIp');

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

test('DELETE /api/cache clears search cache and circuit', async () => {
  circuit.reset();
  googleIp.reset();
  getCache().set('k', { ok: true });
  circuit.record('mojeek', 'BLOCKED');
  circuit.record('mojeek', 'BLOCKED');
  circuit.record('mojeek', 'BLOCKED');
  assert.equal(circuit.isOpen('mojeek'), true);
  assert.ok(getCache().size >= 1);

  const res = mockRes();
  await cacheApi({ method: 'DELETE', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.cleared, 'all');
  assert.equal(getCache().size, 0);
  assert.equal(circuit.isOpen('mojeek'), false);
  circuit.reset();
  googleIp.reset();
});

test('DELETE /api/cache?engines=mojeek,yandex resets only those circuits', async () => {
  circuit.reset();
  circuit.record('mojeek', 'BLOCKED');
  circuit.record('mojeek', 'BLOCKED');
  circuit.record('mojeek', 'BLOCKED');
  circuit.record('bing', 'BLOCKED');
  circuit.record('bing', 'BLOCKED');
  circuit.record('bing', 'BLOCKED');
  assert.equal(circuit.isOpen('mojeek'), true);
  assert.equal(circuit.isOpen('bing'), true);

  const res = mockRes();
  await cacheApi({ method: 'DELETE', headers: {}, query: { engines: 'mojeek,yandex' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.cleared, ['mojeek', 'yandex']);
  assert.equal(circuit.isOpen('mojeek'), false);
  assert.equal(circuit.isOpen('bing'), true);
  circuit.reset();
});

test('GET /api/cache returns stats', async () => {
  const res = mockRes();
  await cacheApi({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.cache.size, 'number');
  assert.ok(res.body.circuit);
});
