"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { searchPhase, type SearchPhase } from "@/lib/motion/search-phase";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { cx } from "@/components/ui";

function EmptyMark() {
  return (
    <span className="sq-empty-mark" aria-hidden>
      <svg width="40" height="28" viewBox="0 0 40 28">
        <g className="em-x">
          <path d="M14 4V14A6 6 0 0 0 26 14V4" />
          <path className="thread" d="M18 4V12C18 16 21 17 22 21C22.6 23.5 21.6 25.5 20.5 26.5" />
        </g>
        <g className="em-q">
          <path d="M14 4V14A6 6 0 0 0 26 14V4" />
          <path className="a" d="M18 4V14A2 2 0 0 0 22 14V4" />
        </g>
        <g className="em-d">
          <circle cx="14" cy="14" r="2.6" />
          <circle className="a" cx="26" cy="14" r="2.6" />
        </g>
      </svg>
    </span>
  );
}

export function SearchQuery({
  value,
  onValue,
  placeholder,
  label,
  kbd,
  pending = false,
  count = null,
  list = false,
  status,
  emptyTitle,
  emptyHint,
  emptyActions,
  results,
  pill = false,
  inputRef,
  onKeyDown,
  onFocus,
  onSubmit,
  activeDescendant,
  controls,
  className,
  overlay = false,
  panelExtra,
  resultsClassName,
  resultsId,
}: {
  value: string;
  onValue: (value: string) => void;
  placeholder: string;
  label: string;
  kbd?: string;
  /** Real in-flight work. Cached queries stay false so no loader appears. */
  pending?: boolean;
  count?: number | null;
  list?: boolean;
  status?: string;
  emptyTitle?: string;
  emptyHint?: string;
  emptyActions?: ReactNode;
  results?: ReactNode;
  pill?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onSubmit?: () => void;
  activeDescendant?: string;
  controls?: string;
  className?: string;
  /** Float the status, results and empty copy instead of growing the field. */
  overlay?: boolean;
  panelExtra?: ReactNode;
  resultsClassName?: string;
  resultsId?: string;
}) {
  const [focused, setFocused] = useState(false);
  const anchor = useRef<HTMLLabelElement>(null);
  const showLoader = useDelayedFlag(pending);
  const phase: SearchPhase = searchPhase({ focused, query: value, pending, showLoader, count, list });
  const showPanel = phase === "searching" || phase === "results" || phase === "empty";
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!overlay || !showPanel) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelStyle({ position: "fixed", top: rect.bottom + 6, left: rect.left, width: rect.width, zIndex: 60 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [overlay, showPanel, value, phase]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };
  const panel = (
    <>
      {panelExtra}
      <div className="sq-meta" aria-live="polite">
        <span data-copy="status">{phase === "searching" || phase === "results" ? status : ""}</span>
      </div>
      <ul id={resultsId} className={cx("sq-results", resultsClassName)} role="listbox" aria-label="Results">
        {results}
      </ul>
      <div className="sq-empty" role="status">
        <EmptyMark />
        <p data-copy="empty-title">{emptyTitle}</p>
        {emptyHint ? <p data-copy="empty-hint">{emptyHint}</p> : null}
        {emptyActions ? (
          <div className="sq-empty-actions" data-copy="empty-actions">
            {emptyActions}
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      className={cx("sq", className)}
      data-motion-slot="search.query"
      data-state={phase === "idle" ? undefined : phase}
      style={pill ? { ["--sq-radius" as string]: "6px", ["--sq-h" as string]: "32px" } : undefined}
    >
      <form role="search" className="shrink-0" onSubmit={submit}>
        <label ref={anchor} className="sq-field">
          <svg className="sq-ic" viewBox="0 0 16 16" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.4 10.4L13.5 13.5" />
          </svg>
          <input
            ref={inputRef}
            className="sq-input"
            type="search"
            value={value}
            placeholder={placeholder}
            aria-label={label}
            autoComplete="off"
            aria-activedescendant={activeDescendant}
            aria-controls={controls}
            onChange={(event) => onValue(event.target.value)}
            onFocus={() => {
              setFocused(true);
              onFocus?.();
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
          />
          <span className="sq-pip" aria-hidden />
          <span className="sq-trk" aria-hidden>
            <i />
          </span>
          {kbd ? <kbd className="sq-kbd">{kbd}</kbd> : null}
        </label>
      </form>
      {showPanel && (status || list || emptyTitle)
        ? overlay && typeof document !== "undefined"
          ? createPortal(
              <div
                className="sq max-h-[min(420px,60vh)] overflow-y-auto rounded-xl border border-line-strong bg-panel p-2 shadow-pop"
                data-motion-slot="search.query"
                data-state={phase}
                style={panelStyle ?? { position: "fixed", visibility: "hidden" }}
              >
                {panel}
              </div>,
              document.body,
            )
          : <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{panel}</div>
        : null}
    </div>
  );
}
