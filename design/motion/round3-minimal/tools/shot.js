// node tools/shot.js <cardId|page|suite> <ms,...> [light] [reduced] [hd] [full] -> /tmp/r3/<id>-<ms>[-flag].png ; prints console errors
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
(async () => {
  const [id = 'page', times = '1500', ...flags] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: flags.includes('hd') ? 2 : 1 });
  const errs = [];
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.type() + ': ' + m.text()));
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  const q = ['reduced', 'light'].filter((f) => flags.includes(f)).join('&');
  await p.goto('file:///workspace/ensemble-animations/round3-minimal/index.html' + (q ? '?' + q : ''));
  require('fs').mkdirSync('/tmp/r3', { recursive: true });
  let el = null;
  if (id === 'suite') { el = await p.$('#s-suite'); await el.scrollIntoViewIfNeeded(); }
  else if (id !== 'page') { el = await p.$('#p-' + id); await el.scrollIntoViewIfNeeded(); await p.evaluate((i) => document.getElementById('p-' + i).__mount(), id); }
  const tag = flags.filter((f) => f !== 'hd').map((f) => '-' + f).join('');
  let t0 = 0;
  for (const t of times.split(',').map(Number)) {
    await p.waitForTimeout(t - t0); t0 = t;
    const path = `/tmp/r3/${id}-${t}${tag}.png`;
    if (el) await el.screenshot({ path }); else await p.screenshot({ path, fullPage: flags.includes('full') });
  }
  console.log(errs.length ? errs.join('\n') : 'no console errors');
  await b.close();
})();
