// node shot.js <cardId|page> <ms,ms,...> [light] [reduced]  -> /tmp/r2/<id>-<ms>.png ; prints console errors
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
(async () => {
  const [id = 'page', times = '1500', ...flags] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: flags.includes('hd') ? 2 : 1 });
  const errs = [];
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.type() + ': ' + m.text()));
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  const q = [flags.includes('reduced') ? 'reduced' : '', flags.includes('light') ? 'light' : ''].filter(Boolean).join('&');
  await p.goto('file:///workspace/ensemble-animations/round2/index.html' + (q ? '?' + q : ''));
  require('fs').mkdirSync('/tmp/r2', { recursive: true });
  let el = null;
  if (id !== 'page') {
    el = await p.$('#p-' + id);
    await el.scrollIntoViewIfNeeded();
    await p.evaluate((i) => document.getElementById('p-' + i).__mount(), id);
  }
  let t0 = 0;
  for (const t of times.split(',').map(Number)) {
    await p.waitForTimeout(t - t0); t0 = t;
    const path = `/tmp/r2/${id}-${t}.png`;
    if (el) await el.screenshot({ path }); else await p.screenshot({ path, fullPage: flags.includes('full') });
  }
  console.log(errs.length ? errs.join('\n') : 'no console errors');
  await b.close();
})();
