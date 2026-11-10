'use strict';

const META = /(?:^|\.)(?:metadata\.google(?:internal)?|internal|local|localhost)$/i;
const SCHEME = /^(?:file|ftp|gopher|ws|wss|javascript|data):/i;

function isPrivateHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (META.test(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m4) return false;
  const a0 = Number(m4[1]);
  const a1 = Number(m4[2]);
  if (a0 === 10 || a0 === 127 || a0 === 0) return true;
  if (a0 === 169 && a1 === 254) return true;
  if (a0 === 192 && a1 === 168) return true;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return true;
  return false;
}

function inspectUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (SCHEME.test(s)) return { ok: false, reason: 'scheme' };
  try {
    const u = new URL(s);
    if (!/^https?:$/i.test(u.protocol)) return { ok: false, reason: 'scheme' };
    if (isPrivateHost(u.hostname)) return { ok: false, reason: 'private' };
    return { ok: true, url: u.toString(), host: u.hostname };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function inspectQuery(q) {
  const raw = String(q || '');
  const hits = [];
  const re = /\b(?:https?:\/\/[^\s]+|(?:\d{1,3}\.){3}\d{1,3})\b/gi;
  let m;
  while ((m = re.exec(raw))) {
    const item = inspectUrl(/^https?:/i.test(m[0]) ? m[0] : `http://${m[0]}`);
    if (!item.ok) hits.push({ value: m[0], reason: item.reason });
  }
  return { ok: hits.length === 0, blocked: hits };
}

module.exports = { isPrivateHost, inspectUrl, inspectQuery };
