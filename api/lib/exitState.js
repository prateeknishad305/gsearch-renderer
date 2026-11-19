'use strict';

// Per-exit capability memory.
//
// Most datacenter IPs are blocked by Google, and many proxy providers do not
// implement HTTP CONNECT at all - they only forward absolute-URI plain HTTP.
// Before this module every request re-probed the same unusable exits and paid
// the full timeout again, which is what made the Google path look permanently
// "blocked" and slow. Exits are labelled once and reused for a while.
//
// kinds:
//   'tunnel' - CONNECT works, the exit can reach https targets
//   'plain'  - only absolute-URI plain HTTP works, so it cannot reach https
//   'gated'  - the tunnel works but the exit got an interstitial
//   'dead'   - the exit does not answer at all

const TTL_OK = 10 * 60 * 1000;
const TTL_BAD = 5 * 60 * 1000;

const states = new Map();

function identity(proxy) {
  if (!proxy) return 'direct';
  try {
    const u = new URL(String(proxy));
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return String(proxy);
  }
}

function note(proxy, kind) {
  if (!proxy) return;
  states.set(identity(proxy), { kind, at: Date.now() });
}

function get(proxy) {
  const s = states.get(identity(proxy));
  if (!s) return null;
  const ttl = s.kind === 'dead' ? TTL_BAD : TTL_OK;
  if (Date.now() - s.at > ttl) {
    states.delete(identity(proxy));
    return null;
  }
  return s;
}

// Unknown exits are allowed one probe; known-bad exits are skipped outright.
// A 'gated' exit still works, it just answered with an interstitial, so it
// stays usable.
function canUse(proxy) {
  const s = get(proxy);
  if (!s) return true;
  return s.kind === 'tunnel' || s.kind === 'gated';
}

// Gated exits are tried last: they are worth retrying but should not be the
// first choice.
function sortByReliability(list) {
  return (list || [])
    .filter(Boolean)
    .map((p) => ({ p, s: get(p) }))
    .sort((a, b) => {
      const rank = (x) => (!x.s ? 1 : x.s.kind === 'tunnel' ? 0 : x.s.kind === 'gated' ? 2 : 3);
      return rank(a) - rank(b);
    })
    .map((x) => x.p);
}

function isTunnel(proxy) {
  const s = get(proxy);
  return !!s && s.kind === 'tunnel';
}

function isDead(proxy) {
  const s = get(proxy);
  return !!s && s.kind === 'dead';
}

function snapshot() {
  const out = {};
  for (const [k, v] of states.entries()) out[k] = { kind: v.kind, age_ms: Date.now() - v.at };
  return out;
}

function reset() {
  states.clear();
}

module.exports = {
  note,
  get,
  canUse,
  isTunnel,
  isDead,
  sortByReliability,
  snapshot,
  reset,
  identity,
  TTL_OK,
  TTL_BAD,
};
