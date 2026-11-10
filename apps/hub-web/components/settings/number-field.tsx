"use client";

import { useEffect, useId, useState } from "react";

/** Why a typed number is refused, or null. */
export function rangeProblem(text: string, min: number, max: number): string | null {
  if (!text.trim()) return `Enter a number from ${min} to ${max}.`;
  const value = Number(text);
  if (!Number.isInteger(value)) return `Use a whole number from ${min} to ${max}.`;
  if (value < min || value > max) return `Use a number from ${min} to ${max}.`;
  return null;
}

/**
 * A whole-number setting: one box with the unit inside, the same width as the selects beside it, so a
 * column of settings lines up. The allowed range is its tooltip and the error; a value outside it stays on
 * screen with that error and is not saved, instead of snapping back.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
  width = "w-32",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
  width?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // A value saved elsewhere (another tab, a refused save) replaces what is shown, unless the person is mid-correction.
    if (!error) setText(String(value));
  }, [value, error]);
  return (
    <span className="inline-flex max-w-full flex-col items-end gap-1">
      <span className={`field compound-field inline-flex items-center gap-1.5 ${width}`} title={`${min} to ${max}`} data-invalid={error ? true : undefined}>
        <input
          aria-label={label}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-range${error ? ` ${id}-error` : ""}`}
          onChange={(event) => {
            setText(event.target.value);
            const problem = rangeProblem(event.target.value, min, max);
            setError(problem);
            if (!problem) onChange(Number(event.target.value));
          }}
          className="min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none"
        />
        {unit ? <span className="shrink-0 text-faint">{unit}</span> : null}
      </span>
      <span id={`${id}-range`} className="sr-only">
        {min}–{max}
      </span>
      {error ? (
        <span id={`${id}-error`} role="alert" className="max-w-[16rem] text-right text-[12px] text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
