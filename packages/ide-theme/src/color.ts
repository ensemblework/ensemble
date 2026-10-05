/** Colors that are safe to put in CSS. Anything else is dropped. */

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = /^rgba?\(\s*([0-9.]+%?)\s*,\s*([0-9.]+%?)\s*,\s*([0-9.]+%?)\s*(?:,\s*([0-9.]+%?)\s*)?\)$/;
const HSL = /^hsla?\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*(?:,\s*([0-9.]+%?)\s*)?\)$/;

export function parseColor(input: string): Rgba | null {
  const value = input.trim();
  if (value.length > 80 || /url|expression|var\(|\/\*|;|\{|\}/i.test(value)) return null;
  const hex = HEX.exec(value);
  if (hex) return fromHex(hex[1]!);
  const rgb = RGB.exec(value);
  if (rgb) {
    const r = channel(rgb[1]!);
    const g = channel(rgb[2]!);
    const b = channel(rgb[3]!);
    const a = rgb[4] == null ? 1 : alpha(rgb[4]);
    if (r == null || g == null || b == null || a == null) return null;
    return { r, g, b, a };
  }
  const hsl = HSL.exec(value);
  if (hsl) {
    const h = Number(hsl[1]);
    const s = Number(hsl[2]);
    const l = Number(hsl[3]);
    const a = hsl[4] == null ? 1 : alpha(hsl[4]);
    if (![h, s, l].every((n) => Number.isFinite(n)) || a == null) return null;
    const rgbFrom = hslToRgb(h, s / 100, l / 100);
    return { ...rgbFrom, a };
  }
  return null;
}

export function formatColor(color: Rgba): string {
  const r = clamp255(color.r);
  const g = clamp255(color.g);
  const b = clamp255(color.b);
  if (color.a >= 0.999) return `#${hex(r)}${hex(g)}${hex(b)}`;
  const a = Math.round(Math.min(1, Math.max(0, color.a)) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function rgbTriplet(color: Rgba, over?: Rgba): string {
  const flat = color.a >= 0.999 || !over ? color : composite(color, over);
  return `${clamp255(flat.r)} ${clamp255(flat.g)} ${clamp255(flat.b)}`;
}

export function mix(a: Rgba, b: Rgba, amount: number): Rgba {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}

export function composite(src: Rgba, dst: Rgba): Rgba {
  const a = src.a + dst.a * (1 - src.a);
  if (a <= 0.0001) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (s: number, d: number) => (s * src.a + d * dst.a * (1 - src.a)) / a;
  return { r: ch(src.r, dst.r), g: ch(src.g, dst.g), b: ch(src.b, dst.b), a };
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastForeground(color: Rgba): Rgba {
  const onBlack = contrastRatio(color, { r: 20, g: 18, b: 16, a: 1 });
  const onWhite = contrastRatio(color, { r: 255, g: 255, b: 255, a: 1 });
  return onBlack >= onWhite ? { r: 243, g: 238, b: 230, a: 1 } : { r: 20, g: 18, b: 16, a: 1 };
}

function fromHex(body: string): Rgba | null {
  const full = body.length <= 4 ? [...body].map((c) => c + c).join("") : body;
  if (full.length !== 6 && full.length !== 8) return null;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

function channel(raw: string): number | null {
  if (raw.endsWith("%")) {
    const n = Number(raw.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clamp255((n / 100) * 255);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clamp255(n);
}

function alpha(raw: string): number | null {
  const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function luminance(color: Rgba): number {
  const f = (n: number) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(color.r) + 0.7152 * f(color.g) + 0.0722 * f(color.b);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
