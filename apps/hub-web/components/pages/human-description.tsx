/** @jsxRuntime automatic */
/** @jsxImportSource react */
"use client";

import { useEffect, useRef } from "react";

/** Plain document text. The empty field is revealed only by an explicit human action. */
export function HumanDescription({ value, editing, onEditing, onSave, readOnly = false }: { value: string; editing: boolean; onEditing: (editing: boolean) => void; onSave: (value: string) => void; readOnly?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing || !ref.current) return;
    cancelled.current = false;
    ref.current.innerText = value;
    ref.current.focus();
  }, [editing]);
  if (!value && !editing) return null;
  return <div className="mb-5 mt-4 text-[14px] leading-6 text-muted" data-human-description>
    {editing && !readOnly ? <div ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-label="Short description" aria-multiline="true" className="human-description min-h-6 whitespace-pre-wrap break-words outline-none" onBlur={(event) => {
      const next = event.currentTarget.innerText.replace(/\r\n/g, "\n").trim();
      onEditing(false);
      if (!cancelled.current && next !== value) onSave(next);
    }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; onEditing(false); }
      else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); }
    }} /> : <div className="whitespace-pre-wrap break-words" tabIndex={readOnly ? undefined : 0} role={readOnly ? undefined : "button"} aria-label={readOnly ? undefined : "Edit short description"} onClick={() => { if (!readOnly) onEditing(true); }} onKeyDown={(event) => { if (!readOnly && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onEditing(true); } }}>{value}</div>}
  </div>;
}
