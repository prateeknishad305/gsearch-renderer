'use strict';

const { newSearchContext } = require('./api/lib/browser');

(async () => {
  const engine = process.argv[2] || 'yahoo';
  const base = {
    yahoo: 'https://search.yahoo.com/search?p=hello+world&n=10',
    brave: 'https://search.brave.com/search?q=hello+world&source=web',
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
      const anchors = Array.from(document.querySelectorAll('a[href^="http"]')).filter((a) => {
        const h = a.getAttribute('href') || '';
        return !/^https?:\/\/(www\.)?(search\.)?yahoo\.com/.test(h);
      });
      const seen = new Set();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (seen.has(href)) continue;
        const txt = (a.textContent || '').trim();
        if (txt.length < 8) continue;
        seen.add(href);
        let el = a;
        const path = [];
        for (let i = 0; i < 6 && el; i++) {
          const cls = el.className && typeof el.className === 'string' ? String(el.className).split(/\s+/)[0] : el.tagName.toLowerCase();
          const tag = el.tagName.toLowerCase();
          path.push(`${tag}.${cls}`);
          el = el.parentElement;
        }
        out.push({ txt: txt.slice(0, 45), href: href.slice(0, 70), path: path.join(' < ') });
        if (out.length >= 5) break;
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
