// node fullpage.js out.png [query] : scrolls through the page so every card mounts, then captures the full page
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
(async () => {
  const [out, q = ''] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto('file:///workspace/ensemble-animations/round2/index.html' + q);
  const H = await p.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < H; y += 450) { await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(250); }
  await p.waitForTimeout(9000);
  await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({ path: out, fullPage: true });
  console.log('height', H, errs.length ? errs.join('\n') : 'no console errors');
  await b.close();
})();
