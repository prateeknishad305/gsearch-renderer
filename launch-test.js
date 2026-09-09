'use strict';

const { chromium } = require('playwright-core');
const chromiumBin = require('@sparticuz/chromium');

(async () => {
  const exe = await chromiumBin.executablePath();
  console.log('executablePath:', exe);
  const browser = await chromium.launch({
    args: chromiumBin.args,
    executablePath: exe,
    headless: true,
  });
  console.log('LAUNCH OK, version:', await browser.version());
  await browser.close();
})().catch((e) => {
  console.error('LAUNCH FAILED:', e.message.split('\n')[0]);
  process.exit(1);
});
