'use strict';

const CAPTCHA_URL =
  /\/sorry\b|\/recaptcha\b|\/challenge\b|showcaptcha|turnstile|cf-challenge|challenges\.cloudflare|hcaptcha/i;
const CAPTCHA_HTML =
  /id="captcha"|g-recaptcha|h-captcha|cf-turnstile|smartcaptcha|altcha|challenges\.cloudflare\.com\/turnstile|cf-chl-|unusual.?traffic|verify you are human|prove you are human|i['’]?m not a robot|just a moment\.\.\.|attention required/i;

function kind(blob) {
  const s = String(blob || '').toLowerCase();
  if (/turnstile|cf-chl|challenges\.cloudflare/.test(s)) return 'turnstile';
  if (/recaptcha|g-recaptcha/.test(s)) return 'recaptcha';
  if (/h-captcha|hcaptcha/.test(s)) return 'hcaptcha';
  if (/sorry|unusual.?traffic/.test(s)) return 'sorry';
  if (/altcha|smartcaptcha/.test(s)) return 'captcha';
  return 'captcha';
}

function hasOrganicHits(html) {
  const h = String(html || '');
  return /<h3[\s>]/i.test(h) || /<cite[\s>]/i.test(h) || /results-standard/i.test(h);
}

function detectChallenge({ url, html, title } = {}) {
  const u = String(url || '');
  const h = String(html || '');
  const t = String(title || '');
  const blob = `${u}\n${t}\n${h}`;
  if (CAPTCHA_URL.test(u) || /^captcha$/i.test(t) || /turnstile/i.test(t)) {
    return { type: kind(blob), code: 'BLOCKED' };
  }
  if (hasOrganicHits(h)) return null;
  if (CAPTCHA_HTML.test(blob)) {
    return { type: kind(blob), code: 'BLOCKED' };
  }
  return null;
}

function blockedError(challenge, engine) {
  const type = (challenge && challenge.type) || 'captcha';
  const e = new Error(`Engine "${engine || 'search'}" blocked: ${type}`);
  e.code = 'BLOCKED';
  e.challenge = type;
  return e;
}

function routeToSolver(challenge) {
  return {
    routed: false,
    solver: null,
    challenge: challenge && challenge.type,
    reason: 'solvers_disabled',
  };
}

function rotateOnChallenge(err) {
  const code = err && err.code;
  return code === 'BLOCKED' || code === 'SORRY';
}

module.exports = { detectChallenge, blockedError, routeToSolver, rotateOnChallenge, hasOrganicHits, CAPTCHA_URL, CAPTCHA_HTML };
