"use client";

import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One kanban column, shared by the Ensemble board and custom boards: header with name and count,
 * the cards, an empty hint, a "New …" row, and a drop zone taller than the cards so a short
 * column still takes a drop.
 */
export function BoardColumn({
  id,
  label,
  name,
  count,
  over,
  empty,
  createLabel,
  onCreate,
  disabled = false,
  footer,
  children,
}: {
  id: string;
  /** What the header shows: plain text, or a coloured dot and a name. */
  label: ReactNode;
  /** The column's name for screen readers and the + button. */
  name: string;
  count: number;
  /** Another column is the drop target. "deny" is reserved for a column that refuses the card. */
  over?: "yes" | "deny";
  /** Shown when the column has no cards. */
  empty?: ReactNode;
  /** "New task", "New page". */
  createLabel: string;
  onCreate?: () => void;
  disabled?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id, disabled });
  return (
    <div className="relative w-[272px] shrink-0 self-start" data-column={id} role="region" aria-label={name}>
      <div className="board-column flex flex-col rounded-lg bg-panel/70 p-2" data-empty={count === 0}>
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]">{label}</span>
            <span className="bdg-n text-[12px] tabular-nums text-muted">{count}</span>
          </div>
          {onCreate ? (
            <button type="button" className="icon-btn h-6 w-6 shrink-0" title={`${createLabel} in this column`} aria-label={`${createLabel} in ${name}`} disabled={disabled} onClick={onCreate}>
              <Plus size={14} />
            </button>
          ) : null}
        </div>
        <div className="flex min-h-[60px] flex-col gap-1.5 rounded-lg p-1">
          {count === 0 && empty ? <div className="board-column-empty">{empty}</div> : null}
          {children}
          {onCreate ? (
            <button type="button" onClick={onCreate} disabled={disabled} className="row-tile flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted">
              <Plus size={13} />
              {createLabel}
            </button>
          ) : null}
          {footer}
        </div>
      </div>
      <div
        ref={setNodeRef}
        data-bdg-list=""
        data-over={over}
        className="pointer-events-none"
        style={{ position: "absolute", left: 0, right: 0, top: 0, height: "max(100%, 240px)" }}
      />
    </div>
  );
}
