'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toOrganic, toSerperBody, parseSerperInput } = require('../api/lib/serperShape');

test('toOrganic maps title/url/snippet to serper organic with position', () => {
  const organic = toOrganic([
    { title: 'A', url: 'https://a.test/', snippet: 'aa' },
    { title: 'B', url: 'https://b.test/', snippet: 'bb' },
    { title: 'A2', url: 'https://a.test/', snippet: 'dup' },
    { title: '', url: 'https://c.test/' },
  ]);
  assert.equal(organic.length, 2);
  assert.deepEqual(organic[0], { title: 'A', link: 'https://a.test/', snippet: 'aa', position: 1 });
  assert.equal(organic[1].position, 2);
  assert.equal(organic[1].link, 'https://b.test/');
});

test('toSerperBody matches serper.dev search envelope', () => {
  const body = toSerperBody({
    q: 'apple inc',
    gl: 'us',
    hl: 'en',
    num: 10,
    page: 1,
    type: 'search',
    engine: 'google',
    results: [{ title: 'Apple', url: 'https://www.apple.com/', snippet: 'Think different' }],
    durationMs: 12,
  });
  assert.deepEqual(body.searchParameters, {
    q: 'apple inc',
    gl: 'us',
    hl: 'en',
    type: 'search',
    num: 10,
    page: 1,
    engine: 'google',
  });
  assert.equal(body.organic[0].link, 'https://www.apple.com/');
  assert.equal(body.credits, 1);
  assert.equal(body.duration_ms, 12);
});

test('fallbackEngines is google-only (no bing/yahoo)', () => {
  const { fallbackEngines } = require('../api/lib/serperShape');
  assert.deepEqual(fallbackEngines('google'), []);
  assert.deepEqual(fallbackEngines('google', 10), []);
  assert.deepEqual(fallbackEngines('bing'), []);
});

test('parseSerperInput reads body q/gl/hl/num/page', () => {
  const input = parseSerperInput({
    body: { q: 'hello world', gl: 'uk', hl: 'en', num: 10, page: 2 },
    query: {},
  });
  assert.equal(input.q, 'hello world');
  assert.equal(input.gl, 'uk');
  assert.equal(input.num, 10);
  assert.equal(input.page, 2);
  assert.equal(input.engine, 'google');
});
