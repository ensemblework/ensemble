import type { AccentPreset, AppearanceSettings } from "@ensemble/shared-types";

export const ACCENT_PRESETS: Array<{ id: AccentPreset; label: string; dark: string; light: string }> = [
  { id: "indigo", label: "Indigo", dark: "#7c6af7", light: "#5346d6" },
  { id: "tide", label: "Tide", dark: "#5dcec6", light: "#0f766e" },
  { id: "ember", label: "Ember", dark: "#f0a36a", light: "#c2410c" },
  { id: "rose", label: "Rose", dark: "#f0a0b8", light: "#be185d" },
  { id: "brass", label: "Brass", dark: "#e4c56e", light: "#92600c" },
  { id: "orchid", label: "Orchid", dark: "#cf9cf2", light: "#7c3aad" },
  { id: "moss", label: "Moss", dark: "#a9cc7e", light: "#3f6b24" },
  { id: "sky", label: "Sky", dark: "#82b3f5", light: "#1d4f91" },
];

export type ResolvedAccent = { hex: string; rgb: string; fg: string; hover: string; soft: string; wash: string };

/**
 * Fill, foreground, hover, soft, and wash for one accent.
 * Helpers live inside so the boot script can inline this function alone.
 */
export function resolveAccent(hex: string, theme: "light" | "dark"): ResolvedAccent {
  type RGB = [number, number, number];
  const INK: RGB = [20, 18, 15];
  const WHITE: RGB = [255, 255, 255];
  const canvas: RGB = theme === "light" ? [246, 241, 232] : [20, 18, 16];
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const parse = (value: string): RGB => {
    const n = parseInt(value.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const hexOf = (rgb: RGB) => `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb: RGB) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const contrast = (a: RGB, b: RGB) => {
    const hi = Math.max(lum(a), lum(b));
    const lo = Math.min(lum(a), lum(b));
    return (hi + 0.05) / (lo + 0.05);
  };
  const toHsl = (rgb: RGB): [number, number, number] => {
    const r = rgb[0] / 255;
    const g = rgb[1] / 255;
    const b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s * 100, l * 100];
  };
  const fromHsl = (h: number, s: number, l: number): RGB => {
    const H = h / 360;
    const S = s / 100;
    const L = l / 100;
    if (S === 0) {
      const v = Math.round(L * 255);
      return [v, v, v];
    }
    const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
    const p = 2 * L - q;
    const hue = (t: number) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [hue(H + 1 / 3), hue(H), hue(H - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
  };
  let rgb = parse(hex);
  let hsl = toHsl(rgb);
  if (contrast(rgb, canvas) < 4.5) {
    const dir = theme === "dark" ? 1 : -1;
    for (let i = 1; i <= 28; i += 1) {
      const sample = fromHsl(hsl[0], Math.min(hsl[1], 78), clamp(hsl[2] + dir * i * 2.5, 14, 86));
      if (contrast(sample, canvas) >= 4.5) {
        rgb = sample;
        hsl = toHsl(sample);
        break;
      }
    }
  }
  let onWhite = contrast(rgb, WHITE);
  let onInk = contrast(rgb, INK);
  if (onWhite < 4.5 && onInk < 4.5) {
    let found = false;
    for (let i = 1; i <= 28 && !found; i += 1) {
      for (const dir of [-1, 1]) {
        const sample = fromHsl(hsl[0], Math.min(hsl[1], 80), clamp(hsl[2] + dir * i * 2.5, 10, 90));
        const w = contrast(sample, WHITE);
        const k = contrast(sample, INK);
        if ((w >= 4.5 || k >= 4.5) && contrast(sample, canvas) >= 4.5) {
          rgb = sample;
          onWhite = w;
          onInk = k;
          found = true;
          break;
        }
      }
    }
  }
  if (onWhite < 4.5 && onInk < 4.5) {
    rgb = parse(theme === "light" ? "#5346d6" : "#7c6af7");
    onWhite = contrast(rgb, WHITE);
    onInk = contrast(rgb, INK);
  }
  const fg = onWhite >= 4.5 && onWhite >= onInk ? "#ffffff" : "#14120f";
  const hover = hexOf(rgb.map((v, i) => v + ((theme === "light" ? 0 : 255) - v) * 0.14) as RGB);
  const fill = hexOf(rgb);
  return {
    hex: fill,
    rgb: `${rgb[0]} ${rgb[1]} ${rgb[2]}`,
    fg,
    hover,
    soft: `color-mix(in srgb, ${fill} 16%, transparent)`,
    wash: `color-mix(in srgb, ${fill} 14%, transparent)`,
  };
}

export function accentChoice(appearance: Pick<AppearanceSettings, "accent" | "accentCustom">, theme: "light" | "dark"): string {
  const custom = appearance.accentCustom;
  if (custom && /^#[0-9a-fA-F]{6}$/.test(custom)) return custom;
  const preset = ACCENT_PRESETS.find((row) => row.id === appearance.accent) ?? ACCENT_PRESETS[0]!;
  return theme === "light" ? preset.light : preset.dark;
}

function paintStoredAppearance(): void {
  const fromCookie = (): { accent?: string; accentCustom?: string | null; at: number } => {
    const match = document.cookie.match(/(?:^|; )ensemble_accent=([^;]*)/);
    if (!match || !match[1]) return { at: 0 };
    let value = match[1];
    try {
      value = decodeURIComponent(value);
    } catch {
      // already decoded
    }
    const stamp = value.match(/@(\d+)$/);
    const at = stamp ? Number(stamp[1]) : 0;
    if (stamp && stamp.index !== undefined) value = value.slice(0, stamp.index);
    if (value.startsWith("c:") && /^#[0-9a-fA-F]{6}$/.test(value.slice(2))) return { accentCustom: value.slice(2), at };
    if (/^[a-z]+$/.test(value)) return { accent: value, at };
    return { at: 0 };
  };
  const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}") as {
    theme?: string;
    font?: string;
    textScale?: number;
    reduceMotion?: boolean;
    motion?: string;
    accent?: string;
    accentCustom?: string | null;
    accentAt?: number;
  };
  const saved = fromCookie();
  const localAt = typeof raw.accentAt === "number" ? raw.accentAt : 0;
  const localHas = Boolean(raw.accent || raw.accentCustom);
  const cookieHas = Boolean(saved.accent || saved.accentCustom);
  const useCookie = cookieHas && (!localHas || saved.at > localAt);
  const accent = useCookie ? saved.accent : localHas ? raw.accent : saved.accent;
  const accentCustom = useCookie ? (saved.accentCustom ?? null) : localHas ? (raw.accentCustom ?? null) : (saved.accentCustom ?? null);
  const root = document.documentElement;
  const theme = raw.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : raw.theme === "light" ? "light" : "dark";
  root.dataset.theme = theme;
  root.dataset.font = raw.font || "system";
  if (raw.textScale) root.style.fontSize = `${raw.textScale}%`;
  const osReduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const named = raw.motion === "expressive" || raw.motion === "minimal-quiet" || raw.motion === "minimal-dot";
  root.dataset.motionTheme = named ? raw.motion : osReduce ? "minimal-dot" : "expressive";
  root.dataset.reduceMotion = String(!!raw.reduceMotion || osReduce);
  const presets: Record<string, [string, string]> = {
    indigo: ["#7c6af7", "#5346d6"],
    tide: ["#5dcec6", "#0f766e"],
    ember: ["#f0a36a", "#c2410c"],
    rose: ["#f0a0b8", "#be185d"],
    brass: ["#e4c56e", "#92600c"],
    orchid: ["#cf9cf2", "#7c3aad"],
    moss: ["#a9cc7e", "#3f6b24"],
    sky: ["#82b3f5", "#1d4f91"],
  };
  const pair = presets[accent || "indigo"] ?? presets.indigo!;
  const chosen = accentCustom && /^#[0-9a-fA-F]{6}$/.test(accentCustom) ? accentCustom : theme === "light" ? pair[1] : pair[0];
  const resolved = resolveAccent(chosen, theme);
  root.style.setProperty("--accent", resolved.hex);
  root.style.setProperty("--accent-rgb", resolved.rgb);
  root.style.setProperty("--accent-fg", resolved.fg);
  root.style.setProperty("--accent-hover", resolved.hover);
  root.style.setProperty("--accent-soft", resolved.soft);
  root.style.setProperty("--wash", resolved.wash);
  root.style.setProperty("--agent", resolved.hex);
  root.style.setProperty("--agent-soft", resolved.soft);
}

/** Inlined before paint. Both functions are copied so the script has no imports. */
// Assign the minified functions as expressions. A bare `function () {}` from
// toString() is a syntax error, and the inner call uses the minified name.
export const APPEARANCE_BOOT = `try{${resolveAccent.toString()};var paintStoredAppearance=${paintStoredAppearance.toString()};paintStoredAppearance();}catch(e){}`;
