'use strict';

// Drops non-organic "garbage" from Google SERPs: video results (YouTube and
// friends) and AI Mode / AI Overview chrome. Defaults are ON; disable with
// FILTER_VIDEO=0 or FILTER_AI_MODE=0.

const { hostMatchesSite } = require('./dork');

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

// Social/UGC hosts: usually SEO noise for dork-style discovery queries.
// Default ON; disable with FILTER_SOCIAL=0 or ?social=0.
const SOCIAL_HOST =
  /(?:^|\.)(?:facebook\.com|fb\.com|fb\.watch|instagram\.com|instagr\.am|twitter\.com|x\.com|linkedin\.com|reddit\.com|tiktok\.com|pinterest\.com|youtube\.com|youtu\.be|tumblr\.com|quora\.com|medium\.com|threads\.net|snapchat\.com|discord\.com|discord\.gg|telegram\.org|t\.me|vk\.com|weibo\.com|douyin\.com|line\.me|whatsapp\.com)$/i;

// Developer/docs/tutorial hosts. OFF by default; enable with FILTER_DEV=1,
// ?dev=1 or ?unique=1.
const DEV_HOST =
  /(?:^|\.)(?:github\.com|github\.io|githubusercontent\.com|gitlab\.com|gitlab\.io|bitbucket\.org|bitbucket\.io|stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|npmjs\.com|pypi\.org|packagist\.org|rubygems\.org|crates\.io|nuget\.org|dev\.to|hashnode\.com|mdn\.mozilla\.org|w3schools\.com|geeksforgeeks\.org|tutorialspoint\.com|javatpoint\.com|baeldung\.com|freecodecamp\.org|codecademy\.com|leetcode\.com|hackerrank\.com|sourceforge\.net|readthedocs\.io|gitbook\.io|devdocs\.io|docs\.rs|pkg\.go\.dev|godoc\.org|rubydoc\.info|cppreference\.com|learn\.microsoft\.com|pastebin\.com|gist\.github\.com|codesandbox\.io|jsfiddle\.net|codepen\.io)$/i;

const UGC_HOST =
  /(?:^|\.)(?:scribd\.com|slideshare\.net|issuu\.com|academia\.edu|researchgate\.net|fandom\.com|wikipedia\.org|wikihow\.com|about\.me|linktr\.ee|hubpages\.com|vocal\.media|answers\.com|ask\.com|ehow\.com|genius\.com|pdfcoffee\.com|studocu\.com|coursehero\.com|chegg\.com|brainly\.com|quizlet\.com|docsity\.com|goodreads\.com|wattpad\.com|archiveofourown\.org|fanfiction\.net)$/i;

const BLOG_HOST =
  /(?:^|\.)(?:blogspot\.com|blogger\.com|wordpress\.com|substack\.com|ghost\.io|tumblr\.com|livejournal\.com|typepad\.com|weebly\.com|wixsite\.com|medium\.com|hatenablog\.com|over-blog\.com|jimdo\.com)$/i;
const BLOG_HOST_PREFIX = /^(?:blog|blogs|weblog)(?:\.|$)/i;
const BLOG_PATH = /(?:^|\/)(?:blog|blogs|weblog)(?:\/|$)/i;

const FORUM_HOST =
  /(?:^|\.)(?:discourse\.org|phpbb\.com|vbulletin\.com|xenforo\.com|groups\.google\.com|4chan\.org|4channel\.org|lemmy\.world|kbin\.social|discourse\.group)$/i;
const FORUM_HOST_PREFIX = /^(?:forum|forums|board|boards|community|talk|discuss)(?:\.|$)/i;
const FORUM_PATH =
  /(?:showthread|viewtopic|viewforum|showpost|viewthread)\.php|(?:^|\/)(?:forums?|boards?|community|discuss(?:ion)?s?|threads?|topic\/|t-\d|t\/\d)(?:\/|$|\?)|\/index\.php\?(?:topic|board)=/i;

function dropSocial() {
  return envOn('FILTER_SOCIAL', true);
}

function dropDev() {
  return envOn('FILTER_DEV', false);
}

function dropUgc() {
  return envOn('FILTER_UGC', false);
}

function dropForum() {
  return envOn('FILTER_FORUM', false);
}

function dropBlog() {
  return envOn('FILTER_BLOG', false);
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function labelsOf(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
}

function isSocialHost(host) {
  return SOCIAL_HOST.test(String(host || ''));
}

function isDevHost(host) {
  return DEV_HOST.test(String(host || ''));
}

function isUgcHost(host) {
  return UGC_HOST.test(String(host || ''));
}

function isBlogHost(host) {
  const h = String(host || '').toLowerCase();
  if (BLOG_HOST.test(h)) return true;
  if (/(?:^|\.)blogspot\./i.test(h)) return true;
  const labels = labelsOf(h);
  return labels.some((lab) => BLOG_HOST_PREFIX.test(`${lab}.`));
}

function isForumHost(host) {
  const h = String(host || '').toLowerCase();
  if (FORUM_HOST.test(h)) return true;
  const labels = labelsOf(h);
  return labels.some((lab) => FORUM_HOST_PREFIX.test(`${lab}.`));
}

function isForumUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (isForumHost(u.hostname)) return true;
    return FORUM_PATH.test(`${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}

function isBlogUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (isBlogHost(u.hostname)) return true;
    return BLOG_PATH.test(u.pathname);
  } catch {
    return isBlogHost(hostOf(url));
  }
}

function parseResultFilters(query = {}) {
  const opts = {};
  const unique = query.unique === '1' || query.unique === 'true';
  const exclude = new Set(
    String(query.exclude || '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (unique) {
    opts.social = true;
    opts.dev = true;
    opts.ugc = true;
    opts.forum = true;
    opts.blog = true;
  }
  if (exclude.has('social')) opts.social = true;
  if (exclude.has('dev')) opts.dev = true;
  if (exclude.has('ugc')) opts.ugc = true;
  if (exclude.has('forum')) opts.forum = true;
  if (exclude.has('blog')) opts.blog = true;
  if (query.social === '0' || query.social === 'false') opts.social = false;
  if (query.social === '1' || query.social === 'true') opts.social = true;
  if (query.dev === '0' || query.dev === 'false') opts.dev = false;
  if (query.dev === '1' || query.dev === 'true') opts.dev = true;
  if (query.ugc === '0' || query.ugc === 'false') opts.ugc = false;
  if (query.ugc === '1' || query.ugc === 'true') opts.ugc = true;
  if (query.forum === '0' || query.forum === 'false') opts.forum = false;
  if (query.forum === '1' || query.forum === 'true') opts.forum = true;
  if (query.blog === '0' || query.blog === 'false') opts.blog = false;
  if (query.blog === '1' || query.blog === 'true') opts.blog = true;
  const domains = String(query.exclude_domains || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (domains.length) opts.excludeDomains = domains;
  return opts;
}

function applyDomainFilters(list, opts = {}) {
  if (!Array.isArray(list)) return list;
  const useSocial = opts.social === undefined ? dropSocial() : opts.social;
  const useDev = opts.dev === undefined ? dropDev() : opts.dev;
  const useUgc = opts.ugc === undefined ? dropUgc() : opts.ugc;
  const useForum = opts.forum === undefined ? dropForum() : opts.forum;
  const useBlog = opts.blog === undefined ? dropBlog() : opts.blog;
  const blocked = (opts.excludeDomains || []).map((d) => String(d).toLowerCase());
  const allowed = (opts.allowDomains || []).map((d) => String(d).toLowerCase());
  if (!useSocial && !useDev && !useUgc && !useForum && !useBlog && !blocked.length) return list;
  return list.filter((r) => {
    const url = String((r && r.url) || '');
    const host = hostOf(url);
    if (!host) return true;
    if (allowed.some((d) => hostMatchesSite(host, d))) return true;
    if (useSocial && isSocialHost(host)) return false;
    if (useDev && isDevHost(host)) return false;
    if (useUgc && isUgcHost(host)) return false;
    if (useForum && isForumUrl(url)) return false;
    if (useBlog && isBlogUrl(url)) return false;
    for (const d of blocked) {
      if (hostMatchesSite(host, d)) return false;
    }
    return true;
  });
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
  SOCIAL_HOST,
  DEV_HOST,
  UGC_HOST,
  BLOG_HOST,
  FORUM_HOST,
  dropVideo,
  dropAiMode,
  dropSocial,
  dropDev,
  dropUgc,
  dropForum,
  dropBlog,
  isVideoUrl,
  isAiModeTitle,
  isGarbageUrl,
  isGarbageResult,
  isSocialHost,
  isDevHost,
  isUgcHost,
  isBlogHost,
  isForumHost,
  isForumUrl,
  isBlogUrl,
  cleanResults,
  parseResultFilters,
  applyDomainFilters,
};
