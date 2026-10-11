'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFlavor,
  resolveFlavor,
  uaFor,
  chUa,
  listFlavors,
  NAMES,
} = require('../api/lib/browserFlavor');

test('normalizeFlavor aliases and defaults', () => {
  assert.equal(normalizeFlavor(''), 'chromium');
  assert.equal(normalizeFlavor('chrome'), 'chromium');
  assert.equal(normalizeFlavor('msedge'), 'edge');
  assert.equal(normalizeFlavor('webkit'), 'safari');
  assert.equal(normalizeFlavor('tor-browser'), 'tor');
  assert.equal(normalizeFlavor('nope'), 'chromium');
  for (const n of NAMES) assert.equal(normalizeFlavor(n), n);
});

test('uaFor and chUa match each flavor', () => {
  assert.match(uaFor('firefox'), /Firefox\/128/);
  assert.match(uaFor('safari'), /Safari\/605/);
  assert.match(uaFor('tor'), /Firefox\/128/);
  assert.match(uaFor('edge', 125), /Edg\/125/);
  assert.match(uaFor('brave', 125), /Chrome\/125/);
  assert.equal(chUa('firefox'), null);
  assert.equal(chUa('safari'), null);
  assert.match(chUa('edge', 125), /Microsoft Edge/);
  assert.match(chUa('brave', 125), /Brave/);
});

test('firefox/safari/tor without binary fall back to chromium engine', () => {
  const ff = resolveFlavor('firefox');
  assert.equal(ff.id, 'firefox');
  if (!ff.executablePath) {
    assert.equal(ff.engine, 'chromium');
    assert.equal(ff.fallback, true);
  }
  const saf = resolveFlavor('safari');
  assert.equal(saf.id, 'safari');
  if (!saf.executablePath) {
    assert.equal(saf.engine, 'chromium');
    assert.equal(saf.fallback, true);
  }
  const tor = resolveFlavor('tor');
  assert.equal(tor.id, 'tor');
  if (!tor.executablePath) {
    assert.equal(tor.engine, 'chromium');
    assert.equal(tor.fallback, true);
  }
});

test('listFlavors covers all names', () => {
  const list = listFlavors();
  assert.equal(list.length, NAMES.length);
  assert.deepEqual(list.map((x) => x.name), NAMES);
});
