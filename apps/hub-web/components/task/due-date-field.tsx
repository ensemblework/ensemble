"use client";

import { useEffect, useId, useState } from "react";
import { isoDate } from "@/lib/format";
import { dueDateProblem } from "@/lib/due-date";
import { DateInput } from "../date-time";

/**
 * The task's due date, picked or typed in Ensemble's own calendar. Only a whole date in range is
 * saved; anything else stays out of the board with an inline error.
 */
export function DueDateField({ due, onSave }: { due: string | null; onSave: (due: string | null) => void }) {
  const saved = due ? isoDate(new Date(due)) : "";
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => setError(null), [saved]);

  return (
    <span className="flex flex-col gap-0.5">
      <DateInput
        look="inline"
        label="Due date"
        placeholder="Add a due date"
        min="1900-01-01"
        max="2200-12-31"
        value={saved}
        invalid={Boolean(error)}
        describedBy={error ? errorId : undefined}
        onChange={(value) => {
          const problem = dueDateProblem(value);
          setError(problem);
          if (problem || value === saved) return;
          onSave(value ? new Date(`${value}T17:00:00`).toISOString() : null);
        }}
      />
      {error ? (
        <span id={errorId} role="alert" className="text-[12px] text-[color:var(--tag-red-fg)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
