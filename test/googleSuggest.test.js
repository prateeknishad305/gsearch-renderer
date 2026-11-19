'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { parseSuggestPayload, parseNewsRss } = require('../api/lib/googleSuggest');

test('google suggest payload is parsed into a list', () => {
  const body = '["openai chat",["openai chat gpt","openai chat","openai chatgpt login"]]';
  assert.deepEqual(parseSuggestPayload(body), [
    'openai chat gpt',
    'openai chat',
    'openai chatgpt login',
  ]);
});

test('google suggest payload tolerates the XSSI prefix and junk', () => {
  const body = ")]}'\n[\"q\",[\"a\",\"b\"]]";
  assert.deepEqual(parseSuggestPayload(body), ['a', 'b']);
  assert.deepEqual(parseSuggestPayload(''), []);
  assert.deepEqual(parseSuggestPayload('not json'), []);
  assert.deepEqual(parseSuggestPayload('["q","not-an-array"]'), []);
});

test('google news rss is parsed into records', () => {
  const xml = `<rss><channel>
  <item>
    <title>OpenAI ships a new model - The GitHub Blog</title>
    <link>https://news.google.com/rss/articles/CBMiabc</link>
    <guid isPermaLink="false">CBMiabc</guid>
    <pubDate>Tue, 17 Nov 2026 20:20:29 GMT</pubDate>
    <source url="https://github.blog">The GitHub Blog</source>
  </item>
  <item>
    <title>Another headline</title>
    <link>https://news.google.com/rss/articles/CBMidef</link>
    <pubDate>Wed, 18 Nov 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
  const out = parseNewsRss(xml);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'OpenAI ships a new model - The GitHub Blog');
  assert.equal(out[0].source, 'The GitHub Blog');
  assert.equal(out[0].sourceUrl, 'https://github.blog');
  assert.equal(out[0].pubDate, 'Tue, 17 Nov 2026 20:20:29 GMT');
  assert.match(out[0].link, /news\.google\.com/);
  assert.equal(out[1].title, 'Another headline');
});

test('google news rss handles entities and empty feeds', () => {
  const xml = '<item><title>Tom &amp; Jerry &lt;3</title><link>https://x.example/a</link></item>';
  const out = parseNewsRss(xml);
  assert.equal(out[0].title, 'Tom & Jerry <3');
  assert.deepEqual(parseNewsRss('<rss><channel></channel></rss>'), []);
});

test('a proxy that rejects the credentials is not counted as alive', async () => {
  const { checkProxy } = require('../api/lib/proxyFetch');
  const exitState = require('../api/lib/exitState');
  const server = http.createServer((req, res) => {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const alive = await checkProxy(`http://127.0.0.1:${port}`, 2000);
    assert.equal(alive, false, '407 must not be reported as a working exit');
  } finally {
    server.close();
    exitState.reset();
  }
});
