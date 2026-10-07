"use client";

import { X } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { Tone } from "@/lib/format";
import { Tag, cx } from "../ui";

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;

const TONES: Tone[] = ["blue", "green", "purple", "orange", "pink", "yellow"];

/** The same label gets the same colour everywhere. */
export function labelTone(label: string): Tone {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

export function cleanLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
}

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

export function LabelChips({ labels, max = 3, className }: { labels: string[] | undefined; max?: number; className?: string }) {
  if (!labels?.length) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} aria-label={`Labels: ${labels.join(", ")}`}>
      {shown.map((label) => (
        <Tag key={label} tone={labelTone(label)} className="max-w-[140px] truncate">
          {label}
        </Tag>
      ))}
      {rest > 0 ? <span className="text-[11.5px] text-faint" aria-hidden>+{rest}</span> : null}
    </span>
  );
}

/** Chips with a remove button each and an input that adds on Enter or comma. */
export function LabelEditor({ labels, onChange, disabled }: { labels: string[]; onChange: (labels: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const commit = () => {
    if (!draft.trim()) return;
    const next = addLabels(labels, draft);
    setDraft("");
    if (next.length !== labels.length) onChange(next);
  };
  const full = labels.length >= MAX_LABELS;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {labels.map((label) => (
        <span key={label} className="inline-flex items-center">
          <Tag tone={labelTone(label)} className="gap-0.5 pr-0.5">
            {label}
            <button
              type="button"
              className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded opacity-70 hover:opacity-100"
              aria-label={`Remove label ${label}`}
              disabled={disabled}
              onClick={() => {
                onChange(labels.filter((value) => value !== label));
                input.current?.focus();
              }}
            >
              <X size={10} aria-hidden />
            </button>
          </Tag>
        </span>
      ))}
      <input
        ref={input}
        value={draft}
        disabled={disabled || full}
        aria-label="Add a label"
        aria-describedby={hintId}
        placeholder={full ? "Label limit reached" : labels.length ? "Add…" : "Add a label…"}
        maxLength={MAX_LABEL_LENGTH * 3}
        className={cx("min-w-[90px] flex-1 rounded bg-transparent px-1.5 py-0.5 text-[13px] outline-none placeholder:text-faint", "focus-visible:ring-1 focus-visible:ring-line-strong")}
        onChange={(event) => {
          const value = event.target.value;
          if (/[,;]/.test(value)) {
            const next = addLabels(labels, value);
            setDraft("");
            if (next.length !== labels.length) onChange(next);
            return;
          }
          setDraft(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !draft && labels.length) {
            onChange(labels.slice(0, -1));
          } else if (event.key === "Escape" && draft) {
            event.stopPropagation();
            setDraft("");
          }
        }}
        onBlur={commit}
      />
      <span id={hintId} className="sr-only">
        Press Enter or type a comma to add. Backspace removes the last label.
      </span>
    </div>
  );
}
