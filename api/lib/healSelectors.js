'use strict';

const FALLBACK = [
  'div.g a h3',
  'div.yuRUbf > a',
  'a[jsname="UWckNb"]',
  'h3.LC20lb',
  'a[data-ved] h3',
  'div.MjjYud h3',
  'h2 a[href^="http"]',
  'article a[href^="http"]',
  '.result a[href^="http"]',
  'li.b_algo h2 a',
];

function fallbackSelectors() {
  const extra = String(process.env.HEAL_SELECTORS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.concat(FALLBACK);
}

function harvest(html, limit = 20) {
  const raw = String(html || '');
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  const re = /<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(raw))) {
    let url = m[1];
    try {
      url = decodeURIComponent(url.replace(/&amp;/g, '&'));
    } catch {
      /* keep */
    }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const title = String(m[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || title.length < 2) continue;
    seen.add(url);
    out.push({ title, url, snippet: '', healed: true });
    if (out.length >= limit) break;
  }
  return out;
}

function needsHeal(results) {
  return !Array.isArray(results) || results.length === 0;
}

module.exports = { fallbackSelectors, harvest, needsHeal };
