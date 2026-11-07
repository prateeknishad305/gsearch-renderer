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
  r('https://www.scribd.com/doc/1'),
  r('https://shop.example.com/forum/thread/1'),
  r('https://myblog.wordpress.com/post'),
];

test('social hosts are filtered by default', () => {
  const out = applyDomainFilters(list, {});
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://github.com/org/repo',
    'https://sub.stackoverflow.com/q/1',
    'https://www.scribd.com/doc/1',
    'https://shop.example.com/forum/thread/1',
    'https://myblog.wordpress.com/post',
  ]);
});

test('developer hosts are kept until enabled', () => {
  const out = applyDomainFilters(list, { social: false, dev: true });
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://www.facebook.com/x',
    'https://www.scribd.com/doc/1',
    'https://shop.example.com/forum/thread/1',
    'https://myblog.wordpress.com/post',
  ]);
});

test('unique enables both social and dev filtering', () => {
  const opts = parseResultFilters({ unique: '1' });
  const out = applyDomainFilters(list, opts);
  assert.deepEqual(out.map((x) => x.url), ['https://example.com/a']);
});

test('explicit site target is never filtered out', () => {
  const out = applyDomainFilters(list, { social: true, dev: true, allowDomains: ['github.com'] });
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://github.com/org/repo',
    'https://www.scribd.com/doc/1',
    'https://shop.example.com/forum/thread/1',
    'https://myblog.wordpress.com/post',
  ]);
});

test('TLD allowDomains matches real .com hosts, not via ..tld', () => {
  const out = applyDomainFilters(list, { social: true, dev: true, allowDomains: ['.com'] });
  assert.deepEqual(out.map((x) => x.url), [
    'https://example.com/a',
    'https://www.facebook.com/x',
    'https://github.com/org/repo',
    'https://sub.stackoverflow.com/q/1',
    'https://www.scribd.com/doc/1',
    'https://shop.example.com/forum/thread/1',
    'https://myblog.wordpress.com/post',
  ]);
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
  assert.equal(isDevHost('github.io'), true);
  assert.equal(isDevHost('user.github.io'), true);
});

test('unique also drops scribd, forums and blog platforms', () => {
  const { isUgcHost, isForumUrl, isBlogUrl, isDevHost, isBlogHost, isForumHost } = require('../api/lib/resultFilter');
  assert.equal(isUgcHost('www.scribd.com'), true);
  assert.equal(isForumUrl('https://shop.example.com/forum/thread/1'), true);
  assert.equal(isForumUrl('https://shop.example.com/checkout'), false);
  assert.equal(isForumUrl('https://forum.shop.example.com/t/1'), true);
  assert.equal(isForumHost('community.shop.example.com'), true);
  assert.equal(isBlogUrl('https://myblog.wordpress.com/post'), true);
  assert.equal(isBlogUrl('https://user.blogspot.de/2024/01/x'), true);
  assert.equal(isBlogUrl('https://shop.example.com/blog/hello'), true);
  assert.equal(isBlogHost('blog.shop.example.com'), true);
  assert.equal(isDevHost('octocat.github.io'), true);
  const extra = list.concat(
    r('https://octocat.github.io/pages'),
    r('https://forum.shop.example.com/t/1'),
    r('https://blog.shop.example.com/hello'),
    r('https://name.blogspot.co.uk/p/1'),
    r('https://shop.example.com/blog/post')
  );
  const opts = parseResultFilters({ unique: '1' });
  const out = applyDomainFilters(extra, opts);
  assert.deepEqual(out.map((x) => x.url), ['https://example.com/a']);
});
