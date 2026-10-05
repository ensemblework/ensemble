import { chromium } from 'playwright-core';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
console.log('url', p.url());
const email = p.locator('input[type=email], input[name=email]').first();
await email.fill(process.env.ENSEMBLE_EMAIL ?? '');
await p.locator('input[type=password]').first().fill(process.env.ENSEMBLE_PASSWORD ?? '');
await Promise.all([p.waitForURL(u => !String(u).includes('/login'), { timeout: 20000 }).catch(()=>{}), p.keyboard.press('Enter')]);
await p.waitForTimeout(2500);
for (const path of ['/today', '/context', '/templates']) {
  await p.goto('http://localhost:3000' + path, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2000);
  await p.screenshot({ path: `ref/live${path.replace(/\//g,'-')}.png` });
  console.log(path, p.url());
}
await b.close();
