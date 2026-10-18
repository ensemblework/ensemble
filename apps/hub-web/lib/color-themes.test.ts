import "../components/ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceSettings } from "@ensemble/shared-types";
import { COLOR_THEMES, COLOR_THEME_STYLES, colorTheme, colorThemeTokens } from "./color-themes";
import { ACCENT_PRESETS, APPEARANCE_BOOT, resolveAccent } from "./accent";
import { completeAppearance, DEFAULT_APPEARANCE, applyAppearance } from "./prefs";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function contrast(a: string, b: string) {
  const luminance = (hex: string) => rgb(hex).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (x! + .05) / (y! + .05);
}
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

test("the Ensemble palettes have coordinated modes, readable surfaces, and no accent overrides", () => {
  assert.equal(COLOR_THEMES.length, 7);
  for (const theme of COLOR_THEMES) for (const mode of ["dark", "light"] as const) {
    const p = theme[mode];
    for (const surface of [p.bg, p.sidebar, p.panel, p.raised, p.tile]) for (const text of [p.ink, p.muted, p.faint]) assert.ok(contrast(text, surface) >= 4.5, `${theme.id} ${mode}: ${text} on ${surface}`);
    assert.ok(COLOR_THEME_STYLES.includes(`data-color-theme="${theme.id}"`));
  }
  assert.doesNotMatch(COLOR_THEME_STYLES, /--accent:|--accent-rgb:|--font-app:|animation|transition/);
});

test("presets and extreme custom accents remain readable in every new palette", () => {
  for (const theme of COLOR_THEMES.filter((theme) => theme.id !== "ensemble")) for (const mode of ["dark", "light"] as const) {
    const p = theme[mode]; const surfaces = [p.bg, p.sidebar, p.panel, p.raised, p.tile];
    for (const hex of [...ACCENT_PRESETS.map((accent) => accent[mode]), "#ffffff", "#000000", "#ffff00", "#ff00ff", "#123456", "#808080"]) {
      const resolved = resolveAccent(hex, mode, surfaces);
      for (const surface of surfaces) assert.ok(contrast(resolved.hex, surface) >= 4.5, `${theme.id} ${mode}: ${hex} resolved to ${resolved.hex} on ${surface}`);
      assert.ok(contrast(resolved.hex, resolved.fg) >= 4.5, "button text stays readable");
    }
  }
});

test("legacy preferences keep the Ensemble palette and malformed palettes fall back", () => {
  document.cookie = "ensemble_color_theme=; Max-Age=0; Path=/";
  assert.equal(AppearanceSettings.parse({}).colorTheme, "ensemble");
  assert.equal(completeAppearance({ theme: "light", accent: "rose" }).colorTheme, "ensemble");
  assert.equal(colorTheme("unknown").id, "ensemble");
  assert.equal(AppearanceSettings.safeParse({ colorTheme: "unknown" }).success, false);
});

test("boot and hydration honor a newer account palette cookie without changing the chosen mode", () => {
  const root = document.documentElement;
  const css = document.createElement("style"); css.textContent = COLOR_THEME_STYLES; document.head.append(css);
  const local = { ...DEFAULT_APPEARANCE, theme: "light" as const, colorTheme: "graphite" as const, accentAt: 5 };
  window.localStorage.setItem("ensemble.appearance", JSON.stringify(local));
  document.cookie = "ensemble_color_theme=lagoon%4010; Path=/";
  const run = new Function("localStorage", "document", "matchMedia", "getComputedStyle", "__name", APPEARANCE_BOOT);
  run(window.localStorage, document, window.matchMedia, window.getComputedStyle.bind(window), (fn: unknown) => fn);
  assert.equal(root.dataset.colorTheme, "lagoon");
  assert.equal(root.dataset.theme, "light");
  const hydrated = completeAppearance(local);
  assert.equal(hydrated.colorTheme, "lagoon");
  applyAppearance(hydrated);
  assert.equal(root.dataset.colorTheme, "lagoon");
  assert.equal(root.dataset.theme, "light");
  document.cookie = "ensemble_color_theme=; Max-Age=0; Path=/";
  css.remove(); window.localStorage.clear();
});

test("legacy motion choices normalize to Expressive without disabling accessibility", () => {
  for (const motion of ["minimal-quiet", "minimal-dot", "expressive"]) {
    const parsed = AppearanceSettings.parse({ motion, reduceMotion: true });
    assert.equal(parsed.motion, "expressive");
    assert.equal(parsed.reduceMotion, true);
    assert.equal(completeAppearance({ motion } as never).motion, "expressive");
  }
  assert.equal(AppearanceSettings.parse({}).accent, "gold");
});

/**
 * The canvas paints its image once, in a tile anchored to the top-right of the page (globals.css
 * `[data-theme-canvas]`). A tile's top and right sides are the page's own edges; its left and bottom
 * sides are in the middle of the page, so a gradient must fade out before it reaches them.
 */
test("no theme's background glow ends in a hard edge inside the page", () => {
  for (const theme of COLOR_THEMES) for (const mode of ["dark", "light"] as const) {
    const tokens = colorThemeTokens(theme, mode);
    const image = tokens["--theme-canvas-image"]!;
    const size = tokens["--theme-canvas-size"]!;
    const radials = [...image.matchAll(/radial-gradient\(ellipse at (\d+)% (\d+)%,.*?transparent (\d+)%\)/g)];
    assert.equal(radials.length, (image.match(/radial-gradient\(/g) ?? []).length, `${theme.id}: every gradient is one this test understands`);
    if (!radials.length || size === "100% 100%") continue;
    const tile = size.match(/^(\d+)px (\d+)px$/);
    assert.ok(tile, `${theme.id} ${mode}: a gradient in a fixed tile, ${size}`);
    const [width, height] = [Number(tile[1]), Number(tile[2])];
    for (const [, x, y, stop] of radials) {
      const cx = (Number(x) / 100) * width;
      const cy = (Number(y) / 100) * height;
      // An ellipse sized to the farthest corner, with the farthest sides' proportions, faded out at `stop`.
      const rx = Math.max(cx, width - cx) * Math.SQRT2 * (Number(stop) / 100);
      const ry = Math.max(cy, height - cy) * Math.SQRT2 * (Number(stop) / 100);
      assert.ok(cx - rx > 0, `${theme.id} ${mode}: a glow at ${x}% ${y}% reaches the tile's left side`);
      assert.ok(cy + ry < height, `${theme.id} ${mode}: a glow at ${x}% ${y}% reaches the tile's bottom side`);
    }
  }
  assert.ok(COLOR_THEMES.some((theme) => theme.colorful), "a theme with gradients exists");
});
