import type { AppColorTheme } from "@ensemble/shared-types";

export type ColorMode = "light" | "dark";
export type SurfacePalette = { bg: string; sidebar: string; panel: string; raised: string; tile: string; ink: string; muted: string; faint: string };
type ColorTheme = { id: AppColorTheme; name: string; description: string; detail: string; light: SurfacePalette; dark: SurfacePalette; artwork?: string; colorful?: boolean };

export const COLOR_THEMES: readonly ColorTheme[] = [
  { id: "ensemble", name: "Ensemble · Deep Petrol", description: "Satin Gold on deep, cool color.", detail: "Warm paper / deep petrol",
    light: { bg: "#f4f1ea", sidebar: "#ebe6dc", panel: "#fffcf7", raised: "#f7f3ec", tile: "#fffdf9", ink: "#1c1915", muted: "#5a534c", faint: "#3f3a34" },
    dark: { bg: "#10282b", sidebar: "#0d2225", panel: "#173236", raised: "#213e42", tile: "#163034", ink: "#f2f0e9", muted: "#aec3bf", faint: "#91b1ae" } },
  { id: "aubergine", name: "Smoked Aubergine", description: "A warmer setting for Satin Gold.", detail: "Soft parchment / smoked aubergine",
    light: { bg: "#f4f1ea", sidebar: "#ebe6dc", panel: "#fffcf7", raised: "#f7f3ec", tile: "#fffdf9", ink: "#1c1915", muted: "#5a534c", faint: "#62594e" },
    dark: { bg: "#231b2a", sidebar: "#1d1624", panel: "#2d2335", raised: "#392d40", tile: "#291f31", ink: "#f4eee9", muted: "#c1b0c5", faint: "#b29cba" } },
  { id: "graphite", name: "Graphite", description: "Clear lines. A quiet place to focus.", detail: "Porcelain / graphite",
    light: { bg: "#f4f6f8", sidebar: "#e9edf2", panel: "#ffffff", raised: "#edf0f4", tile: "#ffffff", ink: "#18212f", muted: "#48556a", faint: "#596477" },
    dark: { bg: "#11151b", sidebar: "#171c24", panel: "#202630", raised: "#292f39", tile: "#1b212a", ink: "#f2f4f8", muted: "#b0bac9", faint: "#92a0b2" } },
  { id: "lagoon", name: "Lagoon", description: "Cool water, with room to breathe.", detail: "Sea glass / deep teal", artwork: "lagoon",
    light: { bg: "#eef7f5", sidebar: "#dbece8", panel: "#fbfefc", raised: "#e7f2ef", tile: "#fbfefc", ink: "#153a3e", muted: "#3b5b60", faint: "#496267" },
    dark: { bg: "#0c1b20", sidebar: "#11262c", panel: "#1a3036", raised: "#243c42", tile: "#162c32", ink: "#e7f5f2", muted: "#b0cac9", faint: "#9db9b8" } },
  { id: "aurora", name: "Aurora", description: "A little color, a little possibility.", detail: "Lavender mist / violet dusk", colorful: true,
    light: { bg: "#f6f3fb", sidebar: "#e9e2f3", panel: "#fffcff", raised: "#eee8f6", tile: "#fffcff", ink: "#30253f", muted: "#5b4b6e", faint: "#675b7c" },
    dark: { bg: "#191626", sidebar: "#211b31", panel: "#2a233b", raised: "#332b46", tile: "#251f35", ink: "#f3eefa", muted: "#c6b8dc", faint: "#b0a1c8" } },
  { id: "juniper", name: "Juniper", description: "A fresh page, with a softer edge.", detail: "Linen and sage / forest ink", artwork: "juniper",
    light: { bg: "#f4f5ec", sidebar: "#e5eadc", panel: "#fdfef6", raised: "#ecf0e4", tile: "#fdfef6", ink: "#28372a", muted: "#4c5c46", faint: "#59654f" },
    dark: { bg: "#18201c", sidebar: "#1d2a22", panel: "#28362c", raised: "#314035", tile: "#233128", ink: "#eef3e8", muted: "#c3cfb9", faint: "#acbea4" } },
  { id: "blueprint", name: "Blueprint", description: "For the next thing you will build.", detail: "Cloud paper / midnight blue", artwork: "blueprint",
    light: { bg: "#f0f5fc", sidebar: "#e2ebf6", panel: "#fcfdff", raised: "#eaf1fa", tile: "#fcfdff", ink: "#1d304b", muted: "#425a77", faint: "#526780" },
    dark: { bg: "#111b2c", sidebar: "#162338", panel: "#1e2e46", raised: "#293b55", tile: "#1a293f", ink: "#eaf2ff", muted: "#b5c9e4", faint: "#9fb6d3" } },
];

export function colorTheme(id: unknown): ColorTheme { return COLOR_THEMES.find((theme) => theme.id === id) ?? COLOR_THEMES[0]!; }
export function colorThemeSurfaces(id: unknown, mode: ColorMode): string[] | undefined {
  const theme = colorTheme(id);
  const palette = theme[mode];
  return [palette.bg, palette.sidebar, palette.panel, palette.raised, palette.tile];
}
const rgb = (hex: string) => `${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`;

/** Shared by the app palette and miniature previews; accents stay independent. */
export function colorThemeTokens(theme: ColorTheme, mode: ColorMode): Record<string, string> {
  const palette = theme[mode];
  const dark = mode === "dark";
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) { tokens[`--${key}`] = value; tokens[`--${key}-rgb`] = rgb(value); }
  Object.assign(tokens, {
    "--ink-2": palette.ink, "--ghost": palette.faint,
    "--hover": `rgb(${rgb(palette.ink)} / ${dark ? ".055" : ".045"})`,
    "--line": `rgb(${rgb(palette.ink)} / .10)`,
    "--line-strong": `rgb(${rgb(palette.ink)} / ${dark ? ".19" : ".18"})`,
    "--tile-hover": `rgb(${rgb(palette.ink)} / .25)`, "--tile-top": `rgb(${rgb(palette.ink)} / .025)`,
    "--edge": palette.faint, "--scrollbar": `rgb(${rgb(palette.ink)} / .2)`,
    "--brand-you": palette.ink, "--brand-word": palette.ink,
    "--diagram-line": palette.muted, "--diagram-dot": palette.raised, "--diagram-paper": palette.bg,
    "--elev-1": dark ? "0 1px 0 rgb(255 255 255 / .035), 0 8px 24px rgb(0 0 0 / .16)" : "0 1px 0 rgb(255 255 255 / .7), 0 8px 24px rgb(0 0 0 / .045)",
    "--elev-2": `0 16px 44px rgb(0 0 0 / ${dark ? ".36" : ".12"})`,
    "--elev-tile": dark ? "inset 0 1px 0 rgb(255 255 255 / .035), 0 12px 28px -22px rgb(0 0 0 / .6)" : "inset 0 1px 0 rgb(255 255 255 / .8), 0 10px 26px -22px rgb(0 0 0 / .18)",
    "--theme-canvas-image": theme.artwork ? `url('/themes/${theme.artwork}.svg')` : theme.colorful ? `radial-gradient(ellipse at 100% 0%, rgb(152 114 221 / ${dark ? ".12" : ".09"}), transparent 60%), radial-gradient(ellipse at 0% 100%, rgb(83 175 188 / ${dark ? ".08" : ".065"}), transparent 60%)` : "none",
    "--theme-canvas-blend": theme.artwork ? "difference" : "normal",
    // Gradients cover the whole canvas: in a smaller tile, a glow centred on the tile's inner corner would end in a hard edge mid-page.
    "--theme-canvas-size": theme.artwork === "juniper" ? "540px 540px" : !theme.artwork && theme.colorful ? "100% 100%" : "900px 600px",
  });
  return tokens;
}

/** Static CSS at the document root also paints a saved palette before hydration. */
export const COLOR_THEME_STYLES = COLOR_THEMES.flatMap((theme) => (["dark", "light"] as const).map((mode) => `:root[data-color-theme="${theme.id}"][data-theme="${mode}"]{${Object.entries(colorThemeTokens(theme, mode)).map(([key, value]) => `${key}:${value}`).join(";")}}`)).join("\n");
