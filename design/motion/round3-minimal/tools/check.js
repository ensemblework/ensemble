// node tools/check.js [base-url] : scrolls every card in dark / light / reduced and exercises the suite switcher; reports console errors
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
const BASE = process.argv[2] || 'file:///workspace/ensemble-animations/round3-minimal/index.html';
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  let total = 0;
  for (const q of ['', '?light', '?reduced', '?reduced&light']) {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); const errs = [];
    p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text())); p.on('pageerror', (e) => errs.push(e.message));
    p.on('requestfailed', (r) => errs.push('FAILED ' + r.url()));
    await p.goto(BASE + q); await p.waitForTimeout(500);
    const n = await p.evaluate(async () => { const cs = [...document.querySelectorAll('.card')]; for (const c of cs) { c.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 450)); } return cs.filter((c) => c.__mounted).length; });
    for (const id of ['thinking', 'approve', 'tray', 'splash']) { await p.evaluate((i) => window.__pickSlot(i), id); await p.waitForTimeout(1200); }
    await p.click('#g-replay'); await p.click('.seg button[data-show="dot"]'); await p.waitForTimeout(800);
    console.log((q || 'dark').padEnd(16), 'mounted', n, errs.length ? errs : 'no errors'); total += errs.length; await p.close();
  }
  await b.close(); process.exit(total ? 1 : 0);
})();
