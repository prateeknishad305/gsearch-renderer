'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isVideoUrl,
  isAiModeTitle,
  isGarbageUrl,
  cleanResults,
  AI_TOKENS,
} = require('../api/lib/resultFilter');
const { PARSERS } = require('../api/lib/lite');

function withEnv(pairs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(pairs)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('video hosts are detected', () => {
  assert.equal(isVideoUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isVideoUrl('https://youtu.be/abc'), true);
  assert.equal(isVideoUrl('https://m.youtube.com/watch?v=abc'), true);
  assert.equal(isVideoUrl('https://i.ytimg.com/vi/abc/hq.jpg'), true);
  assert.equal(isVideoUrl('https://example.com/watch'), false);
  // Social video/reel paths are garbage, normal social pages are not.
  assert.equal(isVideoUrl('https://www.facebook.com/natashaskitchen/posts/123/videos/456'), true);
  assert.equal(isVideoUrl('https://www.facebook.com/gordonramsay/videos/how-to-coo'), true);
  assert.equal(isVideoUrl('https://www.instagram.com/reel/DOoz0lYjwxF/'), true);
  assert.equal(isVideoUrl('https://www.facebook.com/somebusiness/'), false);
  assert.equal(isVideoUrl('https://www.instagram.com/someuser/'), false);
});

test('AI mode titles are flagged', () => {
  assert.equal(isAiModeTitle('AI Mode'), true);
  assert.equal(isAiModeTitle('ai overview'), true);
  assert.equal(isAiModeTitle('AI Mode replied: '), true);
  assert.equal(isAiModeTitle('AI Overview: How to cook rice'), true);
  assert.equal(isAiModeTitle('Show more'), true);
  assert.ok(AI_TOKENS.has('search labs'));
  assert.equal(isAiModeTitle('Introduction to AI'), false);
});

test('garbage filtering is on by default and can be toggled off', () => {
  withEnv({ FILTER_VIDEO: undefined, FILTER_AI_MODE: undefined }, () => {
    assert.equal(isGarbageUrl('https://youtu.be/x'), true);
    const cleaned = cleanResults([
      { title: 'Real result', url: 'https://example.com/a' },
      { title: 'Video', url: 'https://www.youtube.com/watch?v=z' },
      { title: 'AI Mode', url: 'https://example.com/b' },
    ]);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].url, 'https://example.com/a');
  });
  withEnv({ FILTER_VIDEO: '0' }, () => {
    assert.equal(isGarbageUrl('https://youtu.be/x'), false);
  });
  withEnv({ FILTER_AI_MODE: '0' }, () => {
    assert.equal(cleanResults([{ title: 'AI Mode', url: 'https://example.com/b' }]).length, 1);
  });
});

test('google lite parser drops youtube and ai-mode chrome', () => {
  const html =
    '<h3 class="r"><a href="/url?q=https://www.youtube.com/watch%3Fv%3Dabc">Some Video</a></h3>' +
    '<h3 class="r"><a href="/url?q=https://example.com/real">Real Result</a></h3>' +
    '<h3 class="r"><a href="/url?q=https://example.com/ai">AI Mode</a></h3>';
  const out = PARSERS.google(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://example.com/real');
  assert.equal(out[0].title, 'Real Result');
});
