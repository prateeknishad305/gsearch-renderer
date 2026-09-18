'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { route, parseQuery, wrapRes } = require('../server');
const searchHandler = require('../api/search');
const batchHandler = require('../api/batch');
const healthHandler = require('../api/health');

test('route maps search, batch, health and aliases', () => {
  assert.equal(route('/api/search'), searchHandler);
  assert.equal(route('/search'), searchHandler);
  assert.equal(route('/'), searchHandler);
  assert.equal(route('/api/batch'), batchHandler);
  assert.equal(route('/batch'), batchHandler);
  assert.equal(route('/api/health'), healthHandler);
  assert.equal(route('/health'), healthHandler);
  assert.equal(route('/nope'), null);
});

test('parseQuery flattens URLSearchParams', () => {
  const q = parseQuery(new URLSearchParams('q=hello+world&engine=google&num=20'));
  assert.equal(q.q, 'hello world');
  assert.equal(q.engine, 'google');
  assert.equal(q.num, '20');
});

test('wrapRes adds status and json helpers', () => {
  const headers = {};
  let ended = null;
  const res = wrapRes({
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) {
      headers[k] = v;
    },
    end(chunk) {
      ended = chunk;
    },
  });
  res.status(201).json({ ok: true });
  assert.equal(res.statusCode, 201);
  assert.match(headers['Content-Type'], /application\/json/);
  assert.equal(ended, JSON.stringify({ ok: true }));
});

test('handle serves health and 404 over raw http', async () => {
  const http = require('http');
  const { handle } = require('../server');
  const srv = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err && err.message));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'gsearch-renderer');

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
