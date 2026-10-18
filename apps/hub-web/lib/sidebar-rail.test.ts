/**
 * The sidebar toggles only show when they can do something. Auto-collapse and a Pages panel docked on
 * the left keep the sidebar a rail, so the top bar's toggle (on a computer) and the rail's Expand
 * button are hidden then, by CSS keyed on the attributes the boot script and the shell set.
 */
import "../components/ui-test-dom.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sidebarRailForced } from "./sidebar-rail";

const root = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(root, "app/globals.css"), "utf8");

test("auto-collapse or a left Pages panel forces the rail; a rail you chose does not", () => {
  const html = document.createElement("html");
  assert.equal(sidebarRailForced(html), false);
  html.dataset.sidebar = "rail";
  assert.equal(sidebarRailForced(html), false, "the toggle can expand a rail you chose");
  html.dataset.sidebarAuto = "true";
  assert.equal(sidebarRailForced(html), true);
  html.dataset.sidebarAuto = "false";
  html.dataset.pagesPanel = "right";
  assert.equal(sidebarRailForced(html), false);
  html.dataset.pagesPanel = "left";
  assert.equal(sidebarRailForced(html), true);
});

test("the top bar toggle hides on a computer when the rail is forced, and stays on phones for the drawer", () => {
  const block = css.match(/@media \(min-width: 768px\) \{\s*([^{}]*\.topbar-sidebar-toggle[^{}]*)\{\s*display: none;\s*\}\s*\}/);
  assert.ok(block, "a min-width: 768px rule hides .topbar-sidebar-toggle");
  assert.match(block[1], /\[data-sidebar-auto="true"\]/);
  assert.match(block[1], /\[data-pages-panel="left"\]/);
  const topbar = readFileSync(join(root, "components/shell/topbar.tsx"), "utf8");
  assert.match(topbar, /className="topbar-sidebar-toggle[^"]*"[^>]*aria-label="Toggle sidebar"/);
});

test("the rail's Expand button shows only for a rail you chose", () => {
  const shown = css.split("\n").filter((line) => /\.sidebar-expand \{ display: flex; \}/.test(line));
  assert.equal(shown.length, 1);
  assert.match(shown[0]!, /^html\[data-sidebar="rail"\]:not\(\[data-sidebar-auto="true"\], \[data-pages-panel="left"\]\)/);
});
