#!/usr/bin/env node
'use strict';

const { get } = require('node:http');
const { request: httpsRequest } = require('node:https');
const { URL } = require('node:url');

const ENGINES = [
  'google',
  'bing',
  'startpage',
  'duckduckgo',
  'yahoo',
  'mojeek',
  'yandex',
  'qwant',
  'ecosia',
  'brave',
];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return dflt;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function fetchJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = u.protocol === 'http:' ? require('node:http') : require('node:https');
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': 'gsearch-resi-check', accept: 'application/json', ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = raw.slice(0, 300);
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            err.body = raw.slice(0, 300);
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? require('node:http') : require('node:https');
    const req = lib.request(u, { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'gsearch-resi-check' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function publicIp() {
  const endpoints = [
    { url: 'https://api.ipify.org?format=json', parse: (t) => JSON.parse(t).ip },
    { url: 'https://api64.ipify.org?format=json', parse: (t) => JSON.parse(t).ip },
    { url: 'https://ipv4.icanhazip.com', parse: (t) => t.trim() },
  ];
  for (const e of endpoints) {
    try {
      const t = await fetchText(e.url, 7000);
      const ip = String(e.parse(t) || '').trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* next */
    }
  }
  throw new Error('public IP lookup failed');
}

async function lookupGeo(ip) {
  const fields =
    'status,message,query,country,regionName,city,isp,org,as,mobile,proxy,hosting';
  try {
    return await fetchJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`, {
      timeoutMs: 8000,
    });
  } catch {
    return { status: 'fail', query: ip };
  }
}

function verdict(geo) {
  if (!geo || geo.status !== 'success') return 'unknown — geo lookup failed';
  if (geo.hosting) return 'HOSTING/DC — Mojeek/Yandex/Qwant/Ecosia/Brave will fail from here';
  if (geo.proxy) return 'VPN/proxy ASN — captcha engines usually fail';
  if (geo.mobile) return 'MOBILE residential — run the renderer on this device (Termux)';
  return 'likely residential ISP — run the renderer on this network, not through a VPS';
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function engineRow(api, key, engine, query, timeoutMs) {
  const u = new URL('/api/search', api);
  u.searchParams.set('q', query);
  u.searchParams.set('engine', engine);
  u.searchParams.set('num', '5');
  u.searchParams.set('nocache', '1');
  u.searchParams.set('fallback', '0');
  u.searchParams.set('proxyless', '1');
  const headers = {};
  if (key) headers['X-API-KEY'] = key;
  const t0 = Date.now();
  try {
    const r = await fetchJson(u.href, { timeoutMs, headers });
    const ms = Date.now() - t0;
    const ok = !!r.success;
    const n = r.count || 0;
    const code = ok ? 'OK' : r.code || 'FAIL';
    const src = r.source || '-';
    return { engine, ok, n, code, src, ms };
  } catch (err) {
    return { engine, ok: false, n: 0, code: 'TIMEOUT', src: '-', ms: Date.now() - t0, err: err.message };
  }
}

async function main() {
  const api = arg('api', process.env.RENDERER_URL || 'http://127.0.0.1:3000');
  const key = arg('key', process.env.API_TOKEN || '');
  const query = arg('q', 'open source database');
  const skipSweep = flag('ip-only');
  const timeoutMs = parseInt(arg('timeout', '25000'), 10) || 25000;

  console.log('gsearch resi-check');
  console.log('');

  const ip = await publicIp();
  const geo = await lookupGeo(ip);
  console.log(`Home IP:  ${ip}`);
  if (geo.status === 'success') {
    console.log(`Place:    ${geo.city || '-'}, ${geo.regionName || '-'}, ${geo.country || '-'}`);
    console.log(`ISP:      ${geo.isp || '-'}`);
    console.log(`Org:      ${geo.org || '-'}`);
    console.log(`ASN:      ${geo.as || '-'}`);
    console.log(`Flags:    mobile=${!!geo.mobile} hosting=${!!geo.hosting} proxy=${!!geo.proxy}`);
  } else {
    console.log('Geo:      unavailable');
  }
  console.log(`Verdict:  ${verdict(geo)}`);
  console.log('');

  if (skipSweep) {
    console.log('Skip engine sweep (--ip-only).');
    console.log('Phone: bash scripts/termux.sh');
    return;
  }

  let health;
  try {
    health = await fetchJson(new URL('/api/health', api).href, { timeoutMs: 8000 });
  } catch (err) {
    console.log(`Renderer: down (${api}) — ${err.message}`);
    console.log('');
    console.log('Start on THIS network (phone/home), not a VPS:');
    console.log('  bash scripts/termux.sh');
    console.log('  node scripts/resi-check.js --api http://127.0.0.1:3000');
    process.exitCode = 2;
    return;
  }

  const rt = health.runtime || {};
  console.log(`Renderer: ${api}`);
  console.log(`Platform: ${rt.platform || '-'}  chromium: ${rt.chromium_path || rt.executablePath || '-'}`);
  console.log(`Uptime:   ${health.uptime_s}s  cache: ${(health.cache && health.cache.size) || 0}`);
  console.log(`Query:    ${query}  proxyless=1 fallback=0`);
  console.log('');
  console.log(`${pad('engine', 16)}${pad('status', 22)}${pad('n', 6)}${pad('src', 10)}ms`);
  console.log('-'.repeat(56));

  for (const engine of ENGINES) {
    const row = await engineRow(api, key, engine, query, timeoutMs);
    const status = row.ok ? 'OK' : row.code;
    console.log(`${pad(row.engine, 16)}${pad(status, 22)}${pad(row.n, 6)}${pad(row.src, 10)}${row.ms}`);
  }

  console.log('');
  console.log('Captcha engines need the renderer on a phone/home ISP, not a hosting IP.');
  console.log('  bash scripts/termux.sh');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
