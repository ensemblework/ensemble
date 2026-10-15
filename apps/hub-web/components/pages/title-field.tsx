"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useId, useRef, useState } from "react";

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
}: {
  value: string;
  onSave: (value: string) => void;
  autoFocus?: boolean;
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
      ref={ref}
      rows={1}
      value={draft}
      aria-label="Page title"
      aria-describedby={error ? errorId : undefined}
      onChange={(event) => { setError(""); setDraft(event.target.value.replace(/\n/g, "")); }}
      onBlur={() => {
        const title = draft.trim();
        if (!title) {
          setDraft(shown(value));
          // Still untitled: nothing was lost, so there is nothing to explain.
          if (shown(value)) setError("A title is required. The previous title was restored.");
          return;
        }
        setDraft(title);
        if (title !== value) onSave(title);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.target as HTMLTextAreaElement).blur();
        }
      }}
      placeholder={UNTITLED}
      className="w-full resize-none overflow-hidden bg-transparent text-[34px] font-bold leading-tight tracking-tight outline-none placeholder:text-faint"
    />
    {error ? <p id={errorId} role="status" className="mt-1 text-[13px] text-danger">{error}</p> : null}
    </>
  );
}
