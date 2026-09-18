'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { chooseSource, detectPlatform, resetLaunchCache } = require('../api/lib/chromium');

const KEYS = [
  'VERCEL',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_SERVICE_ID',
  'RENDER',
  'FLY_APP_NAME',
  'CHROMIUM_SOURCE',
  'CHROMIUM_PATH',
];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  resetLaunchCache();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLaunchCache();
});

test('chooseSource uses sparticuz on Vercel even if a system binary exists', () => {
  process.env.VERCEL = '1';
  assert.equal(chooseSource('/usr/bin/chromium'), 'sparticuz');
});

test('chooseSource prefers system Chromium when auto and a binary exists', () => {
  assert.equal(chooseSource('/usr/bin/chromium'), 'system');
});

test('chooseSource falls back to sparticuz when no system binary exists', () => {
  assert.equal(chooseSource(null), 'sparticuz');
});

test('CHROMIUM_SOURCE=system forces system', () => {
  process.env.CHROMIUM_SOURCE = 'system';
  process.env.VERCEL = '1';
  assert.equal(chooseSource('/usr/bin/chromium'), 'system');
});

test('CHROMIUM_SOURCE=sparticuz forces sparticuz', () => {
  process.env.CHROMIUM_SOURCE = 'sparticuz';
  assert.equal(chooseSource('/usr/bin/chromium'), 'sparticuz');
});

test('detectPlatform maps known host env vars', () => {
  process.env.RAILWAY_ENVIRONMENT = 'production';
  assert.equal(detectPlatform(), 'railway');
  delete process.env.RAILWAY_ENVIRONMENT;
  process.env.RENDER = 'true';
  assert.equal(detectPlatform(), 'render');
  delete process.env.RENDER;
  process.env.VERCEL = '1';
  assert.equal(detectPlatform(), 'vercel');
});
