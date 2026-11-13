'use strict';

// Chromium is resolved per platform:
//   Vercel  -> @sparticuz/chromium (serverless binary)
//   Docker / Railway / Render / local with Chrome installed -> system Chromium
//   fallback -> @sparticuz/chromium
//
// Both Chromium and Playwright are required lazily so a load/extraction failure
// surfaces as a normal JSON error instead of crashing module evaluation.

const { resolveLaunch } = require('./chromium');
const flavor = require('./browserFlavor');
const uaMask = require('./uaMask');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pwMod = null;
let camoufoxInstalled = false;

function loadPlaywrightMod() {
  if (!pwMod) pwMod = require('playwright-core');
  return pwMod;
}

const CAMOUFOX_VERSION = 'v158.0.1-beta.41';
const CAMOUFOX_BASE_URL = `https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_VERSION}`;
const CAMOUFOX_LINUX_URL = `${CAMOUFOX_BASE_URL}/camoufox-${CAMOUFOX_VERSION}-lin.x86_64.zip`;
const CAMOUFOX_INSTALL_DIR = '/opt/camoufox';
const CAMOUFOX_BIN = path.join(CAMOUFOX_INSTALL_DIR, 'camoufox-bin');

function ensureCamoufox() {
  if (camoufoxInstalled) return Promise.resolve(CAMOUFOX_BIN);
  
  // Check if already installed
  if (fs.existsSync(CAMOUFOX_BIN) && fs.existsSync(path.join(CAMOUFOX_INSTALL_DIR, 'omni.ja'))) {
    try {
      fs.chmodSync(CAMOUFOX_BIN, 0o755);
      camoufoxInstalled = true;
      return Promise.resolve(CAMOUFOX_BIN);
    } catch {}
  }
  
  return new Promise((resolve, reject) => {
    console.log('[camoufox] Not found, downloading...');
    const tmpZip = '/tmp/camoufox-auto.zip';
    const extractDir = '/tmp/camoufox-auto';
    
    // Download
    const downloadCmd = `curl -L "${CAMOUFOX_LINUX_URL}" -o "${tmpZip}" 2>/dev/null`;
    try {
      execSync(downloadCmd, { timeout: 300000, stdio: 'ignore' });
    } catch (e) {
      return reject(new Error('Camoufox download failed: ' + e.message));
    }
    
    // Extract
    try {
      execSync(`rm -rf "${extractDir}" && mkdir -p "${extractDir}" && unzip -q "${tmpZip}" -d "${extractDir}"`, { stdio: 'ignore' });
    } catch (e) {
      return reject(new Error('Camoufox extract failed: ' + e.message));
    }
    
    // Install
    try {
      execSync(`mkdir -p "${CAMOUFOX_INSTALL_DIR}" && cp -r "${extractDir}/camoufox/"* "${CAMOUFOX_INSTALL_DIR}/"`, { stdio: 'ignore' });
      fs.chmodSync(CAMOUFOX_BIN, 0o755);
      // Also ensure gfxtest is executable
      const gfxtest = path.join(CAMOUFOX_INSTALL_DIR, 'gfxtest');
      if (fs.existsSync(gfxtest)) fs.chmodSync(gfxtest, 0o755);
      camoufoxInstalled = true;
      console.log('[camoufox] Installed at', CAMOUFOX_BIN);
      resolve(CAMOUFOX_BIN);
    } catch (e) {
      reject(new Error('Camoufox install failed: ' + e.message));
    }
  });
}

function getCamoufoxPath() {
  // Check env first
  if (process.env.CAMOUFOX_PATH && fs.existsSync(process.env.CAMOUFOX_PATH)) {
    return process.env.CAMOUFOX_PATH;
  }
  // Check standard locations
  const standardPaths = [
    CAMOUFOX_BIN,
    '/usr/bin/camoufox',
    '/usr/local/bin/camoufox',
    '/opt/camoufox/camoufox',
    '/opt/camoufox/camoufox-bin',
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run'];

// Some HTTP proxy providers (PureVPN/pointtoserver, PVData, squid proxies...)
// mishandle Chromium's HTTP/2 towards Google and the connection silently
// stalls (curl h2 works, so it is a Chromium-h2-specific path bug). Falling
// back to HTTP/1.1 only when a proxy is in play keeps direct connections on h2
// while making proxied Google requests complete.
async function launchBrowser({ disableHttp2 = false, browser: browserName } = {}) {
  const spec = flavor.resolveFlavor(browserName);
  const extra = disableHttp2 ? ['--disable-http2'] : [];
  const g = require('./google');
  const pw = loadPlaywrightMod();
  
  // Auto-install Camoufox if requested and not found
  if (spec.id === 'camoufox' && spec.engine === 'firefox') {
    let camoufoxPath = getCamoufoxPath();
    if (!camoufoxPath) {
      try {
        camoufoxPath = await ensureCamoufox();
      } catch (e) {
        console.warn('[camoufox] Auto-install failed:', e.message);
      }
    }
    if (camoufoxPath) {
      spec.executablePath = camoufoxPath;
    }
  }
  
  if (spec.engine === 'firefox') {
    const opts = { headless: true };
    if (spec.executablePath) opts.executablePath = spec.executablePath;
    return pw.firefox.launch(opts);
  }
  if (spec.engine === 'webkit') {
    const opts = { headless: true };
    if (spec.executablePath) opts.executablePath = spec.executablePath;
    return pw.webkit.launch(opts);
  }
  const launch = await resolveLaunch();
  const exe = spec.executablePath && (spec.id === 'edge' || spec.id === 'brave') ? spec.executablePath : launch.executablePath;
  return pw.chromium.launch({
    args: [...launch.args, ...STEALTH_ARGS, ...g.chromiumArgs(), ...extra],
    executablePath: exe,
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

// Fallback only. The real UA is derived from the launched Chromium version so
// the claimed Chrome major always matches the engine actually running (a
// mismatch, e.g. Chrome/125 UA over Chromium 149, is an easy bot tell).
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function resolveUA(browser, fallback, flavorId) {
  const id = flavor.normalizeFlavor(flavorId);
  if (id !== 'chromium') return flavor.uaFor(id, 125);
  try {
    const ver = await browser.version();
    const m = String(ver).match(/(\d+)\.[\d.]+/);
    if (m) return flavor.uaFor('chromium', m[1]);
  } catch {
    /* ignore */
  }
  return fallback;
}

// Hides common automation fingerprints. Runs before any page script.
function stealthMarkup() {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  } catch {}
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
  } catch {}
  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : q.call(navigator.permissions, p);
    }
  } catch {}
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  } catch {}
  try {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  } catch {}
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const getParameter = gl.getParameter.bind(gl);
      gl.getParameter = (parameter) => {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter(parameter);
      };
    }
  } catch {}
  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (type === 'image/png') {
        const ctx = this.getContext('2d');
        if (ctx) {
          ctx.fillStyle = 'rgb(255, 0, 0)';
          ctx.fillRect(0, 0, 1, 1);
        }
      }
      return toDataURL.apply(this, arguments);
    };
  } catch {}
}

async function newSearchContext({ proxy, hl, gl, browser: existingBrowser } = {}) {
  const browser = existingBrowser || await launchBrowser({ disableHttp2: !!proxy });
  const ua = await resolveUA(browser, DESKTOP_UA, 'chromium');
  const profile = uaMask.profileFrom({ ua, flavorId: 'chromium', langs: ['en-US', 'en'] });
  const opts = {
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: profile.ua,
    viewport: { width: 1366, height: 900 },
    colorScheme: 'light',
    extraHTTPHeaders: uaMask.chHeaders(profile),
  };
  if (proxy) {
    // Split embedded credentials out of the URL: Chromium's network service
    // fails CONNECT with 407 unless credentials are passed as explicit
    // username/password options rather than only inside the server URL.
    opts.proxy = parseProxy(proxy);
  }
  try {
    const context = await browser.newContext(opts);
    await context.addInitScript(uaMask.apply.toString() + ';(' + uaMask.apply.toString() + ')(' + JSON.stringify(profile) + ');');
    await context.addInitScript(stealthMarkup);
    return { browser, context };
  } catch (err) {
    if (!existingBrowser) await browser.close().catch(() => {});
    throw err;
  }
}

// "http://user:pass@host:port" -> { server, username, password }
function parseProxy(proxy) {
  try {
    const u = new URL(proxy);
    if (/^socks/i.test(u.protocol) && (u.username || u.password)) {
      const err = new Error('Browser does not support socks5 proxy authentication');
      err.code = 'SKIP';
      throw err;
    }
    const out = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (err) {
    if (err && err.code === 'SKIP') throw err;
    return { server: proxy };
  }
}

async function launchBrowserWithVPNExtension({ disableHttp2 = false, browser: browserName } = {}) {
  const spec = flavor.resolveFlavor(browserName);
  const extra = disableHttp2 ? ['--disable-http2'] : [];
  const g = require('./google');
  const pw = loadPlaywrightMod();
  
  const extensionPath = process.env.VPN_EXTENSION_PATH;
  if (!extensionPath) {
    throw new Error('VPN_EXTENSION_PATH not set');
  }
  
  const vpnArgs = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];
  
  if (spec.engine === 'firefox') {
    const opts = { headless: false };
    if (spec.executablePath) opts.executablePath = spec.executablePath;
    return pw.firefox.launch(opts);
  }
  if (spec.engine === 'webkit') {
    const opts = { headless: false };
    if (spec.executablePath) opts.executablePath = spec.executablePath;
    return pw.webkit.launch(opts);
  }
  
  const launch = await require('./chromium').resolveLaunch();
  const exe = spec.executablePath && (spec.id === 'edge' || spec.id === 'brave') ? spec.executablePath : launch.executablePath;
  
  return pw.chromium.launch({
    args: [...launch.args, ...STEALTH_ARGS, ...g.chromiumArgs(), ...extra, ...vpnArgs],
    executablePath: exe,
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

module.exports = {
  launchBrowser,
  launchBrowserWithVPNExtension,
  newSearchContext,
  DESKTOP_UA,
  parseProxy,
  stealthMarkup,
  resolveUA,
  flavor,
  ensureCamoufox,
  getCamoufoxPath,
};
