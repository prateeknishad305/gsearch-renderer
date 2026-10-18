'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseDork,
  engineSupport,
  adaptQuery,
  canonicalUrl,
  dedupeResults,
} = require('../api/lib/dork');

test('parseDork detects operators, phrases and exclusions', () => {
  const info = parseDork('site:example.com inurl:login intitle:"admin panel" "exact phrase" -word filetype:pdf');
  assert.equal(info.is_dork, true);
  assert.deepEqual(info.operators.site, ['example.com']);
  assert.deepEqual(info.operators.inurl, ['login']);
  assert.deepEqual(info.operators.intitle, ['admin panel']);
  assert.deepEqual(info.operators.filetype, ['pdf']);
  assert.ok(info.phrases.includes('admin panel'));
  assert.ok(info.phrases.includes('exact phrase'));
  assert.ok(info.exclusions.includes('word'));
  assert.deepEqual(info.site_targets, ['example.com']);
});

test('parseDork leaves plain queries alone', () => {
  const info = parseDork('open source database');
  assert.equal(info.is_dork, false);
  assert.equal(info.has_operators, false);
  assert.deepEqual(info.operators, {});
  assert.deepEqual(info.site_targets, []);
});

test('quoted phrases mark a dork but do not auto-enable dork mode', () => {
  const info = parseDork('"open source database"');
  assert.equal(info.is_dork, true);
  assert.equal(info.has_operators, false);
});

test('site targets are normalised to bare hosts', () => {
  const info = parseDork('site:https://www.Example.com/path inurl:x');
  assert.deepEqual(info.site_targets, ['example.com']);
});

test('engineSupport reports unsupported operators', () => {
  const info = parseDork('site:x.com inurl:login');
  assert.deepEqual(engineSupport('bing', info).unsupported, ['inurl']);
  assert.deepEqual(engineSupport('google', info).unsupported, []);
  assert.deepEqual(engineSupport('wiby', info).unsupported, ['site', 'inurl']);
});

test('adaptQuery maps operators for yandex only', () => {
  assert.equal(
    adaptQuery('inurl:login intitle:"admin" filetype:pdf', 'yandex'),
    'url:login title:"admin" mime:pdf'
  );
  assert.equal(adaptQuery('inurl:login', 'google'), 'inurl:login');
});

test('canonicalUrl strips fragments, tracking params and trailing slashes', () => {
  assert.equal(
    canonicalUrl('https://Example.com/a/?utm_source=x&gclid=1&id=2#frag'),
    'https://example.com/a?id=2'
  );
  assert.equal(canonicalUrl('not a url'), 'not a url');
});

test('dedupeResults removes canonical duplicates and respects cap', () => {
  const list = [
    { url: 'https://a.com/x/' },
    { url: 'https://a.com/x?utm_source=t' },
    { url: 'https://b.com/y' },
  ];
  assert.deepEqual(dedupeResults(list).map((r) => r.url), ['https://a.com/x/', 'https://b.com/y']);
  assert.equal(dedupeResults(list, 1).length, 1);
});
