'use strict';

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function raceWidth() {
  return Math.min(16, Math.max(1, intEnv('PROXY_RACE', 4)));
}

function batches(list, size) {
  const n = Math.max(1, size || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function firstOk(fns) {
  if (!fns.length) return Promise.reject(new Error('no attempts'));
  return new Promise((resolve, reject) => {
    let pending = fns.length;
    let done = false;
    let lastErr = null;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    for (const fn of fns) {
      Promise.resolve()
        .then(() => fn(ac && ac.signal))
        .then((val) => {
          if (done) return;
          done = true;
          if (ac) ac.abort();
          resolve(val);
        })
        .catch((err) => {
          lastErr = err;
          pending -= 1;
          if (!done && pending <= 0) reject(lastErr);
        });
    }
  });
}

module.exports = { raceWidth, batches, firstOk, intEnv };
