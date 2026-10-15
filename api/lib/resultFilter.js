'use strict';

// Drops non-organic "garbage" from Google SERPs: video results (YouTube and
// friends) and AI Mode / AI Overview chrome. Defaults are ON; disable with
// FILTER_VIDEO=0 or FILTER_AI_MODE=0.

function envOn(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return String(v) !== '0';
}

function dropVideo() {
  return envOn('FILTER_VIDEO', true);
}

function dropAiMode() {
  return envOn('FILTER_AI_MODE', true);
}

const VIDEO_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com|ggpht\.com|youtube-nocookie\.com|fb\.watch)$/i;

// Social video/reel paths (not the whole social host, so normal pages survive).
const VIDEO_PATH = /(?:(?:^|\.)(?:facebook\.com|fb\.watch)\/.*\/(?:videos?|watch)\b|(?:^|\.)(?:instagram\.com|instagr\.am)\/(?:reel|reels|tv|p)\/)/i;

// Titles that belong to AI Mode / AI Overview UI or other non-organic chrome.
const AI_TOKENS = new Set([
  'ai mode',
  'ai overview',
  'ai overviews',
  'try ai mode',
  'search labs',
  'show more',
  'show all',
  'show more ai overview',
  'ask follow up',
  'ask a follow up',
]);

// Prefix patterns catch flavoured AI chrome like "AI Mode replied: ...".
const AI_PREFIX = /^(?:ai\s+(?:mode|overview)\b|try\s+ai\s+mode\b)/i;

function isAiModeTitle(title) {
  const t = String(title || '').trim();
  if (AI_TOKENS.has(t.toLowerCase())) return true;
  return AI_PREFIX.test(t);
}

function isVideoUrl(url) {
  try {
    const u = new URL(String(url || ''), 'https://www.google.com');
    if (VIDEO_HOST.test(u.hostname)) return true;
    return VIDEO_PATH.test(`${u.hostname}${u.pathname}`);
  } catch {
    return false;
  }
}

function isGarbageUrl(url) {
  return dropVideo() && isVideoUrl(url);
}

function isGarbageResult(item) {
  if (!item) return true;
  if (isGarbageUrl(item.url)) return true;
  if (dropAiMode() && isAiModeTitle(item.title)) return true;
  return false;
}

function cleanResults(list) {
  return (list || []).filter((r) => !isGarbageResult(r));
}

module.exports = {
  VIDEO_HOST,
  AI_TOKENS,
  dropVideo,
  dropAiMode,
  isVideoUrl,
  isAiModeTitle,
  isGarbageUrl,
  isGarbageResult,
  cleanResults,
};
