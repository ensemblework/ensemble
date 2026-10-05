import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { BRAND_PAGE_BOOT } from "./brand-page-boot";
import { publicSiteUrl } from "./site-url";

const ROOT = join(import.meta.dirname, "../../..");
const TEXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".svg", ".py", ".html", ".md", ".json"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (TEXT.has(path.slice(path.lastIndexOf("."))) && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

function pngHeader(path: string) {
  const buf = readFileSync(path);
  assert.equal(buf.toString("ascii", 12, 16), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test("the old mark and the login constellation stay gone", () => {
  const roots = [join(ROOT, "apps"), join(ROOT, "design/icons")];
  const banned = [/function Constellation\b/, /M36 310C80 250/, /C7\.4 17/];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of banned) {
        if (pattern.test(text)) hits.push(`${relative(ROOT, file)} ${pattern}`);
      }
    }
  }
  assert.deepEqual(hits, []);
  const ensemble = readFileSync(join(ROOT, "design/icons/ui-icons/svg/ensemble.svg"), "utf8");
  assert.match(ensemble, /M3 2H6V13/);
  const slot = readFileSync(join(ROOT, "apps/hub-web/components/motion/slot.tsx"), "utf8");
  assert.doesNotMatch(slot, /296 280 432 476/);
});

test("error pages read the real appearance store", () => {
  for (const name of ["404.html", "500.html", "offline.html"]) {
    const html = readFileSync(join(ROOT, "apps/hub-web/public", name), "utf8");
    assert.match(html, /localStorage\.getItem\('ensemble\.appearance'\)/);
    assert.doesNotMatch(html, /ensemble:motion-theme/);
  }
  assert.match(BRAND_PAGE_BOOT, /ensemble\.appearance/);
  assert.doesNotMatch(BRAND_PAGE_BOOT, /ensemble:motion-theme/);
});

test("metadataBase comes from the public site url and is never invented", () => {
  const layout = readFileSync(join(ROOT, "apps/hub-web/app/layout.tsx"), "utf8");
  assert.match(layout, /publicSiteUrl\(\)/);
  assert.doesNotMatch(layout, /localhost:3000/);
  assert.equal(publicSiteUrl(undefined), undefined);
  assert.equal(publicSiteUrl(""), undefined);
  assert.equal(publicSiteUrl("not a url"), undefined);
  assert.equal(publicSiteUrl("ftp://ensemble.example"), undefined);
  assert.equal(publicSiteUrl("https://ensemble.duckdns.org")?.origin, "https://ensemble.duckdns.org");
});

test("the apple icon is an opaque 180px tile and quiet celebration uses the brand pair", () => {
  const apple = pngHeader(join(ROOT, "apps/hub-web/app/apple-icon.png"));
  assert.deepEqual(apple, { width: 180, height: 180, colorType: 2 });
  const css = readFileSync(join(ROOT, "apps/hub-web/components/motion/suite.css"), "utf8");
  assert.match(css, /\.m-ce-u path \{[^}]*stroke: var\(--brand-agent/);
  assert.match(css, /\.m-ce-u path\.a \{ stroke: var\(--brand-you/);
});
