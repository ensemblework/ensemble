import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectRoutes, sortedRoutes, type InventoryRoute } from "../src/lib/route-inventory.js";
import { routeCoverage } from "../src/test/route-coverage.js";
import { corsPolicy } from "../src/lib/cors-origin.js";

process.env.DATABASE_URL ??= "postgresql://inventory:inventory@127.0.0.1:1/ensemble_inventory_test";
process.env.REDIS_URL = "memory://inventory";
process.env.ENSEMBLE_DEV_AUTH_BYPASS = "false";
const originalDesktop = process.env.ENSEMBLE_DESKTOP;
const routes: InventoryRoute[] = [];
const { buildApp } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");
const { redis } = await import("../src/lib/redis.js");
try {
  for (const mode of ["hosted", "desktop"] as const) {
    process.env.ENSEMBLE_DESKTOP = mode === "desktop" ? "1" : "0";
    const app = await buildApp({ logger: false, onRoute: collectRoutes(mode, routes), corsPolicy: corsPolicy("http://localhost:3000", mode === "desktop") });
    await app.ready();
    await app.close();
  }
  if (routes.length > 1500) throw new Error(`Unexpectedly large route inventory: ${routes.length}; review the bound before increasing it.`);
  const inventory = sortedRoutes(routes);
  const routeKeys = new Set(inventory.map((route) => `${route.method} ${route.path}`));
  const stale = Object.keys(routeCoverage).filter((key) => !routeKeys.has(key));
  if (stale.length) throw new Error(`Coverage manifest refers to absent routes: ${stale.join(", ")}`);
  const text = `[\n${inventory.map((route) => `  ${JSON.stringify(route)}`).join(",\n")}\n]\n`;
  const output = fileURLToPath(new URL("./route-inventory.json", import.meta.url));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) {
      throw new Error("Route inventory is stale. Run route-inventory.ts, review added routes and their missing resource tests, then check in the generated JSON.");
    }
  } else {
    writeFileSync(output, text);
  }
  const endpoints = inventory.filter((route) => route.mode === "hosted" && !["HEAD", "OPTIONS"].includes(route.method));
  const missing = endpoints.filter((route) => !route.hasTest);
  console.log(`${inventory.length} method/path/mode entries; ${endpoints.length} hosted endpoints; ${endpoints.length - missing.length} have explicit resource regressions; ${missing.length} still lack them.`);
  if (missing.length) console.warn("WARNING: hasTest means explicit resource regression coverage, not merely a generic auth gate or a similarly named test file. Missing coverage is warning-only.");
  if (process.argv.includes("--strict") && missing.length) throw new Error(`${missing.length} hosted endpoints need resource regression contracts.`);
} finally {
  if (originalDesktop === undefined) delete process.env.ENSEMBLE_DESKTOP;
  else process.env.ENSEMBLE_DESKTOP = originalDesktop;
  await prisma.$disconnect();
  await redis.quit();
}
