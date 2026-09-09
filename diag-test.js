'use strict';

const { newSearchContext } = require('./api/lib/browser');
const { ENGINES } = require('./api/lib/engines');

(async () => {
  const engine = 'mojeek';
  const cfg = ENGINES[engine];
  const url = cfg.url({ q: 'hello world', num: 10, start: 0, hl: 'en', gl: 'us' });
  console.log('url:', url);
  const context = await newSearchContext({ proxy: '' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('final url:', page.url());
    console.log('title:', await page.title());
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 400));
    console.log('body text start:', JSON.stringify(text));
    const hasLi = await page.evaluate(() => document.querySelectorAll('ul.results-standard li').length);
    const anchors = await page.evaluate(() => document.querySelectorAll('a[href]').length);
    console.log('ul.results-standard li count:', hasLi, ' total anchors:', anchors);
  } catch (e) {
    console.log('NAV ERROR:', e.message.split('\n')[0]);
  } finally {
    await context.close();
    process.exit(0);
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
