import "../components/ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceSettings } from "@ensemble/shared-types";
import { COLOR_THEMES, COLOR_THEME_STYLES, colorTheme } from "./color-themes";
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
