import type { PaletteColor, ShapeId } from "./model.js";

export type DiagramTheme = "light" | "dark";

export interface Paint {
  fill: string;
  stroke: string;
  text: string;
}

/**
 * Soft fill, a stronger border, and text that stays readable on that fill.
 * Light pastels follow Eraser's pastel mode and Excalidraw's swatches.
 * Dark uses the same names with deeper fills so a diagram can sit on either theme.
 */
export const PALETTE: Record<DiagramTheme, Record<PaletteColor, Paint>> = {
  light: {
    slate: { fill: "#f3f0ea", stroke: "#8d867c", text: "#3c3832" },
    red: { fill: "#fde2e0", stroke: "#e15b52", text: "#8d2e28" },
    orange: { fill: "#ffe8d2", stroke: "#e07a2a", text: "#8a4510" },
    amber: { fill: "#fef3c7", stroke: "#d09a12", text: "#7a5b10" },
    green: { fill: "#d9f5e5", stroke: "#2f9e64", text: "#14663e" },
    teal: { fill: "#d4f4f4", stroke: "#1a9696", text: "#0e5e5e" },
    blue: { fill: "#dbeafe", stroke: "#3b82c4", text: "#1e4f91" },
    indigo: { fill: "#e6e4fb", stroke: "#6d63d4", text: "#3d348f" },
    purple: { fill: "#f3e8ff", stroke: "#a855c4", text: "#6b2d8b" },
    pink: { fill: "#fce7f1", stroke: "#db6b96", text: "#8d2d58" },
  },
  dark: {
    slate: { fill: "#2a2622", stroke: "#b7aea3", text: "#f4efe8" },
    red: { fill: "#3a2422", stroke: "#f0a39c", text: "#ffd7d3" },
    orange: { fill: "#3a2a1c", stroke: "#f0b27a", text: "#ffe3c4" },
    amber: { fill: "#3a3218", stroke: "#e6c15a", text: "#ffe9ad" },
    green: { fill: "#1c3328", stroke: "#7dcea0", text: "#d5f5e3" },
    teal: { fill: "#163333", stroke: "#7dcece", text: "#d2f4f4" },
    blue: { fill: "#1c2c42", stroke: "#8eb6e8", text: "#d6e7fb" },
    indigo: { fill: "#262448", stroke: "#b4adf0", text: "#e4e1fb" },
    purple: { fill: "#2e2238", stroke: "#d7a8ea", text: "#f3e4fb" },
    pink: { fill: "#3a2430", stroke: "#f0a8c4", text: "#fde4ef" },
  },
};

/** Which palette colour a shape wears when the text does not set `color`. */
export const SHAPE_COLOR: Record<ShapeId, PaletteColor> = {
  rectangle: "blue",
  rounded: "blue",
  parallelogram: "blue",
  trapezoid: "orange",
  diamond: "amber",
  circle: "green",
  ellipse: "green",
  cylinder: "teal",
  server: "indigo",
  triangle: "orange",
  document: "amber",
  note: "amber",
  cloud: "purple",
  actor: "pink",
  hexagon: "red",
};

export const DIAGRAM_PAPER: Record<DiagramTheme, string> = {
  light: "#f6f3ee",
  dark: "#161411",
};

export const DIAGRAM_LINE: Record<DiagramTheme, string> = {
  light: "#5e584f",
  dark: "#c9c2b8",
};

export const DIAGRAM_DOT: Record<DiagramTheme, string> = {
  light: "#e3dcd2",
  dark: "#3a342e",
};

function expandHex(value: string): string | null {
  const match = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const body = match[0].slice(1);
  const full = body.length === 3 ? body.split("").map((char) => char + char).join("") : body;
  return `#${full.toLowerCase()}`;
}

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mix(hex: string, toward: number, amount: number): string {
  const parts = [0, 1, 2].map((index) => {
    const value = Math.round(channel(hex, index) + (toward - channel(hex, index)) * amount);
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  });
  return `#${parts.join("")}`;
}

function paintHex(hex: string, theme: DiagramTheme): Paint {
  const lum = (0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)) / 255;
  if (theme === "dark") {
    const fill = lum > 0.45 ? mix(hex, 24, 0.72) : mix(hex, 12, 0.35);
    return { fill, stroke: mix(hex, 255, 0.45), text: "#f7f4ef" };
  }
  return {
    fill: lum > 0.85 ? mix(hex, 255, 0.35) : mix(hex, 255, 0.72),
    stroke: mix(hex, 0, lum > 0.6 ? 0.35 : 0.1),
    text: mix(hex, 0, 0.55),
  };
}

/** Colour for a block. A named `color` or hex wins. Otherwise the shape's own default is used. */
export function paintFor(shape: ShapeId, color: string | null, theme: DiagramTheme): Paint {
  const named = color?.trim().toLowerCase();
  if (named && named in PALETTE[theme]) return PALETTE[theme][named as PaletteColor];
  if (color) {
    const hex = expandHex(color);
    if (hex) return paintHex(hex, theme);
  }
  return PALETTE[theme][SHAPE_COLOR[shape]];
}
