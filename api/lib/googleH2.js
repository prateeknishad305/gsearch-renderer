'use strict';

const http = require('http');
const http2 = require('http2');
const tls = require('tls');
const zlib = require('zlib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function chromeHeaders(cookie, extra) {
  return {
    'user-agent': UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': extra && extra.site ? extra.site : 'none',
    'sec-fetch-user': '?1',
    cookie: cookie || 'CONSENT=YES+cb.20210328-17-p0.en+FX+diag; SOCS=CAI',
  };
}

function unzip(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
  return buf.toString('utf8');
}

function connectProxy(hostname, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const headers = { Host: `${hostname}:443` };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password || '');
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${hostname}:443`,
      headers,
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    req.on('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        if (socket) socket.destroy();
        reject(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function tlsOver(socket, hostname) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      { socket, servername: hostname, ALPNProtocols: ['h2'], rejectUnauthorized: true },
      () => resolve(s)
    );
    s.on('error', reject);
  });
}

async function h2req(url, headers, { proxy, timeoutMs } = {}) {
  const t = new URL(url);
  const timeout = Math.max(800, timeoutMs || 12000);
  let tlsSock;
  if (proxy) {
    const sock = await connectProxy(t.hostname, proxy, Math.min(8000, timeout));
    tlsSock = await tlsOver(sock, t.hostname);
  } else {
    tlsSock = await new Promise((resolve, reject) => {
      const s = tls.connect(
        { host: t.hostname, port: 443, servername: t.hostname, ALPNProtocols: ['h2'], rejectUnauthorized: true },
        () => resolve(s)
      );
      s.on('error', reject);
    });
  }
  const session = http2.connect(`https://${t.hostname}`, { createConnection: () => tlsSock });
  const reqHeaders = {
    ':method': 'GET',
    ':path': `${t.pathname}${t.search}`,
    ':authority': t.hostname,
    ':scheme': 'https',
  };
  for (const [k, v] of Object.entries(headers)) reqHeaders[k.toLowerCase()] = v;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.close();
      reject(new Error('h2 timeout'));
    }, timeout);
    session.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const req = session.request(reqHeaders);
    const chunks = [];
    req.on('response', (h) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        clearTimeout(timer);
        session.close();
        const enc = h['content-encoding'] || '';
        const html = unzip(Buffer.concat(chunks), enc);
        const cookies = [];
        const sc = h['set-cookie'];
        if (Array.isArray(sc)) sc.forEach((v) => cookies.push(String(v).split(';')[0]));
        else if (sc) cookies.push(String(sc).split(';')[0]);
        resolve({
          status: h[':status'] || 0,
          html,
          location: h.location || '',
          cookies,
        });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

async function fetchHtml(url, { proxy, timeoutMs } = {}) {
  const home = await h2req('https://www.google.com/', chromeHeaders(null, { site: 'none' }), { proxy, timeoutMs });
  const cookie = ['CONSENT=YES+cb.20210328-17-p0.en+FX+diag', 'SOCS=CAI']
    .concat(home.cookies || [])
    .join('; ');
  return h2req(url, chromeHeaders(cookie, { site: 'same-origin' }), { proxy, timeoutMs });
}

module.exports = { fetchHtml, h2req, chromeHeaders };
