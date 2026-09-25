'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crawlHandler = require('../api/crawl');

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

test('crawl usage when url missing', async () => {
  const res = mockRes();
  await crawlHandler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.usage, /\/api\/crawl/);
});

test('crawl rejects private start URL', async () => {
  const res = mockRes();
  await crawlHandler({ method: 'GET', headers: {}, query: { url: 'http://127.0.0.1/' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'BLOCKED_URL');
});

test('crawl rejects invalid URL', async () => {
  const res = mockRes();
  await crawlHandler({ method: 'GET', headers: {}, query: { url: 'ftp://example.com' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'INVALID_URL');
});

test('crawl OPTIONS is 204', async () => {
  const res = mockRes();
  await crawlHandler({ method: 'OPTIONS', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 204);
});

test('crawl PUT is 405', async () => {
  const res = mockRes();
  await crawlHandler({ method: 'PUT', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('crawl requires token when API_TOKEN is set', async () => {
  const prev = process.env.API_TOKEN;
  process.env.API_TOKEN = 'sekret';
  try {
    const res = mockRes();
    await crawlHandler({ method: 'GET', headers: {}, query: { url: 'https://example.com' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  } finally {
    if (prev === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = prev;
  }
});
