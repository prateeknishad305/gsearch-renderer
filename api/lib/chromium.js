'use strict';

const fs = require('fs');

const SYSTEM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--mute-audio',
  '--hide-scrollbars',
  '--disable-extensions',
  '--no-first-run',
];

const SYSTEM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome-unstable',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let chromiumMod = null;
let cachedLaunch = null;

function existingPath(p) {
  if (!p) return null;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return p;
    } catch {
      return null;
    }
  }
}

function extraArgs() {
  return String(process.env.CHROMIUM_ARGS || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findSystemChromium() {
  const fromEnv =
    existingPath(process.env.CHROMIUM_PATH) ||
    existingPath(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) ||
    existingPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (fromEnv) return fromEnv;
  for (const candidate of SYSTEM_CANDIDATES) {
    const hit = existingPath(candidate);
    if (hit) return hit;
  }
  return null;
}

function detectPlatform() {
  if (process.env.VERCEL) return 'vercel';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) return 'railway';
  if (process.env.RENDER) return 'render';
  if (process.env.FLY_APP_NAME) return 'fly';
  if (fs.existsSync('/.dockerenv')) return 'docker';
  return 'local';
}

function requestedSource() {
  const raw = String(process.env.CHROMIUM_SOURCE || 'auto').toLowerCase().trim();
  if (raw === 'sparticuz' || raw === 'system') return raw;
  return 'auto';
}

function chooseSource(systemPath) {
  const requested = requestedSource();
  if (requested === 'sparticuz') return 'sparticuz';
  if (requested === 'system') return 'system';
  if (process.env.VERCEL) return 'sparticuz';
  if (systemPath) return 'system';
  return 'sparticuz';
}

async function loadSparticuz() {
  if (!chromiumMod) {
    const mod = await import('@sparticuz/chromium');
    chromiumMod = mod.default || mod;
  }
  return chromiumMod;
}

async function resolveLaunch() {
  if (cachedLaunch && cachedLaunch.executablePath) return cachedLaunch;

  const systemPath = findSystemChromium();
  const source = chooseSource(systemPath);

  if (source === 'system') {
    if (!systemPath) {
      const err = new Error(
        'CHROMIUM_SOURCE=system but no Chromium binary was found. Set CHROMIUM_PATH or install Chromium/Chrome.'
      );
      err.code = 'NO_CHROMIUM';
      throw err;
    }
    cachedLaunch = {
      source: 'system',
      executablePath: systemPath,
      args: [...SYSTEM_ARGS, ...extraArgs()],
      platform: detectPlatform(),
    };
    return cachedLaunch;
  }

  const chromiumBin = await loadSparticuz();
  cachedLaunch = {
    source: 'sparticuz',
    executablePath: await chromiumBin.executablePath(),
    args: [...chromiumBin.args, ...extraArgs()],
    platform: detectPlatform(),
  };
  return cachedLaunch;
}

function runtimeInfo() {
  const systemPath = findSystemChromium();
  const source = cachedLaunch ? cachedLaunch.source : chooseSource(systemPath);
  return {
    platform: detectPlatform(),
    chromium_source: source,
    chromium_path: (cachedLaunch && cachedLaunch.executablePath) || systemPath || null,
  };
}

function resetLaunchCache() {
  cachedLaunch = null;
}

module.exports = {
  findSystemChromium,
  resolveLaunch,
  runtimeInfo,
  detectPlatform,
  chooseSource,
  resetLaunchCache,
  SYSTEM_ARGS,
};
