'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { shardPool, splitPool } = require('../api/lib/proxyPool');
const { TtlCache } = require('../api/lib/cache');
const { maskProxy, authOk } = require('../api/lib/http');

test('splitPool parses newline/comma lists and drops comments', () => {
  const pool = splitPool('http://a:1\n# c\nhttp://b:2,http://c:3\n\n');
  assert.deepStrictEqual(pool, ['http://a:1', 'http://b:2', 'http://c:3']);
});

test('poolInfo reports proxies_available and hides fetcher URL', () => {
  const { poolInfo } = require('../api/lib/proxyPool');
  const info = poolInfo();
  assert.ok(info.fetcher);
  assert.equal(info.fetcher.url, undefined);
  assert.equal(typeof info.proxies_available, 'number');
  assert.equal(info.proxies_available, info.shard_size);
});

test('splitPool accepts host:port:user:pass live-list format', () => {
  const pool = splitPool('1.2.3.4:8081:user_name:p==ass\n# skip\n5.6.7.8:80');
  assert.deepStrictEqual(pool, [
    `http://${encodeURIComponent('user_name')}:${encodeURIComponent('p==ass')}@1.2.3.4:8081`,
    'http://5.6.7.8:80',
  ]);
});

test('shardPool partitions disjointly and covers everything', () => {
  const pool = ['p0', 'p1', 'p2', 'p3', 'p4'];
  const a = shardPool(pool, 0, 2);
  const b = shardPool(pool, 1, 2);
  assert.deepStrictEqual(a, ['p0', 'p2', 'p4']);
  assert.deepStrictEqual(b, ['p1', 'p3']);
  assert.strictEqual(new Set([...a, ...b]).size, pool.length);
});

test('shardPool with total<=1 returns the whole pool', () => {
  assert.deepStrictEqual(shardPool(['a', 'b'], 0, 1), ['a', 'b']);
});

test('TtlCache returns values, expires, and refreshes LRU', () => {
  const cache = new TtlCache({ ttlMs: 50, max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.strictEqual(cache.get('a'), 1);
  cache.set('c', 3); // evicts 'b' (least recently used)
  assert.strictEqual(cache.get('b'), undefined);
  assert.strictEqual(cache.size, 2);
});

test('TtlCache expires entries after ttl', async () => {
  const cache = new TtlCache({ ttlMs: 20, max: 5 });
  cache.set('x', 'y');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(cache.get('x'), undefined);
});

test('maskProxy hides embedded credentials', () => {
  assert.strictEqual(maskProxy('http://user:pass@host:8080'), 'http://***@host:8080');
  assert.strictEqual(maskProxy(null), null);
});

test('pageStep uses 10 for google and num for other engines', () => {
  const { pageStep, perPageNum, autoPageCount, GOOGLE_PAGE_SIZE } = require('../api/search');
  assert.strictEqual(GOOGLE_PAGE_SIZE, 10);
  assert.strictEqual(pageStep('google', 20), 10);
  assert.strictEqual(pageStep('google', 50), 10);
  assert.strictEqual(pageStep('bing', 20), 20);
  assert.strictEqual(pageStep('yahoo', 30), 10);
  assert.strictEqual(perPageNum('google', 100), 10);
  assert.strictEqual(perPageNum('yahoo', 50), 10);
  assert.strictEqual(perPageNum('bing', 50), 50);
  assert.strictEqual(autoPageCount('google', 20), 2);
  assert.strictEqual(autoPageCount('google', 10), 1);
  assert.strictEqual(autoPageCount('bing', 50), 1);
  assert.strictEqual(autoPageCount('yahoo', 25), 3);
});

test('authOk is open when API_TOKEN unset and enforced when set', () => {
  const prev = process.env.API_TOKEN;
  delete process.env.API_TOKEN;
  assert.strictEqual(authOk({ headers: {}, query: {} }), true);

  process.env.API_TOKEN = 'sekret';
  assert.strictEqual(authOk({ headers: {}, query: { token: 'sekret' } }), true);
  assert.strictEqual(authOk({ headers: { authorization: 'Bearer sekret' }, query: {} }), true);
  assert.strictEqual(authOk({ headers: { authorization: 'Bearer nope' }, query: {} }), false);
  assert.strictEqual(authOk({ headers: {}, query: {} }), false);

  if (prev === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = prev;
});
