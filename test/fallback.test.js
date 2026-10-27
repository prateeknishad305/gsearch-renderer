'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  withFallbacks,
  autoFallbackEnabled,
  AUTO_FALLBACK_CHAIN,
  publicCode,
  publicMessage,
  resolveTryList,
  noFallbackRequested,
} = require('../api/search');
const { ENGINES } = require('../api/lib/engines');

test('fallback chain only contains known engines', () => {
  assert.ok(AUTO_FALLBACK_CHAIN.length > 0);
  for (const engine of AUTO_FALLBACK_CHAIN) {
    assert.ok(ENGINES[engine], `unknown fallback engine: ${engine}`);
  }
});

test('withFallbacks keeps the requested engine first and appends unique engines', () => {
  const old = process.env.AUTO_FALLBACK;
  delete process.env.AUTO_FALLBACK;
  try {
    assert.equal(autoFallbackEnabled(), true);
    const list = withFallbacks(['mojeek']);
    assert.equal(list[0], 'mojeek');
    assert.ok(list.length > 1);
    assert.ok(list.includes('duckduckgo'));
    assert.equal(new Set(list).size, list.length, 'no duplicates');
    // Requested engine is never duplicated by the chain.
    assert.equal(list.filter((e) => e === 'mojeek').length, 1);
  } finally {
    if (old === undefined) delete process.env.AUTO_FALLBACK;
    else process.env.AUTO_FALLBACK = old;
  }
});

test('withFallbacks is a no-op when AUTO_FALLBACK=0', () => {
  const old = process.env.AUTO_FALLBACK;
  process.env.AUTO_FALLBACK = '0';
  try {
    assert.equal(autoFallbackEnabled(), false);
    assert.deepEqual(withFallbacks(['bing']), ['bing']);
  } finally {
    if (old === undefined) delete process.env.AUTO_FALLBACK;
    else process.env.AUTO_FALLBACK = old;
  }
});

test('publicCode hides block/sorry internals', () => {
  assert.equal(publicCode('BLOCKED'), 'ENGINE_UNAVAILABLE');
  assert.equal(publicCode('SORRY'), 'ENGINE_UNAVAILABLE');
  assert.equal(publicCode('CIRCUIT_OPEN'), 'ENGINE_UNAVAILABLE');
  assert.equal(publicCode('LITE_HTTP_ERROR'), 'LITE_HTTP_ERROR');
  assert.equal(publicCode(undefined), 'ERROR');
});

test('publicMessage never leaks block/sorry wording', () => {
  const blocked = Object.assign(new Error('Engine "google" blocked the browser render: unusual traffic interstitial'), {
    code: 'BLOCKED',
  });
  const msg = publicMessage('google', blocked);
  assert.doesNotMatch(msg, /blocked|sorry|captcha|unusual traffic/i);
  assert.match(msg, /google/);
  const plain = publicMessage('bing', new Error('boom'));
  assert.equal(plain, 'boom');
});

test('per-request fallback=0 disables the chain only for that call', () => {
  const old = process.env.AUTO_FALLBACK;
  delete process.env.AUTO_FALLBACK;
  try {
    const off = resolveTryList(['mojeek'], { fallback: '0' });
    assert.equal(off.noFallback, true);
    assert.deepEqual(off.tryList, ['mojeek']);

    const on = resolveTryList(['mojeek'], {});
    assert.equal(on.noFallback, false);
    assert.ok(on.tryList.length > 1);
    assert.equal(on.tryList[0], 'mojeek');
  } finally {
    if (old === undefined) delete process.env.AUTO_FALLBACK;
    else process.env.AUTO_FALLBACK = old;
  }
});

test('noFallbackRequested recognises false values and defaults to on', () => {
  assert.equal(noFallbackRequested({ fallback: '0' }), true);
  assert.equal(noFallbackRequested({ fallback: 'false' }), true);
  assert.equal(noFallbackRequested({ auto_fallback: '0' }), true);
  assert.equal(noFallbackRequested({}), false);
  assert.equal(noFallbackRequested(undefined), false);
});
