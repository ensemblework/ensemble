"use client";

/**
 * A node's face as Ensemble Node draws it (its `{ shape, color, eyes }`): the same shapes, gradient and
 * eyes, without Node's GSAP scenes. It blinks now and then, hops when its row is pointed at
 * (`.node-face-row`), and rests with closed eyes while the node is paused. CSS in app/globals.css.
 */
import { useId } from "react";
import type { NodeLook } from "@/lib/api";

const SHAPES: Record<string, string> = {
  orb: "M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88z",
  square: "M22 8h56a14 14 0 0 1 14 14v56a14 14 0 0 1-14 14H22A14 14 0 0 1 8 78V22A14 14 0 0 1 22 8z",
  spark: "M50 4l11 24 25-6-14 22 20 18-26 3 2 26-18-18-18 18 2-26-26-3 20-18-14-22 25 6z",
  hex: "M50 5l39 22v46L50 95 11 73V27z",
  leaf: "M50 6c30 8 44 30 40 58-3 20-20 32-40 32S13 84 10 64C6 36 20 14 50 6z",
  compass: "M50 4l14 32 32 14-32 14-14 32-14-32L4 50l32-14z",
  pebble: "M50 8C77 4 95 25 92 52C89 80 74 94 48 92C20 90 5 75 8 49C10 25 26 11 50 8Z",
  bloom: "M50 10C63-2 82 10 80 27C99 27 104 49 89 59C99 77 82 95 66 86C57 104 34 100 31 82C12 88-1 67 11 53C-3 38 11 18 28 23C29 8 40 2 50 10Z",
};

/** Where the eyes sit on each shape: the face's centre, half the distance between the eyes, their scale. */
const FACES: Record<string, { x: number; y: number; gap: number; scale: number }> = {
  orb: { x: 50, y: 48, gap: 11, scale: 1 },
  square: { x: 50, y: 48, gap: 11, scale: 1 },
  spark: { x: 50, y: 50, gap: 9, scale: 0.85 },
  hex: { x: 50, y: 50, gap: 11, scale: 1 },
  leaf: { x: 50, y: 55, gap: 11, scale: 1 },
  compass: { x: 50, y: 50, gap: 8, scale: 0.66 },
  pebble: { x: 50, y: 49, gap: 11, scale: 1 },
  bloom: { x: 50, y: 51, gap: 10, scale: 0.9 },
};

const DEFAULT_COLOR = "#D7B56F";

type Rgb = [number, number, number];
const parse = (color: string | undefined): Rgb | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec((color ?? "").trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const hex = (rgb: Rgb) => `#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
const mix = (rgb: Rgb, target: number, amount: number): Rgb => rgb.map((part) => Math.round(part + (target - part) * amount)) as Rgb;
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((part) => {
    const c = part / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function NodeFace({ look, size = 16, paused = false }: { look?: NodeLook | null; size?: number; paused?: boolean }) {
  const id = `face-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const shape = look?.shape && SHAPES[look.shape] ? look.shape : "orb";
  const rgb = parse(look?.color) ?? parse(DEFAULT_COLOR)!;
  const eyesColor = luminance(rgb) > 0.179 ? "#14110C" : "#FBF8F1";
  const { x, y, gap, scale } = FACES[shape]!;
  const eyes = paused ? "line" : look?.eyes === "line" || look?.eyes === "wide" ? look.eyes : "dot";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className="node-face shrink-0" data-paused={paused || undefined}>
      <defs>
        <radialGradient id={id} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={hex(mix(rgb, 255, 0.5))} />
          <stop offset="0.42" stopColor={hex(rgb)} />
          <stop offset="1" stopColor={hex(mix(rgb, 0, 0.1))} />
        </radialGradient>
      </defs>
      <g className="node-face-body">
        <path d={SHAPES[shape]} fill={`url(#${id})`} stroke={hex(mix(rgb, 0, 0.3))} strokeWidth="3" strokeLinejoin="round" />
        <g className="node-face-eyes" fill={eyesColor}>
          {eyes === "line" ? (
            [-1, 1].map((side) => <rect key={side} x={x + side * (gap + scale) - 7 * scale} y={y + 1.5 * scale - 2.5 * scale} width={14 * scale} height={5 * scale} rx={2.5 * scale} />)
          ) : eyes === "wide" ? (
            [-1, 1].map((side) => <ellipse key={side} cx={x + side * (gap + scale)} cy={y} rx={7 * scale} ry={9 * scale} />)
          ) : (
            [-1, 1].map((side) => <circle key={side} cx={x + side * gap} cy={y} r={6.5 * scale} />)
          )}
        </g>
      </g>
    </svg>
  );
}
