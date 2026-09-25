'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPrivateHostname,
  normalizeUrl,
  isAllowedUrl,
  sameOrigin,
  MAX_PAGES,
  MAX_DEPTH,
} = require('../api/lib/crawler');

test('isPrivateHostname blocks loopback, RFC1918, link-local, metadata', () => {
  for (const h of [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.1',
    '169.254.1.1',
    '100.64.0.1',
    'metadata.google.internal',
    'foo.local',
    'bar.internal',
  ]) {
    assert.equal(isPrivateHostname(h), true, h);
  }
  assert.equal(isPrivateHostname('example.com'), false);
  assert.equal(isPrivateHostname('8.8.8.8'), false);
  assert.equal(isPrivateHostname('172.32.0.1'), false);
});

test('normalizeUrl keeps http(s), drops hash, rejects others', () => {
  assert.equal(normalizeUrl('https://example.com/a#x'), 'https://example.com/a');
  assert.equal(normalizeUrl('/rel', 'https://example.com/dir/'), 'https://example.com/rel');
  assert.equal(normalizeUrl('ftp://example.com/a'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('sameOrigin compares protocol and hostname only', () => {
  assert.equal(sameOrigin('https://example.com/a', 'https://example.com/b'), true);
  assert.equal(sameOrigin('https://example.com/a', 'http://example.com/a'), false);
  assert.equal(sameOrigin('https://a.example.com/', 'https://example.com/'), false);
});

test('isAllowedUrl blocks private hosts and off-origin when required', () => {
  const origin = 'https://example.com/start';
  assert.equal(isAllowedUrl('https://example.com/next', origin, true), 'https://example.com/next');
  assert.equal(isAllowedUrl('https://other.com/x', origin, true), null);
  assert.ok(isAllowedUrl('https://other.com/x', origin, false));
  assert.equal(isAllowedUrl('http://127.0.0.1/', origin, false), null);
  assert.equal(isAllowedUrl('http://192.168.0.5/admin', origin, false), null);
  assert.equal(isAllowedUrl('file:///etc/passwd', origin, false), null);
});

test('caps stay bounded', () => {
  assert.equal(MAX_PAGES, 20);
  assert.equal(MAX_DEPTH, 3);
});
