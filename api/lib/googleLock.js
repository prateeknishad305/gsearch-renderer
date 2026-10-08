'use strict';

const { proxyKey, intEnv } = require('./google');

const locks = new Map();

function maxPerIp() {
  return Math.max(1, intEnv('GOOGLE_NAV_PER_IP', 1));
}

function acquire(proxy) {
  const k = proxyKey(proxy);
  return new Promise((resolve) => {
    const go = () => {
      const s = locks.get(k) || { n: 0, wait: [] };
      if (s.n < maxPerIp()) {
        s.n += 1;
        locks.set(k, s);
        resolve({
          key: k,
          release() {
            s.n = Math.max(0, s.n - 1);
            const next = s.wait.shift();
            if (next) next();
            else if (s.n === 0 && s.wait.length === 0) locks.delete(k);
          },
        });
        return;
      }
      s.wait.push(go);
      locks.set(k, s);
    };
    go();
  });
}

function stats() {
  const out = {};
  for (const [k, s] of locks.entries()) out[k] = { active: s.n, queued: s.wait.length };
  return out;
}

module.exports = { acquire, stats, maxPerIp };
