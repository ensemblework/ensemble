/** Isolated local UI checks: HUB_API=… HUB_WEB=… THEME_SCREENSHOTS=… node apps/hub-web/e2e/color-themes.mjs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
const API = process.env.HUB_API ?? "http://127.0.0.1:4118";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3118";
for (const url of [API, WEB]) assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "These checks create fictional accounts; use local services.");
const shots = process.env.THEME_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const response = await fetch(`${API}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mira Chen", email: `themes-${Date.now()}@fieldnote.example`, password: "themes-check-123456" }) });
assert.ok(response.ok, await response.clone().text());
const session = /ensemble_session=([^;]+)/.exec(response.headers.get("set-cookie"))?.[1]; assert.ok(session);
async function api(path, method = "GET", body) {
  const r = await fetch(API + path, { method, headers: { cookie: `ensemble_session=${session}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`); return r.json();
}
await api('/api/onboarding', 'POST', { role: 'engineer', templateId: 'branch-desk' });
await api('/api/preferences/ui.onboarding-tour', 'PUT', { value: { v: 1, status: 'completed', step: 'finish', updatedAt: Date.now() } });
await api('/api/preferences/desk.sample', 'PUT', { value: true });
await api('/api/settings', 'PATCH', { appearance: { theme: 'dark', colorTheme: 'ensemble', accent: 'rose', accentCustom: null, motion: 'minimal-dot', reduceMotion: true } });
const chrome = process.env.CHROME_PATH ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addCookies([{ name: 'ensemble_session', value: session, url: WEB }]);
const page = await context.newPage(); const crashes = []; page.on('pageerror', (e) => crashes.push(e.message));
const themes = ['ensemble', 'graphite', 'lagoon', 'aurora', 'juniper', 'blueprint'];
async function settle() { await page.getByText('All settings saved', { exact: true }).waitFor({ timeout: 12000 }); }
async function palette(id, mode) { await page.waitForFunction(({ id, mode }) => document.documentElement.dataset.colorTheme === id && document.documentElement.dataset.theme === mode, { id, mode }); }
try {
  await page.goto(`${WEB}/settings?tab=account#appearance`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-color-theme-option="ensemble"]').waitFor();
  const before = (await api('/api/tasks')).tasks.length;
  const colors = new Set();
  const paints = [];
  for (const mode of ['light', 'dark']) {
    await page.getByRole('radio', { name: mode === 'light' ? 'Light' : 'Dark', exact: true }).click();
    for (const id of themes) {
      await page.evaluate(() => { window.__themePaint = null; document.addEventListener('click', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__themePaint = performance.now() - start; })); }, { once: true }); });
      await page.locator(`[data-color-theme-option="${id}"]`).click(); await palette(id, mode); await settle();
      await page.waitForFunction(() => window.__themePaint !== null);
      paints.push(await page.evaluate(() => window.__themePaint));
      const saved = (await api('/api/settings')).settings.appearance;
      assert.equal(saved.colorTheme, id); assert.equal(saved.accent, 'rose'); assert.equal(saved.accentCustom, null);
      const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
      colors.add(`${mode}:${bg}`);
      await page.goto(`${WEB}/today`, { waitUntil: 'domcontentloaded' }); await palette(id, mode);
      await page.locator('.desk .tile').first().waitFor();
      await page.getByText('#482 Cache invalidation', { exact: true }).first().waitFor();
      assert.ok(await page.locator('[data-theme-canvas]').evaluate((node) => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'));
      if (shots) await page.screenshot({ path: `${shots}/${id}-${mode}.png` });
      await page.goto(`${WEB}/settings?tab=account#appearance`, { waitUntil: 'domcontentloaded' });
      await page.locator(`[data-color-theme-option="${id}"][aria-checked="true"]`).waitFor();
    }
  }
  assert.equal(colors.size, 12, 'each theme has its own light and dark canvas');
  assert.ok(Math.max(...paints) <= 200, `theme paints exceed the 200 ms budget: ${paints.join(', ')}`);
  if (shots) await page.locator('.color-theme-section').screenshot({ path: `${shots}/picker-desktop.png` });
  await page.locator('[aria-label="Custom accent"]').fill('#ff00aa'); await settle();
  await page.locator('[data-color-theme-option="lagoon"]').click(); await settle();
  assert.equal((await api('/api/settings')).settings.appearance.accentCustom, '#ff00aa', 'theme changes preserve the custom accent');
  await page.reload({ waitUntil: 'domcontentloaded' }); await palette('lagoon', 'dark');
  await page.locator('[data-color-theme-option="lagoon"]').waitFor();
  await page.locator('[data-color-theme-option="lagoon"]').focus(); await page.keyboard.press('ArrowRight');
  await palette('aurora', 'dark'); await settle();
  assert.equal(await page.locator('[data-color-theme-option="aurora"]').evaluate((node) => node === document.activeElement), true);
  await page.getByRole('radio', { name: 'System', exact: true }).click(); await settle();
  await page.emulateMedia({ colorScheme: 'light' }); await palette('aurora', 'light');
  await page.getByRole('button', { name: 'Account menu for Mira Chen' }).click();
  await page.getByRole('menuitem', { name: 'Dark theme', exact: true }).click(); await palette('aurora', 'dark');
  await page.getByRole('radio', { name: 'System', exact: true }).click(); await settle(); await palette('aurora', 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); await palette('aurora', 'dark');
  const second = await context.newPage(); await second.goto(`${WEB}/today`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-color-theme-option="juniper"]').click(); await settle();
  await second.waitForFunction(() => document.documentElement.dataset.colorTheme === 'juniper'); await second.close();
  for (const url of ['/board', '/context?tab=graph', '/files', '/needs-me']) { await page.goto(WEB + url, { waitUntil: 'domcontentloaded' }); await palette('juniper', 'dark'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${WEB}/settings?tab=account#appearance`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-color-theme-option="juniper"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/picker-mobile.png` });
  await page.getByRole('button', { name: 'Reset appearance' }).click(); await settle(); await palette('ensemble', 'dark');
  assert.equal((await api('/api/tasks')).tasks.length, before, 'themes never write work data');
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await api('/api/settings', 'PATCH', { appearance: { colorTheme: 'blueprint' } });
  await fresh.addCookies([{ name: 'ensemble_session', value: session, url: WEB }]);
  const cold = await fresh.newPage();
  await cold.addInitScript(() => { window.__palettePaints = []; new MutationObserver(() => { const root = document.documentElement; if (root?.dataset.colorTheme) window.__palettePaints.push(root.dataset.colorTheme); }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-color-theme'] }); });
  await cold.goto(`${WEB}/today`, { waitUntil: 'domcontentloaded' });
  await cold.waitForFunction(() => document.documentElement.dataset.colorTheme === 'blueprint');
  assert.equal(await cold.evaluate(() => window.__palettePaints[0]), 'blueprint', 'account palette is painted before hydration on a fresh browser');
  for (const name of ['lagoon', 'juniper', 'blueprint']) { const asset = await fetch(`${WEB}/themes/${name}.svg`); assert.equal(asset.status, 200); assert.match(await asset.text(), /<svg/); }
  assert.deepEqual(crashes, []); await fresh.close();
  console.log(`All 12 theme/mode combinations: picker, persistence, independent preset/custom accent, system, account-menu switch, keyboard, cross-tab, fresh-browser first paint, core routes and mobile passed. Maximum two-frame theme paint: ${Math.max(...paints).toFixed(1)} ms.`);
} finally { await context.close(); await browser.close(); }
