// Render every mockup to PNG. Usage: node render.mjs [filter]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const filter = process.argv[2];
const PORT = 5191;
const shots = (await import("./shots.mjs")).default;
mkdirSync("out", { recursive: true });
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1800));
const browser = await chromium.launch();
try {
  for (const s of shots.filter((s) => !filter || s.name.includes(filter))) {
    const width = s.w ?? 1440, height = s.h ?? (width < 500 ? 844 : 900);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: s.dpr ?? 1 });
    await page.goto(`http://localhost:${PORT}/?${s.q}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    if (s.fold !== false) await page.screenshot({ path: `out/${s.name}.png` });
    if (s.full) {
      const full = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width, height: full });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `out/${s.name}-full.png` });
    }
    console.log("✓", s.name);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
