"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PoolColumn } from "@ensemble/shared-types";
import { Popover } from "@/components/ui";

type Column = Pick<PoolColumn, "id" | "name" | "type"> & { source?: string | null };
type Axis = "left" | "right";

function chipText(column: Column, columns: Column[]): string {
  const shared = columns.filter((item) => item.name === column.name).length > 1;
  return shared && column.source ? `${column.name} · ${column.source}` : column.name;
}

/** Fixed-height chips. Extras collapse to “+N more” so the rows below do not move. */
function ChipField({ chosen, columns, onRemove }: { chosen: Column[]; columns: Column[]; onRemove: (id: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [limit, setLimit] = useState(chosen.length);
  const signature = chosen.map((column) => column.id).join("\u001f");
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fit = () => {
      const chips = [...node.querySelectorAll<HTMLElement>("[data-chip-measure]")];
      if (chips.length <= 1) {
        setLimit(chips.length);
        return;
      }
      const max = node.clientWidth;
      let used = 0;
      let count = chips.length;
      for (let index = 0; index < chips.length; index += 1) {
        const width = chips[index]!.offsetWidth + 4;
        const rest = chips.length - index - 1;
        if (used + width + (rest > 0 ? 76 : 0) > max) {
          count = index;
          break;
        }
        used += width;
      }
      const next = Math.max(1, count);
      setLimit((prev) => (prev === next ? prev : next));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [signature]);
  const shown = chosen.slice(0, limit);
  const hidden = chosen.length - shown.length;
  // The remove hit target is inset from the left. On a narrow field the mark
  // sits on the middle, and a click there should open the menu.
  const chip = (column: Column, measure: boolean) => (
    <span key={column.id} data-chip-measure={measure ? "" : undefined} data-chip={measure ? undefined : ""} className="pointer-events-none relative z-[1] inline-flex h-6 max-w-[9rem] shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-[12px] text-ink">
      <span className="truncate">{chipText(column, columns)}</span>
      {measure ? (
        <span className="text-muted">×</span>
      ) : (
        <button
          type="button"
          aria-label={`Remove ${column.name}`}
          className="series-remove pointer-events-none relative z-[1] border-0 bg-transparent p-0 text-[12px] leading-none text-muted after:pointer-events-auto after:absolute after:bottom-[-6px] after:left-1 after:right-[-6px] after:top-[-6px] after:content-['']"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(column.id);
          }}
        >
          ×
        </button>
      )}
    </span>
  );
  return (
    <span ref={ref} className="pointer-events-none relative z-[1] flex h-6 min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <span className="pointer-events-none invisible absolute left-0 top-0 flex gap-1" aria-hidden>
        {chosen.map((column) => chip(column, true))}
      </span>
      {shown.map((column) => chip(column, false))}
      {hidden > 0 ? <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-accent-soft px-2 text-[12px] text-ink">+{hidden} more</span> : null}
    </span>
  );
}

const AXIS_SIDES: Axis[] = ["left", "right"];

/** One series, with a Left/Right choice that is not nested inside the option list. */
function AxisChip({
  label,
  axis,
  onChange,
}: {
  label: string;
  axis: Axis;
  onChange: (axis: Axis) => void;
}) {
  const buttons = useRef<Partial<Record<Axis, HTMLButtonElement | null>>>({});
  const choose = (side: Axis) => {
    onChange(side);
    buttons.current[side]?.focus();
  };
  return (
    <div data-series-chip="" className="series-axis-chip inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full bg-accent-soft py-px pl-1.5 pr-0.5 text-[12px] text-ink">
      <span
        className="series-axis-pip h-2 w-2 shrink-0 rounded-full"
        style={{ background: axis === "right" ? "var(--kind-artifact)" : "var(--accent)" }}
        aria-hidden
      />
      <span className="min-w-0 max-w-[10rem] truncate" title={label}>
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={`${label} axis`}
        aria-orientation="horizontal"
        className="inline-flex shrink-0 rounded-full bg-raised p-px"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            choose("left");
          } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            choose("right");
          }
        }}
      >
        {AXIS_SIDES.map((side) => {
          const on = axis === side;
          return (
            <button
              key={side}
              ref={(node) => {
                buttons.current[side] = node;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={`rounded-full px-1.5 py-0.5 text-[11px] leading-4 ${on ? "bg-accent font-medium text-[var(--accent-fg)] shadow-sm" : "text-muted hover:text-ink"}`}
              onClick={(event) => {
                event.stopPropagation();
                choose(side);
              }}
            >
              {side === "left" ? "Left" : "Right"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Chosen series and their axes. Chips wrap onto new lines in a narrow panel, and
 * a long name truncates inside its chip, so no chip is wider than the panel.
 */
export function SeriesAxes({
  chosen,
  columns,
  axisOf,
  onAxis,
}: {
  chosen: Column[];
  columns: Column[];
  axisOf: (id: string) => Axis;
  onAxis: (id: string, axis: Axis) => void;
}) {
  if (!chosen.length) return null;
  return (
    <div data-series-axes="" role="group" aria-label="Series axes" className="series-axis-row mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
      {chosen.map((column) => (
        <AxisChip key={column.id} label={chipText(column, columns)} axis={axisOf(column.id)} onChange={(axis) => onAxis(column.id, axis)} />
      ))}
      <style>{`
        @keyframes series-axis-in {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: none; }
        }
        .series-axis-chip { animation: series-axis-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
        .series-axis-pip, .series-axis-chip [role="radio"] {
          transition: background-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1), color 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .series-axis-chip { animation: none; }
          .series-axis-pip, .series-axis-chip [role="radio"] { transition: none; }
        }
      `}</style>
    </div>
  );
}

/** Options for the column menu. Axis choice does not live here. */
export function ColumnMenu({
  label,
  columns,
  selected,
  multiple,
  query,
  onQuery,
  onToggle,
}: {
  label: string;
  columns: Column[];
  selected: string[];
  multiple: boolean;
  query: string;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
      <input
        className="field mb-1 w-full"
        aria-label={`Search ${label}`}
        placeholder="Search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <div className="max-h-56 overflow-auto">
        {columns.map((column) => {
          const on = selected.includes(column.id);
          return (
            <div
              key={column.id}
              role="option"
              tabIndex={0}
              aria-selected={on}
              data-checked={on ? "true" : "false"}
              className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover ${on ? "bg-hover" : ""}`}
              onClick={() => onToggle(column.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onToggle(column.id);
              }}
            >
              <div className="flex w-full items-center gap-2">
                <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border ${on ? "border-accent bg-accent text-white" : "border-line"}`}>
                  {on ? (
                    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
                      <path d="M2.2 6.2 4.7 8.7 9.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate" data-column-name>{column.name}</span>
                <span className="shrink-0 text-[11px] text-faint">{column.type}</span>
              </div>
              {column.source ? <div className="truncate pl-6 text-[11px] text-faint">{column.source}</div> : null}
            </div>
          );
        })}
        {!columns.length ? <p className="px-2 py-1 text-[12px] text-muted">No columns</p> : null}
      </div>
    </div>
  );
}

/** Searchable single or multi select. Chips stay inside a fixed-height field so rows below do not jump. */
export function ColumnSelect({
  label,
  columns,
  selected,
  multiple,
  onChange,
  axisOf,
  onAxis,
}: {
  label: string;
  columns: Column[];
  selected: string[];
  multiple: boolean;
  onChange: (ids: string[]) => void;
  axisOf?: (id: string) => Axis;
  onAxis?: (id: string, axis: Axis) => void;
}) {
  const [query, setQuery] = useState("");
  const chosen = columns.filter((column) => selected.includes(column.id));
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return columns.filter((column) => !needle || column.name.toLowerCase().includes(needle) || (column.source ?? "").toLowerCase().includes(needle));
  }, [columns, query]);

  const toggle = (id: string) => {
    if (!multiple) {
      onChange(selected[0] === id ? [] : [id]);
      return;
    }
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  return (
    <div>
      <div className="mb-1 text-[12px] text-muted">{label}</div>
      <Popover
        width={280}
        align="right"
        fill
        trigger={(open, toggleOpen) => (
          <div className="field relative flex h-9 w-full items-center gap-1 overflow-hidden text-left focus-within:border-accent">
            <button
              type="button"
              aria-label={label}
              aria-haspopup="listbox"
              aria-expanded={open}
              className="absolute inset-0 z-0 rounded-lg"
              onClick={toggleOpen}
            />
            {chosen.length ? (
              <ChipField chosen={chosen} columns={columns} onRemove={(id) => onChange(selected.filter((item) => item !== id))} />
            ) : <span className="pointer-events-none text-muted">{multiple ? "Choose series" : "Choose a column"}</span>}
          </div>
        )}
      >
        {(close) => (
          <ColumnMenu
            label={label}
            columns={visible}
            selected={selected}
            multiple={multiple}
            query={query}
            onQuery={setQuery}
            onToggle={(id) => {
              toggle(id);
              if (!multiple) close();
            }}
          />
        )}
      </Popover>
      {onAxis && axisOf ? <SeriesAxes chosen={chosen} columns={columns} axisOf={axisOf} onAxis={onAxis} /> : null}
    </div>
  );
}
