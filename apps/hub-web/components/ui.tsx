"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Info, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import type { Priority, TaskStatus } from "@/lib/api";
import { PRIORITY, STATUS, toneStyle, type Tone } from "@/lib/format";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** True when the element can still scroll to the right. Re-measures when it mounts or its children resize. */
export function useOverflowRight(): [(node: HTMLDivElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!node) return;
    const update = () => setMore(node.scrollWidth - node.clientWidth - node.scrollLeft > 8);
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    const watch = () => {
      observer.disconnect();
      observer.observe(node);
      for (const child of node.children) observer.observe(child);
      update();
    };
    watch();
    const mutations = new MutationObserver(watch);
    mutations.observe(node, { childList: true });
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [node]);
  return [setNode, more];
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="min-w-0">
        <h1 className="display text-[32px] leading-none">{title}</h1>
        {description ? <div className="mt-2 max-w-2xl text-[14px] leading-5 text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Tag({ tone = "gray", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("tag", className)} style={toneStyle(tone)}>
      {children}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: Priority }) {
  const spec = PRIORITY[priority];
  return <Tag tone={spec.tone}>{spec.label}</Tag>;
}

export function StatusPill({ status, count }: { status: TaskStatus; count?: number }) {
  const spec = STATUS[status];
  return (
    <span className="inline-flex items-center gap-2">
      <Tag tone={spec.tone}>{spec.label}</Tag>
      {count !== undefined ? <span className="text-[12.5px] text-muted">{count}</span> : null}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-raised",
      )}
    >
      <span
        className={cx(
          "inline-block h-4 w-4 rounded-full bg-white shadow",
          checked ? "translate-x-[22px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

export function Spinner({ size = 14, active = true }: { size?: number; active?: boolean }) {
  const shown = useDelayedFlag(active);
  if (!shown) return null;
  return (
    <span className="m-duet m-loop" style={{ ["--s" as string]: `${size}px` }} data-motion-slot="control.spinner" data-state="running" data-motion-loading="1" aria-hidden>
      <i />
      <i />
    </span>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex cursor-help text-faint hover:text-muted">
      <Info size={13} />
    </span>
  );
}

export function Empty({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="empty-state" data-motion-slot="state.empty" data-state="idle">
      <svg className="m-loose m-loop mb-2" width="36" height="28" viewBox="0 0 36 28" aria-hidden>
        <path d="M4 8c6 0 8 12 14 12s6-10 14-8" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="30" cy="12" r="2" fill="var(--ink)" />
      </svg>
      {title ? <div className="mb-1 font-medium text-ink">{title}</div> : null}
      {children}
    </div>
  );
}

export function Skeleton({
  className,
  active = true,
  index = 0,
  style,
}: {
  className?: string;
  active?: boolean;
  index?: number;
  style?: React.CSSProperties;
}) {
  const shown = useDelayedFlag(active);
  return (
    <div
      className={cx("skeleton", className)}
      style={{ ...style, ["--i" as string]: index }}
      data-visible={shown ? "1" : "0"}
      data-motion-loading={shown ? "1" : "0"}
      data-motion-slot="content.skeleton"
      data-state={shown ? "loading" : "ready"}
      aria-hidden
    />
  );
}

export function SkeletonRows({
  count = 4,
  rowClassName = "h-11",
  className = "space-y-2",
}: {
  count?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} index={index} className={cx("w-full", rowClassName)} />
      ))}
    </div>
  );
}

export function SectionCard({
  title,
  info,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  info?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("tile section", className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-semibold">
            {title}
            {info ? <InfoTip text={info} /> : null}
          </h2>
          {description ? <p className="mt-1 text-[13px] leading-5 text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="mb-6 inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl bg-raised p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cx(
            "shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] transition-colors",
            value === tab.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          {tab.label}
          {tab.badge ? <span className="ml-1.5 text-2xs text-faint">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOutside();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, [ref, onOutside, active]);
}

/** A click-to-open menu anchored to its trigger. Side is chosen once, then kept until resize or scroll. */
export function Popover({
  trigger,
  children,
  align = "left",
  width = 240,
  className,
  fill = false,
}: {
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: number;
  className?: string;
  fill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const side = useRef<Side | null>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      side.current = null;
      setBox(null);
      return;
    }
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const next = placeAnchoredPanel({
        anchor,
        panelWidth: width,
        panelHeight: Math.min(panel.scrollHeight, 340),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        previousSide: side.current,
        gap: 4,
      });
      const usedWidth = Math.min(Math.max(next.width, panel.scrollWidth), window.innerWidth - 16);
      const left = Math.max(8, Math.min(next.left, window.innerWidth - 8 - usedWidth));
      side.current = next.side;
      setBox((prev) =>
        prev && prev.top === next.top && prev.left === left && prev.width === usedWidth && prev.maxHeight === next.maxHeight
          ? prev
          : { top: next.top, left, width: usedWidth, maxHeight: Math.min(next.maxHeight, 340) },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, width]);
  return (
    <div ref={ref} className={cx("relative", fill ? "block w-full" : "inline-block", className)}>
      {trigger(open, () => setOpen((value) => !value))}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              data-popover=""
              className="pop-in z-[120] overflow-auto rounded-lg bg-raised p-1 shadow-pop"
              style={{
                position: "fixed",
                top: box?.top ?? 0,
                left: box?.left ?? 0,
                width: box?.width ?? width,
                maxHeight: box ? Math.min(box.maxHeight, 340) : 340,
                zIndex: 120,
                visibility: box ? "visible" : "hidden",
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  active,
  hint,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "row-tile flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        active && "bg-hover",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-2xs text-faint">{hint}</span> : null}
    </button>
  );
}

const TEXT_INPUT_SKIP = new Set(["hidden", "button", "submit", "reset", "checkbox", "radio", "file", "image"]);

function isTextInput(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.disabled;
  if (!(element instanceof HTMLInputElement) || element.disabled) return false;
  return !TEXT_INPUT_SKIP.has(element.type);
}

function isField(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

/** Autofocus, otherwise the first text field. A button is only the fallback when nothing accepts input. */
function dialogFocusTarget(root: HTMLElement): HTMLElement | null {
  const marked = root.querySelector<HTMLElement>("[autofocus]");
  if (marked) return marked;

  // React's autoFocus prop focuses during commit and does not set the attribute.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== root && root.contains(active) && isField(active)) return active;

  const fields = root.querySelectorAll<HTMLElement>("input, textarea, select");
  for (const field of fields) {
    if (isTextInput(field)) return field;
  }
  for (const field of fields) {
    if (field instanceof HTMLInputElement && (field.type === "hidden" || field.disabled)) continue;
    if (field instanceof HTMLSelectElement && field.disabled) continue;
    if (field instanceof HTMLTextAreaElement && field.disabled) continue;
    return field;
  }
  return root.querySelector<HTMLElement>("button:not([disabled]), [href]");
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current(), []);
  useClickOutside(ref, close, open);
  const titleId = useRef(`dialog-${title.replace(/\s+/g, "-").toLowerCase()}`);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const openRef = useRef(open);
  if (typeof document !== "undefined" && open && !wasOpenRef.current) {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }
  wasOpenRef.current = open;
  openRef.current = open;
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const target = node ? dialogFocusTarget(node) : null;
    if (target && document.activeElement !== target) target.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Skip while the dialog is still open (including Strict Mode's extra setup/cleanup).
      // Restoring focus here would steal the field on every keystroke if this effect re-ran.
      if (openRef.current) return;
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
    };
    // onClose lives in a ref. Callers pass a new function on every render, and
    // listing it here would re-run this effect on each keystroke.
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        className="pop-in max-h-[76vh] overflow-auto rounded-xl bg-raised shadow-pop"
        style={{ width }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 id={titleId.current} className="text-[15px] font-semibold">{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A value that shows as text and turns into an input on click — the Notion property feel. */
export function InlineEdit({
  value,
  placeholder = "Empty",
  onSave,
  multiline,
  className,
}: {
  value: string;
  placeholder?: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cx("row-tile -mx-1.5 rounded px-1.5 py-0.5 text-left", !value && "text-faint", className)}
      >
        {value || placeholder}
      </button>
    );
  }
  const shared = {
    autoFocus: true,
    value: draft,
    onBlur: commit,
    className: cx("field w-full", className),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraft(value);
        setEditing(false);
      }
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) commit();
    },
  };
  return multiline ? <textarea rows={3} {...shared} /> : <input {...shared} />;
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      {hint ? <span className="mt-0.5 block text-[12.5px] leading-4 text-muted">{hint}</span> : null}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            "rounded-md px-3 py-1 text-[13px] transition-colors",
            value === option.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Range({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  const current = Number.isFinite(value) ? value : min;
  const pct = ((current - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={current}
      onChange={(event) => onChange(Number(event.target.value))}
      className="range max-w-md"
      style={{ ["--p" as string]: `${pct}%` }}
    />
  );
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 max-w-[560px]">
        <div className="text-[13.5px] font-medium">{title}</div>
        {description ? <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
