"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { LABEL_COLORS, MAX_TASK_LABEL_LENGTH, MAX_TASK_LABELS, labelTone, nextLabelColor, type BoardLabelList, type BoardLabelRecord, type LabelColor } from "@ensemble/shared-types";
import { api, type LabelListOf } from "@/lib/api";
import { colorOfLabel, labelColors, labelListKey, refreshLabelQueries, useLabelList } from "@/lib/labels";
import { toneStyle } from "@/lib/format";
import { useToast } from "../toast";
import { Popover, Tag, cx } from "../ui";

export const MAX_LABELS = MAX_TASK_LABELS;
export const MAX_LABEL_LENGTH = MAX_TASK_LABEL_LENGTH;
export { labelTone };

const COLOR_NAME: Record<LabelColor, string> = {
  blue: "Blue", green: "Green", purple: "Purple", orange: "Orange", pink: "Pink", yellow: "Yellow", red: "Red", gray: "Gray",
};

export function cleanLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
}

/** Labels typed as "a, b; c" added to `current`: trimmed, each once whatever its case, at most MAX_LABELS. */
export function addLabels(current: string[], input: string): string[] {
  const next = [...current];
  for (const part of input.split(/[,;\n]/)) {
    const label = cleanLabel(part.trim().replace(/^#/, ""));
    if (!label || next.some((value) => value.toLowerCase() === label.toLowerCase())) continue;
    if (next.length >= MAX_LABELS) break;
    next.push(label);
  }
  return next;
}

/** The colours of the board whose cards are showing (a board view wraps its columns in this). */
export const LabelColors = createContext<ReadonlyMap<string, LabelColor> | null>(null);

/** Gives the cards inside a board's own label colours. */
export function BoardLabelColors({ board, children }: { board: string; children: React.ReactNode }) {
  const list = useLabelList({ board });
  const colors = useMemo(() => labelColors(list.data?.labels), [list.data]);
  return <LabelColors.Provider value={colors}>{children}</LabelColors.Provider>;
}

export function LabelChips({ labels, max = 3, className, colors }: { labels: string[] | undefined; max?: number; className?: string; colors?: ReadonlyMap<string, LabelColor> | null }) {
  const board = useContext(LabelColors);
  if (!labels?.length) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} aria-label={`Labels: ${labels.join(", ")}`}>
      {shown.map((label) => (
        <Tag key={label} tone={colorOfLabel(label, colors ?? board)} className="max-w-[140px] truncate">
          {label}
        </Tag>
      ))}
      {rest > 0 ? <span className="text-[11.5px] text-faint" aria-hidden>+{rest}</span> : null}
    </span>
  );
}

type Row = { kind: "label"; label: BoardLabelRecord; known: boolean } | { kind: "create"; name: string };

/**
 * Labels as a picker, like People and Project: the item's board's labels with their colours, filtered
 * as you type; Enter or a click adds or removes one, and a name the board lacks is created on it with
 * the next free colour. Each label's ⋯ renames, recolours or deletes it for the whole board.
 */
export function LabelPicker({ of, value, onChange, disabled, labelledBy, empty = "Empty" }: { of: LabelListOf | null; value: string[]; onChange: (labels: string[]) => void; disabled?: boolean; labelledBy?: string; empty?: string }) {
  // `of` null: opened from a share, where the board's list is not open to the reader; read-only.
  const list = useLabelList(of);
  const colors = useMemo(() => labelColors(list.data?.labels), [list.data]);
  if (disabled || !of) return value.length ? <LabelChips labels={value} max={MAX_LABELS} colors={colors} /> : <span className="px-1.5 text-faint">{empty}</span>;
  return (
    <Popover
      width={264}
      maxHeight={380}
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : value.length ? `Labels: ${value.join(", ")}` : "Add labels"}
          className={cx("row-tile inline-flex min-h-6 min-w-0 max-w-full flex-wrap items-center gap-1 rounded px-1.5 py-0.5 text-left", !value.length && "text-faint")}
        >
          {value.length ? value.map((label) => (
            <Tag key={label} tone={colorOfLabel(label, colors)} className="max-w-[160px] truncate">{label}</Tag>
          )) : empty}
        </button>
      )}
    >
      {() => <LabelPanel of={of} list={list.data} loading={list.isPending} failed={list.isError} retry={() => void list.refetch()} value={value} onChange={onChange} />}
    </Popover>
  );
}

function LabelPanel({ of, list, loading, failed, retry, value, onChange }: { of: LabelListOf; list: BoardLabelList | undefined; loading: boolean; failed: boolean; retry: () => void; value: string[]; onChange: (labels: string[]) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // Picks made before the save comes back still count, so quick clicks add up.
  const current = useRef(value);
  useEffect(() => {
    current.current = value;
  }, [value]);
  const labels = useMemo(() => list?.labels ?? [], [list]);
  const selected = new Set(value.map((name) => name.toLowerCase()));
  const full = value.length >= MAX_LABELS;

  const create = useMutation({
    mutationFn: (name: string) => api.createLabel({ board: list!.board.id, name }),
    onSuccess: ({ label }) => {
      client.setQueryData<BoardLabelList>(labelListKey(of), (old) => old && !old.labels.some((row) => row.id === label.id) ? { ...old, labels: [...old.labels, label] } : old);
      void client.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const rows = useMemo<Row[]>(() => {
    const needle = cleanLabel(draft.replace(/^#/, "")).toLowerCase();
    // Names the item has that its board does not (yet): shown so they can be removed.
    const unknown = value.filter((name) => !labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))
      .map((name) => ({ kind: "label" as const, known: false, label: { id: `name:${name}`, name, color: labelTone(name), count: 0 } }));
    const all: Row[] = [...labels.map((label) => ({ kind: "label" as const, known: true, label })), ...unknown];
    const shown = needle
      ? all.filter((row) => row.kind === "label" && row.label.name.toLowerCase().includes(needle))
        .sort((a, b) => Number(b.kind === "label" && b.label.name.toLowerCase().startsWith(needle)) - Number(a.kind === "label" && a.label.name.toLowerCase().startsWith(needle)))
      : all;
    const exact = needle && all.some((row) => row.kind === "label" && row.label.name.toLowerCase() === needle);
    return needle && !exact && !full ? [...shown, { kind: "create", name: cleanLabel(draft.replace(/^#/, "")) }] : shown;
  }, [draft, labels, value, full]);

  useEffect(() => setActive(0), [draft]);
  const toggle = (name: string) => {
    const now = current.current;
    const on = now.some((value) => value.toLowerCase() === name.toLowerCase());
    if (!on && now.length >= MAX_LABELS) return;
    const next = on ? now.filter((value) => value.toLowerCase() !== name.toLowerCase()) : [...now, name];
    current.current = next;
    onChange(next);
  };
  const add = async (text: string) => {
    if (!list) return;
    let next = current.current;
    for (const name of addLabels([], text)) {
      if (next.length >= MAX_LABELS) break;
      if (next.some((value) => value.toLowerCase() === name.toLowerCase())) continue;
      const known = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
      const saved = known ?? (await create.mutateAsync(name).then((answer) => answer.label).catch(() => null));
      if (!saved) return;
      next = [...next, saved.name];
    }
    setDraft("");
    if (next !== current.current) {
      current.current = next;
      onChange(next);
    }
  };
  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "create") void add(draft);
    else {
      toggle(row.label.name);
      setDraft("");
    }
    input.current?.focus();
  };

  const editingLabel = editing ? labels.find((label) => label.id === editing) : undefined;
  if (editingLabel) {
    return <LabelEditPanel label={editingLabel} value={value} onChange={(next) => { current.current = next; onChange(next); }} onBack={() => { setEditing(null); requestAnimationFrame(() => input.current?.focus()); }} />;
  }
  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <div className="flex flex-col">
      <label className="compound-field mx-1 mt-1 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
        <Search size={13} className="shrink-0 text-faint" aria-hidden />
        <input
          ref={input}
          value={draft}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[active] ? optionId(active) : undefined}
          aria-label="Find or create a label"
          placeholder={full ? `Up to ${MAX_LABELS} labels` : "Find or create a label"}
          maxLength={MAX_LABEL_LENGTH * 3}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!rows.length) return;
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (draft.trim() && /[,;]/.test(draft)) void add(draft);
              else if (draft.trim()) choose(rows[active]);
            } else if (event.key === "Backspace" && !draft && current.current.length) {
              const next = current.current.slice(0, -1);
              current.current = next;
              onChange(next);
            }
          }}
        />
      </label>
      <div id={listId} role="listbox" aria-multiselectable aria-label={list ? `${list.board.title} labels` : "Labels"} className="mt-1 max-h-[244px] overflow-y-auto px-1 pb-1">
        {loading ? <p className="px-2 py-1.5 text-[12.5px] text-muted">Loading labels…</p> : null}
        {failed ? (
          <p className="px-2 py-1.5 text-[12.5px] text-muted">
            Labels could not be loaded. <button type="button" className="text-accent hover:underline" onClick={retry}>Try again</button>
          </p>
        ) : null}
        {list && !rows.length ? <p className="px-2 py-1.5 text-[12.5px] text-muted">{draft.trim() ? "Nothing matches." : "No labels yet. Type a name to add one."}</p> : null}
        {rows.map((row, index) => {
          const isActive = index === active;
          if (row.kind === "create") {
            return (
              <div
                key="create"
                id={optionId(index)}
                role="option"
                aria-selected={false}
                className={cx("flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px]", isActive && "bg-hover")}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(row)}
              >
                <Plus size={13} className="shrink-0 text-muted" aria-hidden />
                <span className="shrink-0 text-muted">{create.isPending ? "Creating" : "Create"}</span>
                <Tag tone={nextLabelColor(row.name, labels.map((label) => label.color))} className="max-w-[150px] truncate">{row.name}</Tag>
              </div>
            );
          }
          const on = selected.has(row.label.name.toLowerCase());
          const blocked = !on && full;
          return (
            <div
              key={row.label.id}
              id={optionId(index)}
              role="option"
              aria-selected={on}
              aria-disabled={blocked || undefined}
              className={cx("group flex h-8 cursor-pointer items-center gap-2 rounded-md pl-2 pr-1 text-[13px]", isActive && "bg-hover", blocked && "opacity-40")}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => !blocked && choose(row)}
            >
              <Check size={13} className={cx("shrink-0 text-accent", !on && "invisible")} aria-hidden />
              <Tag tone={row.label.color} className="max-w-[150px] truncate">{row.label.name}</Tag>
              <span className="ml-auto shrink-0 text-2xs tabular-nums text-faint" aria-label={row.known ? `${row.label.count} items` : undefined}>{row.known && row.label.count ? row.label.count : ""}</span>
              {row.known ? (
                <button
                  type="button"
                  className="icon-btn h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`Edit label ${row.label.name}`}
                  title="Rename, recolour or delete"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(row.label.id);
                  }}
                >
                  <MoreHorizontal size={13} aria-hidden />
                </button>
              ) : <span className="h-6 w-6 shrink-0" aria-hidden />}
            </div>
          );
        })}
      </div>
      {list ? <p className="border-t border-line px-3 pb-1 pt-1.5 text-2xs text-faint">Labels of {list.board.title}</p> : null}
    </div>
  );
}

/** Rename, recolour or delete one label: it changes for every item on the board. */
function LabelEditPanel({ label, value, onChange, onBack }: { label: BoardLabelRecord; value: string[]; onChange: (labels: string[]) => void; onBack: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(label.name);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (patch: { name?: string; color?: LabelColor }) => api.patchLabel(label.id, patch),
    onSuccess: ({ label: saved }) => {
      // The item's own list follows a rename at once; the server renamed it on every item already.
      if (saved.name !== label.name && value.some((item) => item.toLowerCase() === label.name.toLowerCase())) {
        onChange(value.map((item) => (item.toLowerCase() === label.name.toLowerCase() ? saved.name : item)));
      }
      refreshLabelQueries(client);
    },
    onError: (error: Error) => {
      setName(label.name);
      toast(error.message, { tone: "error" });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLabel(label.id),
    onSuccess: () => {
      if (value.some((item) => item.toLowerCase() === label.name.toLowerCase())) onChange(value.filter((item) => item.toLowerCase() !== label.name.toLowerCase()));
      refreshLabelQueries(client);
      onBack();
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const rename = () => {
    const next = cleanLabel(name);
    if (!next) return setName(label.name);
    if (next !== label.name) save.mutate({ name: next });
  };
  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="flex items-center gap-1">
        <button type="button" className="icon-btn h-7 w-7" aria-label="Back to labels" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
        </button>
        <span className="text-[12.5px] font-medium text-ink">Edit label</span>
      </div>
      <label className="compound-field flex h-8 items-center rounded-md border border-line px-2">
        <input
          value={name}
          aria-label="Label name"
          maxLength={MAX_LABEL_LENGTH}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              rename();
            }
          }}
        />
      </label>
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5 px-1">
        {LABEL_COLORS.map((color) => {
          const on = color === label.color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={COLOR_NAME[color]}
              title={COLOR_NAME[color]}
              className={cx("grid h-6 w-6 place-items-center rounded-full", on && "ring-2 ring-accent ring-offset-1 ring-offset-raised")}
              style={toneStyle(color)}
              onClick={() => !on && save.mutate({ color })}
            >
              {on ? <Check size={12} aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      <div className="border-t border-line pt-1">
        {confirming ? (
          <div className="flex flex-col gap-1.5 px-1 py-1">
            <p className="text-[12.5px] text-ink">
              {label.count ? `Remove “${label.name}” from this board and its ${label.count === 1 ? "item" : `${label.count} items`}?` : `Remove “${label.name}” from this board?`}
            </p>
            <div className="flex gap-1.5">
              <button type="button" className="btn text-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="row-tile flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-danger" onClick={() => setConfirming(true)}>
            <Trash2 size={13} aria-hidden />
            Delete label
          </button>
        )}
      </div>
    </div>
  );
}
