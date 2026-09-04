'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINES, names } = require('../api/lib/engines');

test('supports the expected engines', () => {
  const n = names();
  for (const e of ['google', 'bing', 'brave', 'mojeek', 'startpage', 'yahoo', 'duckduckgo', 'duckduckgo_lite', 'qwant']) {
    assert.ok(n.includes(e), `missing engine ${e}`);
  }
});

test('google URL includes query, num, start, hl, gl', () => {
  const u = ENGINES.google.url({ q: 'hello world', num: 20, start: 10, hl: 'en', gl: 'us' });
  assert.match(u, /google\.com\/search/);
  const params = new URL(u).searchParams;
  assert.equal(params.get('q'), 'hello world');
  assert.equal(params.get('num'), '20');
  assert.equal(params.get('start'), '10');
  assert.equal(params.get('hl'), 'en');
  assert.equal(params.get('gl'), 'us');
});

test('bing URL uses count and first for pagination', () => {
  const u = ENGINES.bing.url({ q: 'x', num: 20, start: 0, gl: 'us' });
  assert.match(u, /bing\.com\/search/);
  assert.equal(new URL(u).searchParams.get('count'), '20');
  assert.equal(new URL(u).searchParams.get('first'), null);
  const u2 = ENGINES.bing.url({ q: 'x', num: 20, start: 20, gl: 'us' });
  assert.equal(new URL(u2).searchParams.get('first'), '21');
});

test('duckduckgo URL uses kl for locale', () => {
  const u = ENGINES.duckduckgo.url({ q: 'x', hl: 'en', gl: 'us' });
  assert.match(u, /html\.duckduckgo\.com\/html/);
  assert.equal(new URL(u).searchParams.get('kl'), 'us-en');
});

test('yahoo URL uses p, n, b', () => {
  const u = ENGINES.yahoo.url({ q: 'x', num: 20, start: 40 });
  const p = new URL(u).searchParams;
  assert.equal(p.get('p'), 'x');
  assert.equal(p.get('n'), '20');
  assert.equal(p.get('b'), '41');
});

test('brave URL uses country and offset', () => {
  const u = ENGINES.brave.url({ q: 'x', num: 20, start: 20, gl: 'de' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('country'), 'de');
  assert.equal(p.get('offset'), '20');
});

test('every engine builds an https URL', () => {
  for (const name of names()) {
    const u = ENGINES[name].url({ q: 'test query', num: 20, start: 0, hl: 'en', gl: 'us' });
    assert.ok(/^https:\/\//.test(u), `${name} url is not https: ${u}`);
  }
});
