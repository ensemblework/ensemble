"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Check } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import type { AppDoodle } from "@ensemble/shared-types";

/** In the order shown: the theme's own artwork, none, then the twelve doodles in public/doodles/. */
export const DOODLE_CHOICES: Array<{ id: AppDoodle; name: string }> = [
  { id: "theme", name: "Theme's own" },
  { id: "none", name: "Plain" },
  { id: "constellation", name: "Constellations" },
  { id: "orbits", name: "Orbits" },
  { id: "galaxy", name: "Galaxy" },
  { id: "stardust", name: "Stardust" },
  { id: "ripples", name: "Ripples" },
  { id: "network", name: "Network" },
  { id: "contours", name: "Contours" },
  { id: "waves", name: "Waves" },
  { id: "weave", name: "Weave" },
  { id: "dots", name: "Dot grid" },
  { id: "circuits", name: "Circuits" },
  { id: "graph", name: "Graph paper" },
];

function preview(id: AppDoodle): CSSProperties {
  if (id === "none") return {};
  if (id === "theme") return { backgroundImage: "var(--theme-canvas-image, none)", backgroundSize: "auto 220%", backgroundPosition: "right top", backgroundRepeat: "no-repeat", backgroundBlendMode: "var(--theme-canvas-blend, normal)" as CSSProperties["backgroundBlendMode"] };
  // Shown at a little under half size, centred on the pattern, and drawn three times over so it reads at swatch size.
  const layer = `url("/doodles/${id}.svg")`;
  return { backgroundImage: [layer, layer, layer].join(", "), backgroundSize: "210px 210px", backgroundPosition: "center", backgroundBlendMode: "difference" };
}

/** Settings → Appearance → Doodle: a faint pattern behind the work area, drawn in the theme's own colours. */
export function DoodlePicker({ value, onChange }: { value: AppDoodle; onChange: (id: AppDoodle) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, DOODLE_CHOICES.findIndex((choice) => choice.id === value));
  const choose = (index: number) => {
    const next = DOODLE_CHOICES[(index + DOODLE_CHOICES.length) % DOODLE_CHOICES.length]!;
    onChange(next.id);
    group.current?.querySelector<HTMLButtonElement>(`[data-doodle-option="${next.id}"]`)?.focus({ preventScroll: true });
  };
  return (
    <div className="doodle-section" data-jump-label="Doodle">
      <div className="doodle-heading">
        <h3>Doodle</h3>
        <p>A faint pattern behind your work, in the theme&apos;s own colours.</p>
      </div>
      <div ref={group} className="doodle-grid" role="radiogroup" aria-label="Doodle">
        {DOODLE_CHOICES.map((choice, index) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={index === selected}
            tabIndex={index === selected ? 0 : -1}
            data-doodle-option={choice.id}
            onClick={() => onChange(choice.id)}
            onKeyDown={(event) => {
              const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (!delta && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              choose(event.key === "Home" ? 0 : event.key === "End" ? DOODLE_CHOICES.length - 1 : index + delta);
            }}
          >
            <span className="doodle-swatch" style={preview(choice.id)} aria-hidden />
            <span className="doodle-name">
              {choice.name}
              {index === selected ? <Check size={12} aria-hidden /> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
