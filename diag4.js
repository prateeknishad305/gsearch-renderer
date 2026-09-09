'use strict';

const { newSearchContext } = require('./api/lib/browser');

(async () => {
  const engine = process.argv[2] || 'duckduckgo';
  const base = {
    duckduckgo: 'https://html.duckduckgo.com/html/?q=hello+world',
    duckduckgo_lite: 'https://lite.duckduckgo.com/lite/?q=hello+world',
    brave: 'https://search.brave.com/search?q=hello+world&source=web',
    startpage: 'https://www.startpage.com/sp/search?query=hello+world',
    mojeek: 'https://www.mojeek.com/search?q=hello+world',
    yahoo: 'https://search.yahoo.com/search?p=hello+world&n=10',
    qwant: 'https://www.qwant.com/?q=hello+world&safesearch=0',
  }[engine];
  const context = await newSearchContext({ proxy: '' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
    await page.waitForTimeout(4000);
    console.log('engine:', engine, '| url:', page.url());
    console.log('title:', JSON.stringify((await page.title()).slice(0, 120)));
    const t = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    console.log('body text (first 500):', JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 500)));
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
