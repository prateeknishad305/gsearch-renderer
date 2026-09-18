'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PROXY_FETCH_URL, getLivePool, setLivePoolForTests, fetcherInfo } = require('../api/lib/proxyFetch');
const { getProxyPool, splitPool } = require('../api/lib/proxyPool');

after(() => {
  setLivePoolForTests([]);
});

test('hardcoded proxy fetcher URL is etherealproxyfetch live.txt', () => {
  assert.equal(PROXY_FETCH_URL, 'https://etherealproxyfetch.onrender.com/live.txt');
  assert.equal(fetcherInfo().url, PROXY_FETCH_URL);
});

test('getProxyPool uses checked live list when PROXY_POOL is unset', () => {
  const prev = process.env.PROXY_POOL;
  delete process.env.PROXY_POOL;
  const live = ['http://user:pass@1.2.3.4:8081', 'http://user:pass@5.6.7.8:8081'];
  setLivePoolForTests(live);
  assert.deepEqual(getProxyPool(), live);
  assert.deepEqual(getLivePool(), live);
  if (prev === undefined) delete process.env.PROXY_POOL;
  else process.env.PROXY_POOL = prev;
  setLivePoolForTests([]);
});

test('PROXY_POOL env still wins over live list', () => {
  const prev = process.env.PROXY_POOL;
  process.env.PROXY_POOL = 'http://env:1\nhttp://env:2';
  setLivePoolForTests(['http://live:9']);
  assert.deepEqual(getProxyPool(), ['http://env:1', 'http://env:2']);
  if (prev === undefined) delete process.env.PROXY_POOL;
  else process.env.PROXY_POOL = prev;
  setLivePoolForTests([]);
});

test('splitPool still parses live-list host:port:user:pass rows', () => {
  const pool = splitPool('10.0.0.1:8081:u:p==\n');
  assert.equal(pool.length, 1);
  assert.match(pool[0], /^http:\/\/u:p%3D%3D@10\.0\.0\.1:8081$/);
});
