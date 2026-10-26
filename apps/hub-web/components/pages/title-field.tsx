"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useId, useRef, useState } from "react";
import { focusPageBody } from "../editor/page-body";

/**
 * The title new pages and tasks are created with (hub-api stores it). The field shows it as its
 * placeholder rather than as text, so typing a title does not append to it.
 */
const UNTITLED = "Untitled";

const shown = (value: string) => (value === UNTITLED ? "" : value);

/** The page title. A newly created note focuses this field, empty under its "Untitled" placeholder. */
export function PageTitleField({
  value,
  onSave,
  autoFocus = false,
  label = "Page title",
  onDraft,
  restoreValue,
  onCommit,
}: {
  value: string;
  onSave: (value: string) => void;
  autoFocus?: boolean;
  label?: string;
  restoreValue?: string;
  onCommit?: () => void;
  onDraft?: (value: string) => void;
}) {
  const errorId = useId();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(shown(value));
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  useEffect(() => setDraft(shown(value)), [value]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  useEffect(() => {
    if (!autoFocus || focused.current) return;
    const element = ref.current;
    if (!element) return;
    focused.current = true;
    element.focus();
    element.setSelectionRange(0, element.value.length);
  }, [autoFocus]);
  return (
    <>
    <textarea
      data-page-title
      ref={ref}
      rows={1}
      value={draft}
      aria-label={label}
      aria-describedby={error ? errorId : undefined}
      onChange={(event) => { setError(""); const next = event.target.value.replace(/\n/g, ""); setDraft(next); onDraft?.(next); }}
      onBlur={() => {
        const title = draft.trim();
        if (!title) {
          setDraft(shown(restoreValue ?? value));
          onDraft?.(restoreValue ?? value);
          // Still untitled: nothing was lost, so there is nothing to explain.
          if (shown(restoreValue ?? value)) setError("A title is required. The previous title was restored.");
          onCommit?.();
          return;
        }
        setDraft(title);
        if (title !== value) onSave(title);
        onCommit?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        // Enter carries on writing in the page; focus must not fall to the page, where keys are shortcuts.
        if (!focusPageBody(event.currentTarget)) event.currentTarget.blur();
      }}
      placeholder={UNTITLED}
      className="w-full resize-none overflow-hidden bg-transparent text-[34px] font-bold leading-tight tracking-tight outline-none placeholder:text-faint"
    />
    {error ? <p id={errorId} role="status" className="mt-1 text-[13px] text-danger">{error}</p> : null}
    </>
  );
}
