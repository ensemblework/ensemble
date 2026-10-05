// node tools/record.js -> media/ensemble-motion-round3-minimal-tour.webm (then ffmpeg -> mp4)
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
const fs = require('fs');
(async () => {
  const dir = '/tmp/r3vid'; fs.rmSync(dir, { recursive: true, force: true });
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const p = await ctx.newPage(); const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text())); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file:///workspace/ensemble-animations/round3-minimal/index.html?tour=highlights');
  await p.waitForFunction(() => window.__tourDone === true, null, { timeout: 200000, polling: 250 });
  await p.waitForTimeout(300);
  const v = p.video(); await ctx.close();
  const out = '/workspace/ensemble-animations/round3-minimal/media/ensemble-motion-round3-minimal-tour.webm';
  fs.copyFileSync(await v.path(), out); console.log(out, errs.length ? errs : 'no errors'); await b.close();
})();
