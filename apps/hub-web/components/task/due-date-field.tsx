"use client";

import { useEffect, useId, useState } from "react";
import { isoDate } from "@/lib/format";
import { dueDateProblem } from "@/lib/due-date";
import { cx } from "../ui";

/**
 * The task's due date. Only a whole date in range is saved; a slip such as year 0201
 * stays in the field with an inline error instead of reaching the board.
 */
export function DueDateField({ due, onSave }: { due: string | null; onSave: (due: string | null) => void }) {
  const saved = due ? isoDate(new Date(due)) : "";
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const check = (value: string, partial: boolean) => (partial ? "Finish the date or clear it." : dueDateProblem(value));

  return (
    <span className="flex flex-col gap-0.5">
      <input
        type="date"
        aria-label="Due date"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        min="1900-01-01"
        max="2200-12-31"
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          // An empty value with badInput is a half-typed date, not a cleared one.
          const partial = !value && event.target.validity.badInput;
          setDraft(value);
          const problem = check(value, partial);
          if (problem) return;
          setError(null);
          if (value !== saved) onSave(value ? new Date(`${value}T17:00:00`).toISOString() : null);
        }}
        onBlur={(event) => setError(check(event.target.value, !event.target.value && event.target.validity.badInput))}
        className={cx(
          "row-tile -mx-1.5 rounded bg-transparent px-1.5 py-0.5 text-[13.5px] outline-none",
          !draft && "text-faint",
          error && "ring-1 ring-danger",
        )}
      />
      {error ? (
        <span id={errorId} role="alert" className="text-[12px] text-[color:var(--tag-red-fg)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
