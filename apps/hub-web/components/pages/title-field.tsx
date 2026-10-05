"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useRef, useState } from "react";

/** The page title. A newly created note focuses this field and selects the text. */
export function PageTitleField({
  value,
  onSave,
  autoFocus = false,
}: {
  value: string;
  onSave: (value: string) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  useEffect(() => setDraft(value), [value]);
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
    <textarea
      ref={ref}
      rows={1}
      value={draft}
      aria-label="Page title"
      onChange={(event) => setDraft(event.target.value.replace(/\n/g, ""))}
      onBlur={() => draft.trim() && draft !== value && onSave(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.target as HTMLTextAreaElement).blur();
        }
      }}
      placeholder="Untitled"
      className="w-full resize-none overflow-hidden bg-transparent text-[34px] font-bold leading-tight tracking-tight outline-none placeholder:text-faint"
    />
  );
}
