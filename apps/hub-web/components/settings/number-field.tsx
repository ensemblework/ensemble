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
 * A whole-number setting that shows its allowed range. A value outside it stays on screen with
 * an error and is not saved, instead of snapping back.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
  width = "w-20",
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
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
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
        className={`field text-right ${width}`}
      />
      {unit ? <span>{unit}</span> : null}
      <span id={`${id}-range`} className="text-[12px] text-faint">
        {min}–{max}
      </span>
      {error ? (
        <span id={`${id}-error`} role="alert" className="basis-full text-[12px] text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
