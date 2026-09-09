'use strict';

const { renderSearch } = require('./api/search');

(async () => {
  const engine = process.argv[2] || 'bing';
  const t0 = Date.now();
  try {
    const { results, duration_ms } = await renderSearch({
      engine,
      query: 'hello world',
      num: 10,
      start: 0,
      hl: 'en',
      gl: 'us',
    });
    console.log(`${engine}: OK results=${results.length} renderMs=${duration_ms} totalMs=${Date.now() - t0}`);
    results.slice(0, 3).forEach((r) => console.log('  -', r.url, '|', (r.title || '').slice(0, 60)));
  } catch (e) {
    console.log(`${engine}: FAIL code=${e.code} msg=${(e.message || '').slice(0, 200)} totalMs=${Date.now() - t0}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
