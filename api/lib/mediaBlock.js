'use strict';

const VIDEO_TYPE = new Set(['media', 'websocket']);
const TRACK_HOST =
  /(?:^|\.)(?:doubleclick\.net|googleadservices\.com|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|scorecardresearch\.com|facebook\.com|adservice\.google\.com|hotjar\.com|newrelic\.com)$/i;
const FONT_HOST = /(?:^|\.)(?:fonts\.gstatic\.com|fonts\.googleapis\.com)$/i;

function envOn(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return String(v) !== '0';
}

function maxImageBytes() {
  const n = parseInt(process.env.BLOCK_IMAGE_MAX || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function shouldAbort({ url, resourceType, headers } = {}) {
  const type = String(resourceType || '');
  const u = String(url || '');
  if (envOn('BLOCK_VIDEO', true) && (type === 'media' || /\.(?:mp4|webm|m3u8|mpd)(?:$|\?)/i.test(u))) return 'video';
  if (VIDEO_TYPE.has(type) && envOn('BLOCK_VIDEO', true)) return 'video';
  try {
    const h = new URL(u).hostname;
    if (envOn('BLOCK_TRACKERS', true) && TRACK_HOST.test(h)) return 'tracker';
    if (envOn('BLOCK_FONTS', false) && FONT_HOST.test(h)) return 'font';
  } catch {
    /* ignore */
  }
  if (envOn('BLOCK_IMAGES', false) && type === 'image') {
    const max = maxImageBytes();
    if (!max) return 'image';
    const len = Number((headers && (headers['content-length'] || headers['Content-Length'])) || 0);
    if (len && len > max) return 'image';
  }
  return null;
}

function applyRoute(route) {
  const req = route.request();
  const reason = shouldAbort({
    url: req.url(),
    resourceType: req.resourceType(),
    headers: typeof req.headers === 'function' ? req.headers() : {},
  });
  if (reason) return route.abort();
  return route.continue();
}

module.exports = { shouldAbort, applyRoute, TRACK_HOST };
