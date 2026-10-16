"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { placeCenteredPanel } from "@/lib/place-layer";
import { checkDeskFields, type DeskField } from "./form-check";

/**
 * The small "+ Add …" form a desk tile opens. Focus moves into it and back to the button that
 * opened it; Esc closes it. Problems show beside their field and nothing is lost: the form stays
 * open with what was typed until the save succeeds.
 */
export function DeskAddForm({
  kind,
  title,
  fields,
  note,
  onSubmit,
  onClose,
  returnFocus,
}: {
  kind: string;
  title: string;
  fields: DeskField[];
  note?: ReactNode;
  /** Rejects with the message to show when the save fails. */
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
  /** Where focus goes on close when the opener is gone (a ghost tile that just filled). */
  returnFocus?: () => HTMLElement | null;
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // Captured on the first render, before focus moves in. Safari does not focus a clicked button, so body is no opener.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined && typeof document !== "undefined") {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A second click lands before React re-renders the disabled button.
  const busy = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;

  useLayoutEffect(() => {
    const node = formRef.current;
    if (!node) return;
    const place = () => {
      const next = placeCenteredPanel({ width: window.innerWidth, height: window.innerHeight }, node.scrollHeight);
      node.style.top = `${next.top}px`;
      node.style.maxHeight = `${next.maxHeight}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  useEffect(() => {
    const node = formRef.current;
    node?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      queueMicrotask(() => {
        if (node?.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const target = opener.current?.isConnected ? opener.current : fallback.current?.();
        target?.focus();
      });
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const checked = checkDeskFields(fields, values);
    const invalid = fields.find((field) => checked.errors[field.key]);
    setErrors(checked.errors);
    setFailure(null);
    if (invalid) {
      const field = formRef.current?.elements.namedItem(invalid.key);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await onSubmit(checked.values);
    } catch (error) {
      setFailure((error as Error).message || "Could not save. Try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const set = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  return (
    <form
      ref={formRef}
      noValidate
      role="dialog"
      aria-labelledby={`${id}-title`}
      className="addpop tile"
      data-desk-form={kind}
      onSubmit={(event) => void submit(event)}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div className="row sb">
        <span id={`${id}-title`} style={{ fontWeight: 650 }}>{title}</span>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      {fields.map((field) => {
        const error = errors[field.key];
        const describedBy = error ? `${id}-${field.key}-error` : undefined;
        const common = {
          name: field.key,
          className: "field",
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy,
          "aria-required": field.optional ? undefined : true,
          value: values[field.key] ?? "",
        } as const;
        return (
          <label key={field.key} className="col gap4" style={{ fontSize: 12, color: "var(--muted)" }}>
            {field.label}
            {field.input === "select" ? (
              <select {...common} onChange={(event) => set(field.key, event.target.value)}>
                <option value="">Choose</option>
                {field.options?.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            ) : (
              <input
                {...common}
                type={field.input ?? "text"}
                placeholder={field.placeholder}
                min={field.input === "date" ? "1900-01-01" : undefined}
                max={field.input === "date" ? "2200-12-31" : undefined}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
            {error ? <span id={describedBy} className="desk-field-error">{error}</span> : null}
          </label>
        );
      })}
      {note ? <p className="desk-form-note">{note}</p> : null}
      {failure ? <p role="alert" className="desk-field-error">{failure}</p> : null}
      <button type="submit" className="btn-p" disabled={pending} aria-busy={pending || undefined}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}
