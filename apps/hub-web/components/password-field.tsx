"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type InputHTMLAttributes, type Ref } from "react";

/**
 * A password input with a Show button, the rule shown before anything is typed, and an
 * inline error that screen readers announce. The input is marked invalid while `error` is set.
 */
export function PasswordField({
  label,
  value,
  onChange,
  rule,
  error,
  describedBy,
  invalid,
  errorClassName = "text-danger",
  className,
  ref,
  ...input
}: {
  ref?: Ref<HTMLInputElement>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rule?: string;
  error?: string | null;
  /** More ids for aria-describedby, such as a form-level error. */
  describedBy?: string;
  /** Marks the input invalid when the error is shown somewhere else (a form-level message). */
  invalid?: boolean;
  errorClassName?: string;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "className">) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const ruleId = rule ? `${id}-rule` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const described = [ruleId, errorId, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-medium">
        {label}
      </label>
      <div className="relative mt-1">
        <input
          {...input}
          ref={ref}
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error) || invalid || undefined}
          aria-describedby={described}
          className="field w-full pr-9"
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-faint hover:text-ink"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        </button>
      </div>
      {rule ? (
        <p id={ruleId} className="mt-1 text-[12px] font-normal text-muted">
          {rule}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={`mt-1 text-[12px] font-normal ${errorClassName}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
