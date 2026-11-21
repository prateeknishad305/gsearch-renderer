'use strict';

// Every engine has to be usable for a dork.
//
// An engine that does not understand "site:" must not be handed the token:
// typed into a search box without operator support it is searched for as the
// literal text "site:python.org", which returns nothing useful. The operator
// is dropped from the query instead and the constraint is enforced on the
// results, so such an engine can still answer with on-target hits.
//
// These tests are network-free and cover every engine in the registry.

const test = require('node:test');
const assert = require('node:assert');

const dork = require('../api/lib/dork');
const googleLite = require('../api/lib/googleLite');
const { ENGINES } = require('../api/lib/engines');
const search = require('../api/search');

const ENGINE_NAMES = Object.keys(ENGINES);

const DORK_QUERY = 'site:python.org asyncio filetype:pdf inurl:login intitle:"admin panel"';
const OPERATOR_RE = /\b(site|inurl|intitle|intext|allintext|inbody|inanchor|filetype|ext|mime|title|url):/gi;

// The operators an engine receives must be ones it understands.
function unsupportedOperators(query, engine) {
  const supported = new Set(dork.nativeSupport(engine));
  const understandsFileType = ['filetype', 'ext', 'mime'].some((k) => supported.has(k));
  const found = new Set();
  let m;
  OPERATOR_RE.lastIndex = 0;
  while ((m = OPERATOR_RE.exec(query))) {
    const key = m[1].toLowerCase();
    if (['filetype', 'ext', 'mime'].includes(key)) {
      if (!understandsFileType) found.add(key);
      continue;
    }
    if (!supported.has(key)) found.add(key);
  }
  return [...found];
}

test('the engine registry is not empty', () => {
  assert.ok(ENGINE_NAMES.length > 10, `expected a real engine list, got ${ENGINE_NAMES.length}`);
});

test('every engine can be asked for a dork', () => {
  for (const engine of ENGINE_NAMES) {
    const query = dork.adaptQuery(DORK_QUERY, engine);
    assert.ok(query.length > 0, `${engine}: the adapted query must not be empty`);
    // The words of the query survive the adaptation, the operator token of an
    // engine that cannot use it does not.
    assert.match(query, /asyncio/, `${engine}: the query words must survive`);
  }
});

test('no engine is handed an operator it cannot understand', () => {
  for (const engine of ENGINE_NAMES) {
    const query = dork.adaptQuery(DORK_QUERY, engine);
    const bad = unsupportedOperators(query, engine);
    assert.deepEqual(bad, [], `${engine}: unsupported operators left in "${query}"`);
  }
});

test('the google family keeps the operator for the url builder', () => {
  // Google receives the operator as as_sitesearch/as_filetype, so the query
  // still has to carry it until the url is built.
  for (const engine of ['google', 'google_lite', 'chrome']) {
    assert.ok(dork.usesOperatorParameter(engine), `${engine} should use the parameter form`);
    const query = dork.adaptQuery(DORK_QUERY, engine);
    assert.match(query, /site:python\.org/);
  }
  assert.equal(dork.usesOperatorParameter('bing'), false);
});

test('an engine without operator support gets a clean query', () => {
  // wiby, github, wikipedia, archive and shodan have no operator support at
  // all: the operator is removed so the engine searches for the words, and
  // the site: constraint is enforced on the results afterwards.
  for (const engine of ['wiby', 'github', 'wikipedia', 'archive', 'shodan']) {
    const query = dork.adaptQuery(DORK_QUERY, engine);
    assert.deepEqual(unsupportedOperators(query, engine), [], `${engine}: ${query}`);
    assert.ok(!/site:/.test(query), `${engine}: the operator must be gone (${query})`);
    assert.match(query, /asyncio/);
  }
});

test('yandex is asked in its own dialect', () => {
  const query = dork.adaptQuery('inurl:login intitle:"admin" filetype:pdf site:python.org', 'yandex');
  assert.match(query, /url:login/);
  assert.match(query, /title:"admin"/);
  assert.match(query, /mime:pdf/);
  assert.match(query, /site:python\.org/);
});

test('the file type operator keeps its value when it is rewritten', () => {
  const query = dork.adaptQuery('filetype:pdf machine learning', 'yandex');
  assert.match(query, /mime:pdf/);
  assert.ok(!/mime:\s/.test(query), `the value must survive: ${query}`);
});

test('a query without operators is not touched', () => {
  for (const engine of ENGINE_NAMES) {
    assert.equal(dork.adaptQuery('asyncio tutorial', engine), 'asyncio tutorial');
  }
});

test('every engine reports its operator support', () => {
  const info = dork.parseDork('site:python.org inurl:login');
  for (const engine of ENGINE_NAMES) {
    const support = dork.engineSupport(engine, info);
    assert.ok(Array.isArray(support.supported), `${engine}: supported must be a list`);
    assert.ok(Array.isArray(support.unsupported), `${engine}: unsupported must be a list`);
    assert.equal(
      support.supported.length + support.unsupported.length,
      2,
      `${engine}: every used operator must be classified`,
    );
    assert.equal(support.site_native, dork.nativeSupport(engine).includes('site'));
  }
});

test('the site: constraint is enforced on the results of every engine', () => {
  const info = dork.parseDork('site:python.org');
  const kept = dork.enforceDork(
    [
      { url: 'https://www.python.org/' },
      { url: 'https://docs.python.org/3/' },
      { url: 'https://mybank.com/' },
    ],
    info,
  );
  assert.equal(kept.length, 2);
  for (const r of kept) assert.ok(r.url.includes('python.org'));
});

test('the fallback chain keeps every engine for a dork', () => {
  const info = dork.parseDork('site:python.org');
  const chain = ['duckduckgo', 'bing', 'mojeek', 'wiby', 'github'];
  const list = search.withFallbacks(chain, info);
  for (const engine of chain) {
    assert.ok(list.includes(engine), `${engine} must stay in the dork chain (${list.join(', ')})`);
  }
  // The engines that honour site: answer first.
  const capable = list.filter((e) => dork.engineSupport(e, info).supported.includes('site'));
  const firstIncapable = list.findIndex((e) => !dork.engineSupport(e, info).supported.includes('site'));
  const lastCapable = capable.reduce((acc, e) => Math.max(acc, list.indexOf(e)), -1);
  assert.ok(
    lastCapable < firstIncapable,
    `the operator-capable engines must come first (${list.join(', ')})`,
  );
});

test('a plain query keeps the configured fallback order', () => {
  const list = search.withFallbacks(['duckduckgo', 'bing', 'chrome'], null);
  assert.deepEqual(list, ['duckduckgo', 'bing', 'chrome']);
});

test('the google url builder moves the operator into a parameter', () => {
  const url = googleLite.buildLiteUrl({ q: 'site:python.org asyncio', hl: 'en', gl: 'us' }).url;
  assert.match(url, /as_sitesearch=python\.org/);
  assert.ok(!/[?&]q=[^&]*site%3A/i.test(url), `the operator must leave the query: ${url}`);
  assert.match(url, /[?&]q=asyncio/);
});

test('a datacenter-only pool is reported as the obstacle', () => {
  // Every exit with a raw ip address is a datacenter exit in this codebase.
  const dc = ['http://user:pass@203.0.113.10:8080', 'http://user:pass@198.51.100.7:3128'];
  assert.equal(googleLite.exitsAreDatacenter(dc), true);
  assert.match(googleLite.dorkObstacle(dc), /datacenter/i);

  const mixed = dc.concat(['http://user:residential@resi.example.com:8080']);
  assert.equal(googleLite.exitsAreDatacenter(mixed), false);
  assert.equal(googleLite.dorkObstacle(mixed), '');
});

test('a query that is nothing but an operator still asks for something', () => {
  // Stripping "site:github.com" from a query that contains nothing else
  // would leave the engine with an empty query. The value of the operator
  // becomes a plain word instead.
  for (const engine of ['wiby', 'github', 'wikipedia', 'archive', 'shodan']) {
    const query = dork.adaptQuery('site:github.com', engine);
    assert.ok(query.length > 0, `${engine}: the query must not be empty`);
    assert.match(query, /github\.com/);
  }
  // An engine that understands the operator keeps it.
  assert.equal(dork.adaptQuery('site:github.com', 'bing'), 'site:github.com');
});
