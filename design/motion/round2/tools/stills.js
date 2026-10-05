const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
const M = '/workspace/ensemble-animations/round2/media/';
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto('file:///workspace/ensemble-animations/round2/index.html');
  // 1 · overview: hero + Celebrate row
  await p.evaluate(() => { const r = document.getElementById('p-confetti').getBoundingClientRect(); scrollTo(0, r.top + scrollY - 420); });
  await p.evaluate(() => ['p-brandloop', 'p-confetti', 'p-tapestry', 'p-streak'].forEach((id) => document.getElementById(id).__mount()));
  await p.waitForTimeout(6400);
  await p.screenshot({ path: M + 'still-1-overview.png' });
  const card = async (id, ms, name) => {
    const el = await p.$('#p-' + id); await el.scrollIntoViewIfNeeded();
    await p.evaluate((i) => document.getElementById('p-' + i).__mount(), id);
    await p.waitForTimeout(ms); await el.screenshot({ path: M + name });
  };
  await card('voice', 5600, 'still-2-voice-in-ensemble.png');
  await card('board', 7150, 'still-3-board-handoff.png');
  console.log(errs.length ? errs : 'no errors');
  await b.close();
})();
