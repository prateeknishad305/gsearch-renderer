'use strict';

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const waiters = [];
let active = 0;
let accepted = 0;
let rejected = 0;
let completed = 0;

function concurrency() {
  return intEnv('QUEUE_CONCURRENCY', intEnv('BROWSER_WORKERS', intEnv('MAX_CONTEXTS', 2)));
}

function acquire(ms) {
  accepted += 1;
  if (active < concurrency()) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const wait = intEnv('QUEUE_WAIT_MS', 8000);
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      rejected += 1;
      const e = new Error('work queue timeout');
      e.code = 'QUEUE_TIMEOUT';
      reject(e);
    }, ms || wait);
    waiters.push(waiter);
  }).then(() => {
    active += 1;
  });
}

function release() {
  completed += 1;
  if (active > 0) active -= 1;
  const next = waiters.shift();
  if (next) next();
}

async function run(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function snapshot() {
  return {
    active,
    waiting: waiters.length,
    concurrency: concurrency(),
    accepted,
    rejected,
    completed,
  };
}

function reset() {
  waiters.length = 0;
  active = 0;
  accepted = rejected = completed = 0;
}

module.exports = { acquire, release, run, snapshot, reset, concurrency };
