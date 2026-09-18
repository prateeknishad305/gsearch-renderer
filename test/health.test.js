'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const health = require('../api/health');

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

test('health is public even when API_TOKEN is set', async () => {
  const prev = process.env.API_TOKEN;
  process.env.API_TOKEN = 'sekret';
  const req = { method: 'GET', headers: {}, query: {} };
  const res = mockRes();
  await health(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'gsearch-renderer');
  assert.ok(res.body.runtime);
  if (prev === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = prev;
});
