'use strict';

const { newSearchContext } = require('./api/lib/browser');

(async () => {
  const engine = process.argv[2] || 'bing';
  const base = {
    bing: 'https://www.bing.com/search?q=hello+world&count=10',
    google: 'https://www.google.com/search?q=hello+world&num=10',
    duckduckgo: 'https://html.duckduckgo.com/html/?q=hello+world',
    brave: 'https://search.brave.com/search?q=hello+world&source=web',
    startpage: 'https://www.startpage.com/sp/search?query=hello+world',
    yahoo: 'https://search.yahoo.com/search?p=hello+world&n=10',
    qwant: 'https://www.qwant.com/?q=hello+world&safesearch=0',
    mojeek: 'https://www.mojeek.com/search?q=hello+world',
    duckduckgo_lite: 'https://lite.duckduckgo.com/lite/?q=hello+world',
  }[engine];

  const context = await newSearchContext({ proxy: '' });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.setDefaultNavigationTimeout(18000);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await page.waitForTimeout(2500);
    console.log('engine:', engine, '| final url:', page.url());
    console.log('title:', (await page.title()).slice(0, 80));
    const info = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const first = (s) => {
        const el = document.querySelector(s);
        return el ? (el.textContent || '').trim().slice(0, 80) : '';
      };
      return {
        h2a: q('h2 a'),
        b_algo: q('li.b_algo'),
        h3: q('h3'),
        snippet: q('.snippet'),
        result: q('.result'),
        resultLink: q('a.result-link'),
        algo: q('div.algo, li.algo'),
        resultsStandard: q('ul.results-standard li'),
        wgl: q('.w-gl__result'),
        firstH2: first('h2 a'),
        firstH3: first('h3'),
        firstResultA: first('a.result__a'),
      };
    });
    console.log('selector counts:', JSON.stringify(info));
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
