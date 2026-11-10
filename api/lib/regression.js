'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

function run({ timeoutMs = 120000 } = {}) {
  const root = path.join(__dirname, '..', '..');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'test/*.test.js'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('close', (code) => {
      clearTimeout(t);
      const pass = /# fail 0/.test(out) || code === 0;
      resolve({ ok: pass, code, output: out.slice(-4000) });
    });
  });
}

module.exports = { run };
