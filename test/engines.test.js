'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINES, names } = require('../api/lib/engines');

test('supports the expected engines', () => {
  const n = names();
  for (const e of ['google', 'bing', 'brave', 'mojeek', 'startpage', 'yahoo', 'duckduckgo', 'duckduckgo_lite', 'qwant', 'ecosia', 'swisscows', 'seznam']) {
    assert.ok(n.includes(e), `missing engine ${e}`);
  }
});

test('google URL paginates by start=10 and does not send num>10', () => {
  const u = ENGINES.google.url({ q: 'hello world', num: 100, start: 10, hl: 'en', gl: 'us' });
  assert.match(u, /google\.com\/search/);
  const params = new URL(u).searchParams;
  assert.equal(params.get('q'), 'hello world');
  assert.equal(params.get('num'), null);
  assert.equal(params.get('start'), '10');
  assert.equal(params.get('hl'), 'en');
  assert.equal(params.get('gl'), 'us');
  const u0 = ENGINES.google.url({ q: 'x', num: 10, start: 0, hl: 'en', gl: 'us' });
  assert.equal(new URL(u0).searchParams.get('start'), '0');
});

test('bing URL uses count and first for pagination', () => {
  const u = ENGINES.bing.url({ q: 'x', num: 20, start: 0, gl: 'us' });
  assert.match(u, /bing\.com\/search/);
  assert.equal(new URL(u).searchParams.get('count'), '20');
  assert.equal(new URL(u).searchParams.get('first'), null);
  const u2 = ENGINES.bing.url({ q: 'x', num: 20, start: 20, gl: 'us' });
  assert.equal(new URL(u2).searchParams.get('first'), '21');
});

test('duckduckgo URL uses kl for locale and s for pagination', () => {
  const u = ENGINES.duckduckgo.url({ q: 'x', start: 0, hl: 'en', gl: 'us' });
  assert.match(u, /html\.duckduckgo\.com\/html/);
  assert.equal(new URL(u).searchParams.get('kl'), 'us-en');
  assert.equal(new URL(u).searchParams.get('s'), null);
  const u2 = ENGINES.duckduckgo.url({ q: 'x', start: 20, hl: 'en', gl: 'us' });
  assert.equal(new URL(u2).searchParams.get('s'), '20');
});

test('yahoo URL uses p, n<=10, b', () => {
  const u = ENGINES.yahoo.url({ q: 'x', num: 100, start: 10 });
  const p = new URL(u).searchParams;
  assert.equal(p.get('p'), 'x');
  assert.equal(p.get('n'), '10');
  assert.equal(p.get('b'), '11');
  const u0 = ENGINES.yahoo.url({ q: 'x', num: 10, start: 0 });
  assert.equal(new URL(u0).searchParams.get('b'), null);
});

test('startpage URL paginates with page and omits page on first page', () => {
  const u0 = ENGINES.startpage.url({ q: 'hello world', num: 10, start: 0 });
  assert.match(u0, /startpage\.com\/sp\/search/);
  const p0 = new URL(u0).searchParams;
  assert.equal(p0.get('query'), 'hello world');
  assert.equal(p0.get('page'), null);
  const u2 = ENGINES.startpage.url({ q: 'hello world', num: 10, start: 10 });
  assert.equal(new URL(u2).searchParams.get('page'), '2');
});

test('mojeek URL paginates with s and omits s on first page', () => {
  const u0 = ENGINES.mojeek.url({ q: 'hello world', num: 10, start: 0, hl: 'en', gl: 'us' });
  assert.match(u0, /mojeek\.com\/search/);
  const p0 = new URL(u0).searchParams;
  assert.equal(p0.get('q'), 'hello world');
  assert.equal(p0.get('s'), null);
  const u2 = ENGINES.mojeek.url({ q: 'hello world', num: 10, start: 10 });
  assert.equal(new URL(u2).searchParams.get('s'), '10');
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

test('ecosia URL paginates with p', () => {
  const u0 = ENGINES.ecosia.url({ q: 'x', start: 0, gl: 'de' });
  assert.match(u0, /ecosia\.org\/search/);
  assert.equal(new URL(u0).searchParams.get('c'), 'de');
  assert.equal(new URL(u0).searchParams.get('p'), null);
  const u2 = ENGINES.ecosia.url({ q: 'x', start: 10, gl: 'de' });
  assert.equal(new URL(u2).searchParams.get('p'), '2');
});

test('swisscows and seznam URLs paginate', () => {
  const s0 = new URL(ENGINES.swisscows.url({ q: 'x', start: 0 }));
  assert.match(s0.href, /swisscows\.com/);
  assert.equal(s0.searchParams.get('offset'), null);
  const s2 = new URL(ENGINES.swisscows.url({ q: 'x', start: 10 }));
  assert.equal(s2.searchParams.get('offset'), '10');
  const z2 = new URL(ENGINES.seznam.url({ q: 'x', start: 10 }));
  assert.equal(z2.searchParams.get('from'), '10');
});
