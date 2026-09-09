'use strict';

const { newSearchContext } = require('./api/lib/browser');
const { ENGINES, detectBlock } = require('./api/lib/engines');

(async () => {
  const engine = process.argv[2] || 'bing';
  const cfg = ENGINES[engine];
  const url = cfg.url({ q: 'hello world', num: 10, start: 0, hl: 'en', gl: 'us' });
  const context = await newSearchContext({ proxy: '' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e) => console.log('goto err', e.message.split('\n')[0]));
    await page.waitForSelector(cfg.ready, { timeout: 15000 }).catch((e) => console.log('ready timeout:', e.message.split('\n')[0]));
    await page.waitForTimeout(900);
    console.log('after ready wait, final url:', page.url());
    const block = await page.evaluate(detectBlock, engine).catch((e) => 'EVAL ERR ' + e.message.split('\n')[0]);
    console.log('block:', block);
    const results = await page.evaluate(cfg.parse).catch((e) => 'PARSE ERR ' + e.message.split('\n')[0]);
    console.log('parsed count:', Array.isArray(results) ? results.length : results);
    if (Array.isArray(results) && results[0]) console.log('first:', JSON.stringify(results[0]).slice(0, 200));
  } catch (e) {
    console.log('ERR:', e.message.split('\n')[0]);
  } finally {
    await context.close();
    process.exit(0);
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
