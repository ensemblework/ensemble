import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LAUNCHER_SPOT, LAUNCHER_SIZE, launcherPosition, normalizeSpot, snapLauncher } from "./ask-launcher";
import { greeting, starterPrompts } from "./assistant-dock";

const bounds = { width: 1000, height: 700, top: 44 };

test("the launcher stays inside the work area below the top bar", () => {
  const corner = launcherPosition(DEFAULT_LAUNCHER_SPOT, bounds);
  assert.deepEqual(corner, { x: 1000 - LAUNCHER_SIZE - 16, y: 700 - LAUNCHER_SIZE - 16 });
  const bottomLeft = launcherPosition({ edge: "bottom", t: 0 }, bounds);
  assert.equal(bottomLeft.x, 16);
  const rightTop = launcherPosition({ edge: "right", t: 0 }, bounds);
  assert.equal(rightTop.y, 44 + 16);
  assert.ok(rightTop.y > bounds.top, "never over the top bar");
});

test("a stored spot is a fraction, so it follows the window when it resizes", () => {
  const middle = { edge: "bottom" as const, t: 0.5 };
  const wide = launcherPosition(middle, bounds);
  const narrow = launcherPosition(middle, { ...bounds, width: 600 });
  assert.equal(wide.x, Math.round(16 + 0.5 * (1000 - LAUNCHER_SIZE - 32)));
  assert.equal(narrow.x, Math.round(16 + 0.5 * (600 - LAUNCHER_SIZE - 32)));
  assert.ok(narrow.x + LAUNCHER_SIZE <= 600 - 16);
});

test("dragging snaps to the nearest allowed edge and clamps at the corners", () => {
  assert.deepEqual(snapLauncher({ x: 300, y: 690 }, bounds).edge, "bottom");
  assert.deepEqual(snapLauncher({ x: 995, y: 300 }, bounds).edge, "right");
  assert.equal(snapLauncher({ x: -50, y: 690 }, bounds).t, 0);
  assert.equal(snapLauncher({ x: 995, y: -400 }, bounds).t, 0);
  assert.equal(snapLauncher({ x: 995, y: 4000 }, bounds).t, 1);
});

test("unknown stored values fall back to the bottom-right corner", () => {
  assert.deepEqual(normalizeSpot(null), DEFAULT_LAUNCHER_SPOT);
  assert.deepEqual(normalizeSpot({ edge: "top", t: 0.3 }), DEFAULT_LAUNCHER_SPOT);
  assert.deepEqual(normalizeSpot({ edge: "right", t: 7 }), { edge: "right", t: 1 });
});

test("the assistant greets by first name and never quotes a record title", () => {
  assert.equal(greeting("Mira Chen", new Date(2026, 9, 7, 9)), "Good morning, Mira");
  assert.equal(greeting("", new Date(2026, 9, 7, 20)), "Good evening");
  for (const path of ["/today", "/board", "/context", "/pages/x", "/needs-me"]) {
    const prompts = starterPrompts(path);
    assert.ok(prompts.length >= 2 && prompts.length <= 3);
    assert.ok(prompts.every((prompt) => !/untitled|grounded/i.test(prompt)));
  }
});
