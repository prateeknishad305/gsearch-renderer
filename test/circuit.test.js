'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const circuit = require('../api/lib/circuit');
const { PARSERS, ENDPOINTS } = require('../api/lib/lite');

test('circuit opens after consecutive failures and closes on OK', () => {
  circuit.reset();
  const name = 'circuit_test_engine';
  for (let i = 0; i < circuit.OPEN_AFTER; i++) circuit.record(name, 'BLOCKED');
  assert.equal(circuit.isOpen(name), true);
  circuit.record(name, 'OK');
  assert.equal(circuit.isOpen(name), false);
  circuit.reset();
});

test('lite parsers extract organic urls from sample html', () => {
  const bing = PARSERS.bing('<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">Alpha</a></h2></li></ol>');
  assert.equal(bing.length, 1);
  assert.equal(bing[0].url, 'https://example.com/a');
  const yahoo = PARSERS.yahoo('<h3><a href="https://search.yahoo.com/RU=https%3A%2F%2Fnews.example%2Fx/RK=2">News</a></h3>');
  assert.ok(yahoo.length >= 1);
  assert.equal(yahoo[0].url, 'https://news.example/x');
  const ddg = PARSERS.duckduckgo('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fz">Zed</a></div>');
  assert.ok(ddg.some((r) => r.url === 'https://example.org/z'));
});

test('lite endpoints exist for extra engines', () => {
  for (const name of ['bing', 'brave', 'mojeek', 'yahoo', 'ecosia', 'startpage', 'duckduckgo', 'duckduckgo_lite', 'google']) {
    assert.equal(typeof ENDPOINTS[name], 'function', name);
  }
});

test('google lite parser reads h3/url?q=', () => {
  const html =
    '<h3 class="r"><a href="/url?q=https://en.wikipedia.org/wiki/Hello_world&amp;sa=U">Hello world</a></h3>' +
    '<a href="/url?q=https://www.google.com/search"><h3>Skip me</h3></a>';
  const out = PARSERS.google(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://en.wikipedia.org/wiki/Hello_world');
  assert.equal(out[0].title, 'Hello world');
  const u = ENDPOINTS.google({ q: 'hello world', s: 10, gl: 'us', hl: 'en' });
  const p = new URL(u).searchParams;
  assert.equal(p.get('gbv'), '2');
  assert.equal(p.get('start'), '10');
  assert.equal(p.get('udm'), null);
});
