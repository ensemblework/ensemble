"use client";

import type { CSSProperties } from "react";
import { cx } from "../ui";

/**
 * How hard the model thinks, as one slider from its lowest level to its highest, the way Claude and
 * ChatGPT show it. The track warms from cool to hot as it slides up. Auto (the model's own default)
 * stays a separate choice beside it, shown only where the model has one. Each level's name under the
 * track is a radio too, so a click or the keyboard picks it directly.
 */
export function ThinkingSlider({
  label,
  levels,
  value,
  onChange,
  auto,
  autoLevel,
}: {
  label: string;
  levels: ReadonlyArray<{ id: string; text: string }>;
  value: string;
  onChange: (id: string) => void;
  /** The Auto choice's text, when the model has one ("Auto (Medium)"); none leaves it out. */
  auto?: string | null;
  /** Where the thumb rests while Auto is on: the model's default level. */
  autoLevel?: string | null;
}) {
  const isAuto = value === "default";
  const at = levels.findIndex((level) => level.id === (isAuto ? autoLevel : value));
  const index = at >= 0 ? at : 0;
  const span = Math.max(1, levels.length - 1);
  const position = (index / span) * 100;
  const style = { "--think-pos": `${position}%` } as CSSProperties;
  if (levels.length < 2) {
    return (
      <div role="radiogroup" aria-label={label} className="thinking-levels">
        {[...(auto ? [{ id: "default", text: auto }] : []), ...levels].map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={value === option.id} onClick={() => onChange(option.id)} className={cx("thinking-level", value === option.id && "is-on")}>
            {option.text}
          </button>
        ))}
      </div>
    );
  }
  const now = isAuto && auto ? auto : levels[index]?.text ?? "";
  return (
    <div role="radiogroup" aria-label={label} className={cx("thinking-slider", isAuto && "is-auto")} style={style}>
      <div className="thinking-head">
        {auto ? (
          <button type="button" role="radio" aria-checked={isAuto} onClick={() => onChange(isAuto ? (autoLevel && levels.some((level) => level.id === autoLevel) ? autoLevel : levels[index]!.id) : "default")} className={cx("thinking-auto", isAuto && "is-on")} title="Let the model choose">
            {auto}
          </button>
        ) : null}
        <span className="thinking-now" aria-hidden>{now}</span>
      </div>
      <div className="thinking-rail">
        <input
          type="range"
          min={0}
          max={levels.length - 1}
          step={1}
          value={index}
          aria-label={`${label}: level`}
          aria-valuetext={now}
          onChange={(event) => onChange(levels[Number(event.target.value)]?.id ?? levels[0]!.id)}
          className="thinking-track"
        />
        {levels.map((level, at) => (
          <button
            key={level.id}
            type="button"
            role="radio"
            aria-checked={value === level.id}
            tabIndex={-1}
            onClick={() => onChange(level.id)}
            className={cx("thinking-stop", at <= index && !isAuto && "is-past", value === level.id && "is-on")}
            style={{ left: `${(at / span) * 100}%` }}
            title={level.text}
          >
            <span className="sr-only">{level.text}</span>
          </button>
        ))}
      </div>
      <div className="thinking-ends" aria-hidden>
        <span>{levels[0]!.text}</span>
        <span>{levels[levels.length - 1]!.text}</span>
      </div>
    </div>
  );
}
