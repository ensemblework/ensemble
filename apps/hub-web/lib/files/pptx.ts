/**
 * A small PowerPoint (.pptx) reader for previews: slide size and order, text with
 * its formatting, pictures, fills, backgrounds, groups, simple tables, and labelled
 * boxes for charts and other objects. It only reads XML and image bytes; nothing in
 * the file is run, and linked (external) pictures are never fetched.
 */
import { strFromU8, unzipSync } from "fflate";

const EMU_PER_PX = 9525;
const px = (emu: number) => emu / EMU_PER_PX;
const ptToPx = (pt: number) => (pt * 96) / 72;

export type PptxFill = { color?: string; image?: string; gradient?: string };
export type PptxBox = { x: number; y: number; w: number; h: number; rotate?: number; flipH?: boolean; flipV?: boolean };

export type PptxRun = {
  text: string;
  /** Pixels at 96 dpi. */
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  /** A line break inside the paragraph. */
  lineBreak?: boolean;
};

export type PptxParagraph = {
  align: "left" | "center" | "right" | "justify";
  marginLeft: number;
  indent: number;
  bullet?: { text: string; color?: string; size?: number; font?: string };
  runs: PptxRun[];
  spaceBefore: number;
  spaceAfter: number;
  /** A multiple of the font size, or pixels when `lineHeightPx` is set. */
  lineHeight?: number;
  lineHeightPx?: number;
  /** Font size of an empty paragraph, so blank lines keep their height. */
  emptySize: number;
};

export type PptxText = {
  paragraphs: PptxParagraph[];
  anchor: "top" | "middle" | "bottom";
  insets: { top: number; right: number; bottom: number; left: number };
  wrap: boolean;
  vertical?: "vertical" | "vertical270";
};

export type PptxCell = { text: PptxText; fill?: string; colSpan: number; rowSpan: number; hidden: boolean };

export type PptxShape =
  | { kind: "shape"; name: string; box: PptxBox; fill?: PptxFill; line?: { color: string; width: number }; geometry: "rect" | "roundRect" | "ellipse" | "other"; text?: PptxText }
  | { kind: "image"; name: string; box: PptxBox; media: string }
  | { kind: "line"; name: string; box: PptxBox; color: string; width: number }
  | { kind: "table"; name: string; box: PptxBox; columns: number[]; rows: Array<{ height: number; cells: PptxCell[] }>; headerRow: boolean }
  | { kind: "placeholder"; name: string; box: PptxBox; label: string };

export type PptxSlide = { number: number; hidden: boolean; background: PptxFill; shapes: PptxShape[] };

export type PptxDeck = {
  /** Slide size in pixels at 96 dpi. */
  width: number;
  height: number;
  slides: PptxSlide[];
  /** Pictures the slides use, by their path inside the file. */
  media: Record<string, { bytes: Uint8Array; mime: string }>;
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

// ── XML helpers ─────────────────────────────────────────────────────────────

type El = Element;

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This presentation has a part Ensemble cannot read.");
  return doc;
}

function kids(el: El | null | undefined, name?: string): El[] {
  if (!el) return [];
  const out: El[] = [];
  for (const child of Array.from(el.children)) if (!name || child.localName === name) out.push(child);
  return out;
}

function kid(el: El | null | undefined, name: string): El | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) if (child.localName === name) return child;
  return null;
}

function at(el: El | null | undefined, ...names: string[]): El | null {
  let current: El | null | undefined = el;
  for (const name of names) {
    current = kid(current, name);
    if (!current) return null;
  }
  return current ?? null;
}

function descendant(el: El | null | undefined, name: string): El | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) {
    if (child.localName === name) return child;
    const deep = descendant(child, name);
    if (deep) return deep;
  }
  return null;
}

function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const item of Array.from(el.attributes)) if (item.localName === name) return item.value;
  return null;
}

/** A relationship reference (r:id, r:embed…), which can sit next to a plain attribute of the same local name. */
function rid(el: El | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const item of Array.from(el.attributes)) if (item.localName === name && (item.namespaceURI ?? "").endsWith("/relationships")) return item.value;
  return null;
}

function num(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === "1" || value === "true" || value === "on";
}

function textOf(el: El | null): string {
  if (!el) return "";
  const parts: string[] = [];
  const walk = (node: El) => {
    if (node.localName === "t") parts.push(node.textContent ?? "");
    for (const child of Array.from(node.children)) walk(child);
  };
  walk(el);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ── package paths and relationships ─────────────────────────────────────────

type Rel = { type: string; target: string; external: boolean };
type Rels = Map<string, Rel>;

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base ? base.split("/") : [];
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

function relsPath(part: string): string {
  const dir = dirOf(part);
  const name = part.slice(dir.length ? dir.length + 1 : 0);
  return `${dir ? `${dir}/` : ""}_rels/${name}.rels`;
}

class Package {
  private docs = new Map<string, Document | null>();
  private rels = new Map<string, Rels>();
  constructor(private readonly files: Record<string, Uint8Array>) {}

  has(path: string): boolean {
    return path in this.files;
  }

  bytes(path: string): Uint8Array | undefined {
    return this.files[path];
  }

  xml(path: string): Document | null {
    if (this.docs.has(path)) return this.docs.get(path)!;
    const raw = this.files[path];
    const doc = raw ? parseXml(strFromU8(raw)) : null;
    this.docs.set(path, doc);
    return doc;
  }

  relsOf(part: string): Rels {
    const cached = this.rels.get(part);
    if (cached) return cached;
    const out: Rels = new Map();
    const doc = this.xml(relsPath(part));
    for (const rel of kids(doc?.documentElement, "Relationship")) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (!id || !target) continue;
      const external = attr(rel, "TargetMode") === "External";
      out.set(id, { type: attr(rel, "Type") ?? "", target: external ? target : resolvePath(dirOf(part), target), external });
    }
    this.rels.set(part, out);
    return out;
  }

  relOfType(part: string, suffix: string): Rel | undefined {
    for (const rel of this.relsOf(part).values()) if (rel.type.endsWith(suffix)) return rel;
    return undefined;
  }
}

// ── colours ─────────────────────────────────────────────────────────────────

type ColorCtx = { theme: Record<string, string>; map: Record<string, string> };

const COLOR_TAGS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"]);
const PRESET: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  gray: "808080",
  grey: "808080",
  darkGray: "A9A9A9",
  lightGray: "D3D3D3",
  orange: "FFA500",
  purple: "800080",
  navy: "000080",
  teal: "008080",
};
const DEFAULT_MAP: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

type Rgb = [number, number, number];

function hexRgb(value: string | null | undefined): Rgb | undefined {
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return undefined;
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function css(rgb: Rgb, alpha: number): string {
  const [r, g, b] = rgb.map((value) => Math.round(Math.min(255, Math.max(0, value))));
  if (alpha < 1) return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
  return `#${[r, g, b].map((value) => value!.toString(16).padStart(2, "0")).join("")}`;
}

/** A colour from a fill (a:solidFill) or a colour element itself, as CSS. */
function readColor(el: El | null | undefined, ctx: ColorCtx): string | undefined {
  if (!el) return undefined;
  const color = COLOR_TAGS.has(el.localName) ? el : kids(el).find((child) => COLOR_TAGS.has(child.localName));
  if (!color) return undefined;
  let rgb: Rgb | undefined;
  switch (color.localName) {
    case "srgbClr":
      rgb = hexRgb(attr(color, "val"));
      break;
    case "sysClr":
      rgb = hexRgb(attr(color, "lastClr")) ?? (attr(color, "val") === "window" ? [255, 255, 255] : [0, 0, 0]);
      break;
    case "schemeClr": {
      const name = attr(color, "val") ?? "";
      const mapped = ctx.map[name] ?? DEFAULT_MAP[name] ?? name;
      rgb = hexRgb(ctx.theme[mapped]);
      break;
    }
    case "prstClr":
      rgb = hexRgb(PRESET[attr(color, "val") ?? ""]);
      break;
    case "scrgbClr":
      rgb = [num(attr(color, "r"), 0), num(attr(color, "g"), 0), num(attr(color, "b"), 0)].map((value) => (value / 100000) * 255) as Rgb;
      break;
    case "hslClr":
      rgb = fromHsl([num(attr(color, "hue"), 0) / 21600000, num(attr(color, "sat"), 0) / 100000, num(attr(color, "lum"), 0) / 100000]);
      break;
  }
  if (!rgb) return undefined;
  let alpha = 1;
  for (const mod of kids(color)) {
    const value = num(attr(mod, "val"), 100000) / 100000;
    switch (mod.localName) {
      case "lumMod": {
        const hsl = toHsl(rgb);
        rgb = fromHsl([hsl[0], hsl[1], clamp01(hsl[2] * value)]);
        break;
      }
      case "lumOff": {
        const hsl = toHsl(rgb);
        rgb = fromHsl([hsl[0], hsl[1], clamp01(hsl[2] + value)]);
        break;
      }
      case "satMod": {
        const hsl = toHsl(rgb);
        rgb = fromHsl([hsl[0], clamp01(hsl[1] * value), hsl[2]]);
        break;
      }
      case "tint":
        rgb = rgb.map((channel) => channel + (255 - channel) * (1 - value)) as Rgb;
        break;
      case "shade":
        rgb = rgb.map((channel) => channel * value) as Rgb;
        break;
      case "alpha":
        alpha = clamp01(value);
        break;
    }
  }
  return css(rgb, alpha);
}

function schemeColor(name: string, ctx: ColorCtx): string {
  const value = ctx.theme[ctx.map[name] ?? DEFAULT_MAP[name] ?? name];
  return value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : "#000000";
}

function readTheme(doc: Document | null): { colors: Record<string, string>; major: string; minor: string } {
  const colors: Record<string, string> = {};
  const scheme = descendant(doc?.documentElement, "clrScheme");
  for (const entry of kids(scheme)) {
    const color = kids(entry)[0];
    const value = color?.localName === "sysClr" ? attr(color, "lastClr") : attr(color, "val");
    if (value) colors[entry.localName] = value;
  }
  const fonts = descendant(doc?.documentElement, "fontScheme");
  return {
    colors,
    major: attr(at(fonts, "majorFont", "latin"), "typeface") ?? "Calibri Light",
    minor: attr(at(fonts, "minorFont", "latin"), "typeface") ?? "Calibri",
  };
}

function readMap(el: El | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of Array.from(el?.attributes ?? [])) out[item.localName] = item.value;
  return out;
}

// ── slide parts and placeholders ────────────────────────────────────────────

type Part = { path: string; root: El; tree: El | null };
type Master = Part & { map: Record<string, string>; theme: ReturnType<typeof readTheme>; txStyles: El | null };
type Layout = Part & { master: Master };
type Ph = { type: string; idx: string | null };

const normType = (type: string) => (type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" ? "body" : type);

function phOf(shape: El): Ph | null {
  const nv = kids(shape).find((child) => child.localName.startsWith("nv"));
  const ph = at(nv, "nvPr", "ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") };
}

function findPlaceholder(part: Part | null, ph: Ph, useIdx: boolean): El | null {
  if (!part?.tree) return null;
  const shapes = kids(part.tree);
  if (useIdx && ph.idx !== null) {
    const byIdx = shapes.find((shape) => phOf(shape)?.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  const wanted = normType(ph.type);
  return shapes.find((shape) => {
    const other = phOf(shape);
    return other ? normType(other.type) === wanted : false;
  }) ?? null;
}

type Scope = {
  pkg: Package;
  /** The part whose relationships pictures resolve through. */
  part: Part;
  ctx: ColorCtx;
  theme: ReturnType<typeof readTheme>;
  layout: Layout | null;
  master: Master;
  /** presentation.xml defaultTextStyle */
  defaults: El | null;
  slideNumber: number;
  media: PptxDeck["media"];
  /** The theme's text colour (tx1), for runs that name none. */
  textColor: string;
};

type ShapeSources = { own: El; layout: El | null; master: El | null; ph: Ph | null };

function sourcesOf(shape: El, scope: Scope, inherit: boolean): ShapeSources {
  const ph = inherit ? phOf(shape) : null;
  if (!ph) return { own: shape, layout: null, master: null, ph: null };
  const layout = scope.layout ? findPlaceholder(scope.layout, ph, true) : null;
  const master = findPlaceholder(scope.master, ph, false);
  return { own: shape, layout, master, ph };
}

function chain(sources: ShapeSources, ...names: string[]): El[] {
  return [sources.own, sources.layout, sources.master].map((el) => at(el, ...names)).filter((el): el is El => Boolean(el));
}

// ── geometry ────────────────────────────────────────────────────────────────

type Transform = (box: PptxBox) => PptxBox;
const identity: Transform = (box) => box;

function readXfrm(xfrm: El | null): PptxBox | null {
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!off || !ext) return null;
  const rotate = num(attr(xfrm, "rot"), 0) / 60000;
  return {
    x: px(num(attr(off, "x"), 0)),
    y: px(num(attr(off, "y"), 0)),
    w: px(num(attr(ext, "cx"), 0)),
    h: px(num(attr(ext, "cy"), 0)),
    ...(rotate ? { rotate } : {}),
    ...(flag(attr(xfrm, "flipH")) ? { flipH: true } : {}),
    ...(flag(attr(xfrm, "flipV")) ? { flipV: true } : {}),
  };
}

function groupTransform(group: El, parent: Transform): Transform {
  const xfrm = at(group, "grpSpPr", "xfrm");
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  const chOff = kid(xfrm, "chOff");
  const chExt = kid(xfrm, "chExt");
  if (!off || !ext) return parent;
  const ox = px(num(attr(off, "x"), 0));
  const oy = px(num(attr(off, "y"), 0));
  const cx = px(num(attr(chOff, "x"), 0));
  const cy = px(num(attr(chOff, "y"), 0));
  const chW = num(attr(chExt, "cx"), 0);
  const chH = num(attr(chExt, "cy"), 0);
  const sx = chW ? num(attr(ext, "cx"), 0) / chW : 1;
  const sy = chH ? num(attr(ext, "cy"), 0) / chH : 1;
  return (box) => parent({ ...box, x: ox + (box.x - cx) * sx, y: oy + (box.y - cy) * sy, w: box.w * sx, h: box.h * sy });
}

// ── fills ───────────────────────────────────────────────────────────────────

function mediaFor(scope: Scope, embed: string | null): string | undefined {
  if (!embed) return undefined;
  const rel = scope.pkg.relsOf(scope.part.path).get(embed);
  if (!rel || rel.external) return undefined;
  const ext = rel.target.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext];
  const bytes = scope.pkg.bytes(rel.target);
  if (!mime || !bytes) return undefined;
  scope.media[rel.target] ??= { bytes, mime };
  return rel.target;
}

function gradientCss(grad: El, ctx: ColorCtx): string | undefined {
  const stops = kids(kid(grad, "gsLst"), "gs")
    .map((stop) => ({ pos: num(attr(stop, "pos"), 0) / 1000, color: readColor(stop, ctx) }))
    .filter((stop): stop is { pos: number; color: string } => Boolean(stop.color))
    .sort((a, b) => a.pos - b.pos);
  if (!stops.length) return undefined;
  if (stops.length === 1) return stops[0]!.color;
  const angle = num(attr(kid(grad, "lin"), "ang"), 0) / 60000;
  return `linear-gradient(${Math.round(angle + 90)}deg, ${stops.map((stop) => `${stop.color} ${Math.round(stop.pos)}%`).join(", ")})`;
}

/** Fill from a spPr, bgPr or tcPr: undefined when it says nothing, {} for "no fill". */
function readFill(container: El | null, scope: Scope): PptxFill | undefined {
  if (!container) return undefined;
  for (const child of kids(container)) {
    switch (child.localName) {
      case "noFill":
        return {};
      case "solidFill": {
        const color = readColor(child, scope.ctx);
        return color ? { color } : {};
      }
      case "gradFill": {
        const gradient = gradientCss(child, scope.ctx);
        return gradient ? (gradient.startsWith("linear") ? { gradient } : { color: gradient }) : {};
      }
      case "blipFill": {
        const image = mediaFor(scope, rid(kid(child, "blip"), "embed"));
        return image ? { image } : {};
      }
      case "pattFill": {
        const color = readColor(kid(child, "fgClr"), scope.ctx);
        return color ? { color } : {};
      }
    }
  }
  return undefined;
}

function styleRefColor(shape: El, ref: string, scope: Scope): string | undefined {
  const el = at(shape, "style", ref);
  if (!el || num(attr(el, "idx"), 0) === 0) return undefined;
  return readColor(el, scope.ctx);
}

// ── text ────────────────────────────────────────────────────────────────────

const WINGDINGS: Record<string, string> = { "§": "▪", Ø: "➢", ü: "✓", q: "❑", v: "❖", n: "■", l: "●", o: "○", "Ä": "►", "à": "→", "ð": "⇨" };

function fontName(typeface: string | null, theme: Scope["theme"]): string | undefined {
  if (!typeface) return undefined;
  if (typeface.startsWith("+mj")) return theme.major;
  if (typeface.startsWith("+mn")) return theme.minor;
  return typeface;
}

function levelStyles(sources: ShapeSources, scope: Scope): El[] {
  const lists = chain(sources, "txBody", "lstStyle");
  const styles = at(scope.master.txStyles, sources.ph ? (normType(sources.ph.type) === "title" ? "titleStyle" : normType(sources.ph.type) === "body" ? "bodyStyle" : "otherStyle") : "otherStyle");
  return [...lists, ...(sources.ph && styles ? [styles] : []), ...(scope.defaults ? [scope.defaults] : []), ...(!sources.ph && styles ? [styles] : [])];
}

function autoNumber(type: string, index: number): string {
  const n = index + 1;
  const alpha = (value: number) => {
    let out = "";
    let left = value;
    while (left > 0) {
      left -= 1;
      out = String.fromCharCode(97 + (left % 26)) + out;
      left = Math.floor(left / 26);
    }
    return out;
  };
  const roman = (value: number) => {
    const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let out = "";
    let left = value;
    for (const [amount, letters] of table) while (left >= amount) {
      out += letters;
      left -= amount;
    }
    return out;
  };
  const base = type.startsWith("alphaLc") ? alpha(n) : type.startsWith("alphaUc") ? alpha(n).toUpperCase() : type.startsWith("romanLc") ? roman(n) : type.startsWith("romanUc") ? roman(n).toUpperCase() : String(n);
  if (type.endsWith("ParenBoth")) return `(${base})`;
  if (type.endsWith("ParenR")) return `${base})`;
  if (type.endsWith("Period")) return `${base}.`;
  return base;
}

function readText(txBody: El | null, sources: ShapeSources, scope: Scope, fontColor?: string): PptxText | undefined {
  if (!txBody) return undefined;
  const bodyPrs = [kid(txBody, "bodyPr"), at(sources.layout, "txBody", "bodyPr"), at(sources.master, "txBody", "bodyPr")].filter((el): el is El => Boolean(el));
  const bodyAttr = (name: string) => {
    for (const el of bodyPrs) {
      const value = attr(el, name);
      if (value !== null) return value;
    }
    return null;
  };
  const autofit = bodyPrs.map((el) => kid(el, "normAutofit")).find(Boolean) ?? null;
  const fontScale = num(attr(autofit, "fontScale"), 100000) / 100000;
  const spacingCut = num(attr(autofit, "lnSpcReduction"), 0) / 100000;
  const anchor = bodyAttr("anchor");
  const vert = bodyAttr("vert");
  const levels = levelStyles(sources, scope);
  const counters: number[] = [];
  const paragraphs: PptxParagraph[] = [];
  for (const p of kids(txBody, "p")) {
    const pPr = kid(p, "pPr");
    const level = Math.min(8, Math.max(0, num(attr(pPr, "lvl"), 0)));
    const lvlName = `lvl${level + 1}pPr`;
    const pChain = [pPr, ...levels.map((style) => kid(style, lvlName)), ...levels.map((style) => kid(style, "defPPr"))].filter((el): el is El => Boolean(el));
    const pAttr = (name: string) => {
      for (const el of pChain) {
        const value = attr(el, name);
        if (value !== null) return value;
      }
      return null;
    };
    const pKid = (name: string) => {
      for (const el of pChain) {
        const found = kid(el, name);
        if (found) return found;
      }
      return null;
    };
    const defaults = pChain.map((el) => kid(el, "defRPr")).filter((el): el is El => Boolean(el));
    const runProps = (rPr: El | null) => {
      const runChain = [rPr, ...defaults].filter((el): el is El => Boolean(el));
      const runAttr = (name: string) => {
        for (const el of runChain) {
          const value = attr(el, name);
          if (value !== null) return value;
        }
        return null;
      };
      let color: string | undefined;
      const ownFill = kid(rPr, "solidFill") ?? kid(rPr, "gradFill");
      if (ownFill) color = ownFill.localName === "gradFill" ? readColor(at(ownFill, "gsLst", "gs"), scope.ctx) : readColor(ownFill, scope.ctx);
      if (!color && fontColor) color = fontColor;
      if (!color) {
        for (const el of defaults) {
          const fill = kid(el, "solidFill");
          if (fill) {
            color = readColor(fill, scope.ctx);
            if (color) break;
          }
        }
      }
      const latin = runChain.map((el) => attr(kid(el, "latin"), "typeface")).find(Boolean) ?? null;
      const underline = runAttr("u");
      const strike = runAttr("strike");
      return {
        size: ptToPx((num(runAttr("sz"), 1800) / 100) * fontScale),
        bold: flag(runAttr("b")) || undefined,
        italic: flag(runAttr("i")) || undefined,
        underline: underline && underline !== "none" ? true : undefined,
        strike: strike && strike !== "noStrike" ? true : undefined,
        color: color ?? scope.textColor,
        font: fontName(latin, scope.theme) ?? (sources.ph && normType(sources.ph.type) === "title" ? scope.theme.major : scope.theme.minor),
      } satisfies Omit<PptxRun, "text">;
    };
    const runs: PptxRun[] = [];
    for (const child of kids(p)) {
      if (child.localName === "r") runs.push({ text: kid(child, "t")?.textContent ?? "", ...runProps(kid(child, "rPr")) });
      else if (child.localName === "br") runs.push({ text: "", lineBreak: true, ...runProps(kid(child, "rPr")) });
      else if (child.localName === "fld") {
        const type = attr(child, "type") ?? "";
        const text = type === "slidenum" ? String(scope.slideNumber) : (kid(child, "t")?.textContent ?? "");
        runs.push({ text, ...runProps(kid(child, "rPr")) });
      }
    }
    const endSize = runProps(kid(p, "endParaRPr")).size;
    const algn = pAttr("algn");
    const visible = runs.some((run) => run.text.trim());
    let bullet: PptxParagraph["bullet"];
    let marker: El | null = null;
    for (const el of pChain) {
      marker = kids(el).find((child) => child.localName === "buNone" || child.localName === "buChar" || child.localName === "buAutoNum") ?? null;
      if (marker) break;
    }
    if (visible && marker && marker.localName !== "buNone") {
      const firstRun = runs.find((run) => run.text.trim()) ?? runs[0];
      const sizePct = num(attr(pKid("buSzPct"), "val"), 100000) / 100000;
      const buFont = attr(pKid("buFont"), "typeface");
      const color = readColor(pKid("buClr"), scope.ctx) ?? firstRun?.color;
      const size = (firstRun?.size ?? endSize) * sizePct;
      if (marker.localName === "buChar") {
        const raw = attr(marker, "char") ?? "•";
        const symbolic = buFont ? /wingdings|symbol|webdings/i.test(buFont) : false;
        bullet = { text: symbolic ? (WINGDINGS[raw] ?? "•") : raw, color, size, ...(symbolic || !buFont ? {} : { font: buFont }) };
        counters.length = level;
      } else {
        const start = num(attr(marker, "startAt"), 1);
        counters[level] = counters[level] === undefined ? start : counters[level]! + 1;
        counters.length = level + 1;
        bullet = { text: autoNumber(attr(marker, "type") ?? "arabicPeriod", counters[level]! - 1), color, size };
      }
    } else if (visible) {
      counters.length = level;
    }
    const spacing = (name: string, base: number) => {
      const el = pKid(name);
      const pts = kid(el, "spcPts");
      if (pts) return ptToPx(num(attr(pts, "val"), 0) / 100);
      const pct = kid(el, "spcPct");
      if (pct) return (num(attr(pct, "val"), 0) / 100000) * base;
      return 0;
    };
    const baseSize = runs.find((run) => run.text)?.size ?? endSize;
    const line = pKid("lnSpc");
    const linePct = kid(line, "spcPct");
    const linePts = kid(line, "spcPts");
    paragraphs.push({
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" || algn === "dist" ? "justify" : "left",
      marginLeft: px(num(pAttr("marL"), 0)),
      indent: px(num(pAttr("indent"), 0)),
      bullet,
      runs,
      spaceBefore: spacing("spcBef", baseSize),
      spaceAfter: spacing("spcAft", baseSize),
      ...(linePct ? { lineHeight: Math.max(0.6, (num(attr(linePct, "val"), 100000) / 100000) * 1.2 - spacingCut) } : {}),
      ...(linePts ? { lineHeightPx: ptToPx(num(attr(linePts, "val"), 0) / 100) } : {}),
      ...(!linePct && !linePts && spacingCut ? { lineHeight: 1.2 - spacingCut } : {}),
      emptySize: endSize,
    });
  }
  return {
    paragraphs,
    anchor: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
    insets: {
      left: px(num(bodyAttr("lIns"), 91440)),
      right: px(num(bodyAttr("rIns"), 91440)),
      top: px(num(bodyAttr("tIns"), 45720)),
      bottom: px(num(bodyAttr("bIns"), 45720)),
    },
    wrap: bodyAttr("wrap") !== "none",
    ...(vert === "vert" || vert === "eaVert" ? { vertical: "vertical" as const } : vert === "vert270" ? { vertical: "vertical270" as const } : {}),
  };
}

function hasText(text: PptxText | undefined): boolean {
  return Boolean(text?.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text.trim())));
}

// ── shapes ──────────────────────────────────────────────────────────────────

function nameOf(shape: El): string {
  const nv = kids(shape).find((child) => child.localName.startsWith("nv"));
  const cNvPr = kid(nv, "cNvPr");
  return attr(cNvPr, "name") ?? shape.localName;
}

function isHidden(shape: El): boolean {
  const nv = kids(shape).find((child) => child.localName.startsWith("nv"));
  return flag(attr(kid(nv, "cNvPr"), "hidden")) === true;
}

function readShape(shape: El, scope: Scope, transform: Transform, inherit: boolean, out: PptxShape[]): void {
  const sources = sourcesOf(shape, scope, inherit);
  const xfrm = chain(sources, "spPr", "xfrm")[0] ?? null;
  const raw = readXfrm(xfrm);
  if (!raw) return;
  const box = transform(raw);
  const fills = [at(sources.own, "spPr"), at(sources.layout, "spPr"), at(sources.master, "spPr")];
  let fill: PptxFill | undefined;
  for (const container of fills) {
    fill = readFill(container, scope);
    if (fill) break;
  }
  if (!fill) {
    const color = styleRefColor(shape, "fillRef", scope);
    if (color) fill = { color };
  }
  let line: { color: string; width: number } | undefined;
  const ln = chain(sources, "spPr", "ln")[0] ?? null;
  if (ln && !kid(ln, "noFill")) {
    const color = readColor(kid(ln, "solidFill"), scope.ctx) ?? styleRefColor(shape, "lnRef", scope);
    if (color) line = { color, width: Math.max(0.75, px(num(attr(ln, "w"), 12700))) };
  } else if (!ln) {
    const color = styleRefColor(shape, "lnRef", scope);
    if (color) line = { color, width: 1 };
  }
  const prst = attr(at(sources.own, "spPr", "prstGeom"), "prst") ?? attr(chain(sources, "spPr", "prstGeom")[0] ?? null, "prst") ?? "rect";
  const fontColor = styleRefColor(shape, "fontRef", scope);
  const text = readText(kid(shape, "txBody"), sources, scope, fontColor);
  const visibleFill = fill && (fill.color || fill.image || fill.gradient);
  if (prst === "line" || prst.startsWith("straightConnector")) {
    if (line) out.push({ kind: "line", name: nameOf(shape), box, color: line.color, width: line.width });
    return;
  }
  if (!visibleFill && !line && !hasText(text)) return;
  out.push({
    kind: "shape",
    name: nameOf(shape),
    box,
    ...(visibleFill ? { fill } : {}),
    ...(line ? { line } : {}),
    geometry: prst === "rect" ? "rect" : prst === "roundRect" ? "roundRect" : prst === "ellipse" ? "ellipse" : "other",
    ...(hasText(text) ? { text } : {}),
  });
}

function readPicture(pic: El, scope: Scope, transform: Transform, inherit: boolean, out: PptxShape[]): void {
  const sources = sourcesOf(pic, scope, inherit);
  const raw = readXfrm(chain(sources, "spPr", "xfrm")[0] ?? null);
  if (!raw) return;
  const box = transform(raw);
  const blip = at(pic, "blipFill", "blip");
  const media = mediaFor(scope, rid(blip, "embed"));
  if (media) {
    out.push({ kind: "image", name: nameOf(pic), box, media });
    return;
  }
  const embed = rid(blip, "embed");
  const target = embed ? scope.pkg.relsOf(scope.part.path).get(embed)?.target : undefined;
  const ext = target?.split(".").pop()?.toUpperCase();
  out.push({ kind: "placeholder", name: nameOf(pic), box, label: ext ? `Picture (${ext}) that browsers cannot show` : "Linked picture (not loaded)" });
}

const CHART_LABEL: Record<string, string> = {
  barChart: "Bar chart",
  bar3DChart: "Bar chart",
  lineChart: "Line chart",
  line3DChart: "Line chart",
  pieChart: "Pie chart",
  pie3DChart: "Pie chart",
  doughnutChart: "Doughnut chart",
  areaChart: "Area chart",
  scatterChart: "Scatter chart",
  radarChart: "Radar chart",
  bubbleChart: "Bubble chart",
};

function readTable(tbl: El, scope: Scope): Omit<Extract<PptxShape, { kind: "table" }>, "kind" | "name" | "box"> {
  const columns = kids(kid(tbl, "tblGrid"), "gridCol").map((col) => px(num(attr(col, "w"), 0)));
  const headerRow = flag(attr(kid(tbl, "tblPr"), "firstRow")) === true;
  const noSources: ShapeSources = { own: tbl, layout: null, master: null, ph: null };
  const rows = kids(tbl, "tr").map((tr) => ({
    height: px(num(attr(tr, "h"), 0)),
    cells: kids(tr, "tc").map((tc) => {
      const tcPr = kid(tc, "tcPr");
      const fill = readFill(tcPr, scope);
      const text = readText(kid(tc, "txBody"), noSources, scope) ?? { paragraphs: [], anchor: "top" as const, insets: { top: 4, right: 8, bottom: 4, left: 8 }, wrap: true };
      text.insets = {
        left: px(num(attr(tcPr, "marL"), 91440)),
        right: px(num(attr(tcPr, "marR"), 91440)),
        top: px(num(attr(tcPr, "marT"), 45720)),
        bottom: px(num(attr(tcPr, "marB"), 45720)),
      };
      const anchor = attr(tcPr, "anchor");
      text.anchor = anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top";
      return {
        text,
        ...(fill?.color ? { fill: fill.color } : {}),
        colSpan: Math.max(1, num(attr(tc, "gridSpan"), 1)),
        rowSpan: Math.max(1, num(attr(tc, "rowSpan"), 1)),
        hidden: flag(attr(tc, "hMerge")) === true || flag(attr(tc, "vMerge")) === true,
      };
    }),
  }));
  return { columns, rows, headerRow };
}

function readFrame(frame: El, scope: Scope, transform: Transform, inherit: boolean, out: PptxShape[]): void {
  const sources = sourcesOf(frame, scope, inherit);
  const raw = readXfrm(kid(frame, "xfrm") ?? at(sources.layout, "spPr", "xfrm") ?? at(sources.master, "spPr", "xfrm"));
  if (!raw) return;
  const box = transform(raw);
  const data = at(frame, "graphic", "graphicData");
  const uri = attr(data, "uri") ?? "";
  const name = nameOf(frame);
  if (uri.endsWith("/table")) {
    const tbl = kid(data, "tbl");
    if (tbl) out.push({ kind: "table", name, box, ...readTable(tbl, scope) });
    return;
  }
  if (uri.endsWith("/chart")) {
    const id = rid(kid(data, "chart"), "id");
    const target = id ? scope.pkg.relsOf(scope.part.path).get(id)?.target : undefined;
    const chart = target ? scope.pkg.xml(target) : null;
    const plot = descendant(chart?.documentElement, "plotArea");
    const type = kids(plot).find((child) => child.localName.endsWith("Chart"))?.localName;
    const title = textOf(descendant(chart?.documentElement, "title"));
    out.push({ kind: "placeholder", name, box, label: `${type ? (CHART_LABEL[type] ?? "Chart") : "Chart"}${title ? `: ${title}` : ""}` });
    return;
  }
  if (uri.endsWith("/diagram")) {
    const dmId = rid(kid(data, "relIds"), "dm");
    const rels = scope.pkg.relsOf(scope.part.path);
    const model = dmId ? rels.get(dmId) : undefined;
    const ext = model ? descendant(scope.pkg.xml(model.target)?.documentElement, "dataModelExt") : null;
    const drawingRel = ext ? rels.get(attr(ext, "relId") ?? "") : undefined;
    const drawing = drawingRel ? scope.pkg.xml(drawingRel.target) : null;
    const tree = descendant(drawing?.documentElement, "spTree");
    if (tree) {
      const offset: Transform = (child) => transform({ ...child, x: raw.x + child.x, y: raw.y + child.y });
      readTree(tree, { ...scope, part: { path: drawingRel!.target, root: drawing!.documentElement, tree } }, offset, "plain", out);
      return;
    }
    out.push({ kind: "placeholder", name, box, label: "SmartArt graphic" });
    return;
  }
  const pic = descendant(data, "pic");
  if (pic) {
    readPicture(pic, scope, () => box, false, out);
    return;
  }
  out.push({ kind: "placeholder", name, box, label: "Embedded object" });
}

/** "slide": placeholders inherit from the layout and master. "template": a layout or master, whose placeholders are prompts and are skipped. */
type TreeMode = "slide" | "template" | "plain";

function readTree(tree: El, scope: Scope, transform: Transform, mode: TreeMode, out: PptxShape[]): void {
  const inherit = mode === "slide";
  for (const child of kids(tree)) {
    if (isHidden(child)) continue;
    if (mode === "template" && phOf(child)) continue;
    switch (child.localName) {
      case "sp":
        readShape(child, scope, transform, inherit, out);
        break;
      case "pic":
        readPicture(child, scope, transform, inherit, out);
        break;
      case "cxnSp":
        readShape(child, scope, transform, false, out);
        break;
      case "graphicFrame":
        readFrame(child, scope, transform, inherit, out);
        break;
      case "grpSp":
        readTree(child, scope, groupTransform(child, transform), mode, out);
        break;
      case "AlternateContent": {
        const pick = kid(child, "Fallback") ?? kid(child, "Choice");
        if (pick) readTree(pick, scope, transform, mode, out);
        break;
      }
    }
  }
}

function readBackground(part: Part | null, scope: Scope): PptxFill | undefined {
  const bg = at(part?.root, "cSld", "bg");
  if (!bg) return undefined;
  const bgPr = kid(bg, "bgPr");
  if (bgPr) return readFill(bgPr, { ...scope, part: part! });
  const ref = kid(bg, "bgRef");
  const color = readColor(ref, scope.ctx);
  return color ? { color } : undefined;
}

function partOf(pkg: Package, path: string): Part | null {
  const doc = pkg.xml(path);
  if (!doc) return null;
  const root = doc.documentElement;
  return { path, root, tree: at(root, "cSld", "spTree") };
}

/** Reads a .pptx file. Throws a plain-language error when the file is not a presentation. */
export function parsePptx(bytes: Uint8Array): PptxDeck {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a PowerPoint presentation Ensemble can read. It may be damaged or password-protected.");
  }
  const pkg = new Package(files);
  const main = [...pkg.relsOf("").values()].find((rel) => rel.type.endsWith("/officeDocument"))?.target ?? "ppt/presentation.xml";
  const presentation = pkg.xml(main);
  if (!presentation) throw new Error("This file is not a PowerPoint presentation Ensemble can read. It may be damaged or password-protected.");
  const root = presentation.documentElement;
  const size = kid(root, "sldSz");
  const width = px(num(attr(size, "cx"), 9144000));
  const height = px(num(attr(size, "cy"), 5143500));
  const defaults = kid(root, "defaultTextStyle");
  const rels = pkg.relsOf(main);
  const media: PptxDeck["media"] = {};
  const masters = new Map<string, Master>();
  const layouts = new Map<string, Layout>();

  const masterAt = (path: string): Master | null => {
    const known = masters.get(path);
    if (known) return known;
    const part = partOf(pkg, path);
    if (!part) return null;
    const themeRel = pkg.relOfType(path, "/theme");
    const master: Master = { ...part, map: readMap(kid(part.root, "clrMap")), theme: readTheme(themeRel ? pkg.xml(themeRel.target) : null), txStyles: kid(part.root, "txStyles") };
    masters.set(path, master);
    return master;
  };
  const layoutAt = (path: string): Layout | null => {
    const known = layouts.get(path);
    if (known) return known;
    const part = partOf(pkg, path);
    const masterRel = pkg.relOfType(path, "/slideMaster");
    const master = masterRel ? masterAt(masterRel.target) : null;
    if (!part || !master) return null;
    const layout: Layout = { ...part, master };
    layouts.set(path, layout);
    return layout;
  };

  const ids = kids(kid(root, "sldIdLst"), "sldId");
  const slides: PptxSlide[] = [];
  ids.forEach((entry, index) => {
    const rel = rels.get(rid(entry, "id") ?? "");
    if (!rel || rel.external) return;
    const slide = partOf(pkg, rel.target);
    if (!slide) return;
    const layoutRel = pkg.relOfType(rel.target, "/slideLayout");
    const layout = layoutRel ? layoutAt(layoutRel.target) : null;
    const master = layout?.master ?? masterAt([...masters.keys()][0] ?? "") ?? null;
    if (!master) return;
    const override = at(slide.root, "clrMapOvr", "overrideClrMapping");
    const map = override ? readMap(override) : master.map;
    const ctx: ColorCtx = { theme: master.theme.colors, map };
    const base = { pkg, ctx, theme: master.theme, textColor: schemeColor("tx1", ctx), layout, master, defaults, slideNumber: index + 1, media };
    const scopeFor = (part: Part): Scope => ({ ...base, part });
    const shapes: PptxShape[] = [];
    const showMaster = attr(slide.root, "showMasterSp") !== "0";
    if (showMaster && layout) {
      if (attr(layout.root, "showMasterSp") !== "0" && master.tree) readTree(master.tree, { ...scopeFor(master), layout: null }, identity, "template", shapes);
      if (layout.tree) readTree(layout.tree, scopeFor(layout), identity, "template", shapes);
    }
    if (slide.tree) readTree(slide.tree, scopeFor(slide), identity, "slide", shapes);
    const background = readBackground(slide, scopeFor(slide)) ?? (layout ? readBackground(layout, scopeFor(layout)) : undefined) ?? readBackground(master, scopeFor(master)) ?? { color: "#ffffff" };
    slides.push({ number: index + 1, hidden: attr(slide.root, "show") === "0", background, shapes });
  });
  return { width, height, slides, media };
}
