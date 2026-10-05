// node record.js highlights|full  -> ../media/<name>.webm  (then convert with ffmpeg)
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
const fs = require('fs');
(async () => {
  const mode = process.argv[2] || 'highlights';
  const dir = '/tmp/r2vid-' + mode; fs.rmSync(dir, { recursive: true, force: true });
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--disable-gpu-vsync'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file:///workspace/ensemble-animations/round2/index.html?tour=' + mode);
  await p.waitForFunction(() => window.__tourDone === true, null, { timeout: 200000, polling: 250 });
  await p.waitForTimeout(400);
  const v = p.video();
  await ctx.close();
  const src = await v.path();
  const out = `/workspace/ensemble-animations/round2/media/ensemble-motion-round2-${mode === 'full' ? 'full-walkthrough' : 'tour'}.webm`;
  fs.copyFileSync(src, out);
  console.log(out, errs.length ? errs : 'no errors');
  await b.close();
})();
