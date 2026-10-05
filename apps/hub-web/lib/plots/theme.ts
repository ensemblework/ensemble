"use client";

import { useEffect, useState } from "react";
import { seriesColor, type PlotConfig } from "@ensemble/shared-types";
import type { PlotTheme } from "@/lib/plots/option";

export function readPlotTheme(): PlotTheme {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    ink: pick("--ink", "#1c1915"),
    muted: pick("--muted", "#6d675e"),
    line: pick("--line", "#e4ddd2"),
    panel: pick("--panel", "#fffcf7"),
    accent: pick("--accent", "#5346d6"),
    dark: document.documentElement.dataset.theme !== "light",
  };
}

/** Theme colours read after mount, so swatches show what the chart draws (and SSR does not touch the DOM). */
export function usePlotTheme() {
  const [theme, setTheme] = useState(() => ({ accent: "#5346d6", dark: false }));
  useEffect(() => {
    const read = () => {
      const next = readPlotTheme();
      setTheme((prev) => (prev.accent === next.accent && prev.dark === next.dark ? prev : { accent: next.accent, dark: next.dark }));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class", "data-accent"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** `#rrggbb` for a colour input. Falls back when the value is not a plain hex colour. */
export function hexColor(value: string | null | undefined, fallback = "#5346d6"): string {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
  return fallback;
}

/** The colour the chart draws for series `index`, using the same rule as the series loop below. */
export function seriesSwatchColor(config: Pick<PlotConfig, "palette" | "series" | "colors">, index: number, theme: Pick<PlotTheme, "accent" | "dark">): string {
  const encoding = config.series[index];
  const explicit = encoding?.color || (encoding ? config.colors?.[encoding.y] : undefined);
  const color = seriesColor({
    palette: config.palette,
    accent: theme.accent,
    dark: theme.dark,
    count: config.series.length,
    index,
    explicit,
  });
  return hexColor(color, color);
}
