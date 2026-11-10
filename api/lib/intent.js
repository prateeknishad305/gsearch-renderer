'use strict';

const BUY =
  /\b(?:buy|purchase|order|checkout|cart|price|cheap|deal|coupon|shop|store|discount|shipping|in stock)\b/i;
const NAV =
  /^(?:https?:\/\/|www\.)|\b(?:login|signin|official site|homepage|facebook\.com|twitter\.com|github\.com)\b/i;
const INFO =
  /\b(?:what is|what are|how to|why|when|who is|define|meaning|tutorial|guide|vs\.?|difference)\b/i;

function classify(query) {
  const q = String(query || '').trim();
  if (!q) return { intent: 'unknown', engines: [] };
  if (NAV.test(q) && !BUY.test(q)) {
    return { intent: 'navigational', engines: ['google', 'bing', 'duckduckgo'] };
  }
  if (BUY.test(q)) {
    return { intent: 'transactional', engines: ['google', 'bing', 'yahoo'] };
  }
  if (INFO.test(q)) {
    return { intent: 'informational', engines: ['google', 'duckduckgo', 'bing', 'brave'] };
  }
  return { intent: 'informational', engines: ['google', 'bing', 'duckduckgo'] };
}

function routingEnabled() {
  return String(process.env.INTENT_ROUTING || '0') === '1';
}

function preferEngines(query, current) {
  const info = classify(query);
  if (!routingEnabled()) return { ...info, list: current };
  const seen = new Set();
  const list = [];
  for (const e of info.engines.concat(current || [])) {
    if (!e || seen.has(e)) continue;
    seen.add(e);
    list.push(e);
  }
  return { ...info, list };
}

module.exports = { classify, preferEngines, routingEnabled };
