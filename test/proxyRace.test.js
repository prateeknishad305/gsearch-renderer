'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { batches, firstOk, raceWidth } = require('../api/lib/proxyRace');

test('batches splits proxies into race groups', () => {
  assert.deepEqual(batches(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(batches(['a'], 4), [['a']]);
  assert.deepEqual(batches([], 4), []);
});

test('firstOk returns the first successful attempt', async () => {
  const t0 = Date.now();
  const val = await firstOk([
    () => new Promise((_, rej) => setTimeout(() => rej(new Error('slow-fail')), 80)),
    () => new Promise((res) => setTimeout(() => res('win'), 20)),
    () => new Promise((res) => setTimeout(() => res('late'), 60)),
  ]);
  assert.equal(val, 'win');
  assert.ok(Date.now() - t0 < 70);
});

test('firstOk rejects when every attempt fails then rotates', async () => {
  await assert.rejects(
    () =>
      firstOk([
        () => Promise.reject(new Error('dead-a')),
        () => Promise.reject(new Error('dead-b')),
      ]),
    /dead-/
  );
});

test('raceWidth defaults to 4 and stays in 1..16', () => {
  const prev = process.env.PROXY_RACE;
  delete process.env.PROXY_RACE;
  assert.equal(raceWidth(), 4);
  process.env.PROXY_RACE = '12';
  assert.equal(raceWidth(), 12);
  process.env.PROXY_RACE = '99';
  assert.equal(raceWidth(), 16);
  if (prev === undefined) delete process.env.PROXY_RACE;
  else process.env.PROXY_RACE = prev;
});
