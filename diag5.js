'use strict';

const { newSearchContext } = require('./api/lib/browser');

(async () => {
  const engine = process.argv[2] || 'brave';
  const base = {
    brave: 'https://search.brave.com/search?q=hello+world&source=web',
    yahoo: 'https://search.yahoo.com/search?p=hello+world&n=10',
  }[engine];
  const context = await newSearchContext({ proxy: '' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    const info = await page.evaluate(() => {
      const out = [];
      const anchors = Array.from(document.querySelectorAll('a[href^="http"]'));
      const seen = new Set();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (seen.has(href)) continue;
        const txt = (a.textContent || '').trim();
        if (txt.length < 8) continue;
        seen.add(href);
        let anc = a;
        const classes = [];
        for (let i = 0; i < 5 && anc; i++) {
          if (anc.className && typeof anc.className === 'string') classes.push(String(anc.className).slice(0, 60));
          anc = anc.parentElement;
        }
        out.push({ txt: txt.slice(0, 50), href: href.slice(0, 60), classes: classes.join(' | ') });
        if (out.length >= 4) break;
      }
      return out;
    });
    console.log('engine:', engine);
    info.forEach((r) => console.log(JSON.stringify(r)));
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
