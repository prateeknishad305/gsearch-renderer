'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  applyDomainFilters,
  parseResultFilters,
  isSocialHost,
  isDevHost,
} = require('../api/lib/resultFilter');

function r(url) {
  return { title: url, url };
}

const list = [
  r('https://example.com/a'),
  r('https://www.facebook.com/x'),
  r('https://github.com/org/repo'),
  r('https://sub.stackoverflow.com/q/1'),
];

test('social hosts are filtered by default', () => {
  const out = applyDomainFilters(list, {});
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://github.com/org/repo',
    'https://sub.stackoverflow.com/q/1',
  ]);
});

test('developer hosts are kept until enabled', () => {
  const out = applyDomainFilters(list, { social: false, dev: true });
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://www.facebook.com/x',
  ]);
});

test('unique enables both social and dev filtering', () => {
  const opts = parseResultFilters({ unique: '1' });
  const out = applyDomainFilters(list, opts);
  assert.deepEqual(out.map((x) => x.url), ['https://example.com/a']);
});

test('explicit site target is never filtered out', () => {
  const out = applyDomainFilters(list, { social: true, dev: true, allowDomains: ['github.com'] });
  assert.deepEqual(out.map((x) => x.url), ['https://example.com/a', 'https://github.com/org/repo']);
});

test('exclude_domains matches subdomains', () => {
  const opts = parseResultFilters({ exclude_domains: 'example.com' });
  const out = applyDomainFilters(list, opts);
  assert.equal(out.some((x) => x.url.includes('example.com')), false);
});

test('per-request switches override defaults', () => {
  assert.equal(parseResultFilters({ social: '0' }).social, false);
  assert.equal(parseResultFilters({ dev: '1' }).dev, true);
  assert.equal(parseResultFilters({ exclude: 'social,dev' }).dev, true);
});

test('host predicates handle subdomains', () => {
  assert.equal(isSocialHost('m.facebook.com'), true);
  assert.equal(isSocialHost('facebook.com.evil.test'), false);
  assert.equal(isDevHost('gist.github.com'), true);
  assert.equal(isDevHost('github.io'), false);
});
