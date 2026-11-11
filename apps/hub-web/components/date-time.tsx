"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Ensemble's own date and time fields, in place of the browser's: a button that reads naturally
 * ("Fri, 14 Nov", "09:30") and opens a small calendar or a list of times in the app's style and
 * accent. Values stay the plain strings the browser's inputs gave (`YYYY-MM-DD`, `HH:MM`,
 * `YYYY-MM-DDTHH:MM`), so callers keep their own rules. A date or time can also be typed:
 * "tomorrow", "fri", "next week", "in 3 days", "14 nov", "9:30pm".
 */
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover, cx } from "./ui";

const pad = (value: number) => String(value).padStart(2, "0");
export const dayKey = (date: Date) => `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const addMonths = (date: Date, months: number) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
};

/** `YYYY-MM-DD` as a local day, or null. */
export function readDay(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthOf = (word: string) => (word.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(word)) : -1);

/** Whether this browser writes the day before the month (14/11) or after (11/14). */
function dayFirst(): boolean {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "numeric" }).formatToParts(new Date(2020, 10, 22));
    return parts.findIndex((part) => part.type === "day") < parts.findIndex((part) => part.type === "month");
  } catch {
    return true;
  }
}

/** A typed day ("tomorrow", "fri", "next week", "in 3 days", "14 nov", "2026-11-14", "14/11"), or null. */
export function parseDay(input: string, now = new Date()): Date | null {
  const text = input.trim().toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ");
  const today = startOfDay(now);
  if (!text) return null;
  if (/^(today|tod|now)$/.test(text)) return today;
  if (/^(tomorrow|tmr|tom|tmrw)$/.test(text)) return addDays(today, 1);
  if (text === "yesterday") return addDays(today, -1);
  if (text === "next week") return addDays(today, ((8 - today.getDay()) % 7) || 7);
  if (text === "next month") return new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return readDay(`${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`);
  const relative = /^(?:in )?\+?(\d{1,3}) ?(d|day|days|w|wk|week|weeks|m|mo|month|months)$/.exec(text);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]![0];
    return unit === "d" ? addDays(today, count) : unit === "w" ? addDays(today, count * 7) : addMonths(today, count);
  }
  const weekday = /^(?:next |this )?([a-z]+)$/.exec(text);
  if (weekday && weekday[1]!.length >= 3) {
    const index = WEEKDAYS.findIndex((name) => name.startsWith(weekday[1]!));
    if (index >= 0) return addDays(today, ((index - today.getDay() + 7) % 7) || 7);
  }
  const named = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(text) ?? null;
  const namedUs = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(text) ?? null;
  const parts = named ? { day: Number(named[1]), month: monthOf(named[2]!), year: named[3] } : namedUs ? { day: Number(namedUs[2]), month: monthOf(namedUs[1]!), year: namedUs[3] } : null;
  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(text);
  const found =
    parts && parts.month >= 0
      ? parts
      : numeric
        ? dayFirst()
          ? { day: Number(numeric[1]), month: Number(numeric[2]) - 1, year: numeric[3] }
          : { day: Number(numeric[2]), month: Number(numeric[1]) - 1, year: numeric[3] }
        : null;
  if (!found || found.month < 0 || found.month > 11) return null;
  const year = found.year ? (found.year.length === 2 ? 2000 + Number(found.year) : Number(found.year)) : today.getFullYear();
  let date = new Date(year, found.month, found.day);
  if (date.getMonth() !== found.month) return null;
  // "14 nov" when that has passed this year is next year's.
  if (!found.year && date < today) date = new Date(year + 1, found.month, found.day);
  return date;
}

/** A typed time ("9", "9:30", "930", "9am", "9.30 pm", "21:00", "noon"), as `HH:MM`, or null. */
export function parseTime(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;
  if (text === "noon" || text === "midday") return "12:00";
  if (text === "midnight") return "00:00";
  const match = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const half = match[3]?.[0];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  }
  if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** "Fri, 14 Nov" (with the year when it is not this one). */
export function dayLabel(value: string): string {
  const date = readDay(value);
  if (!date) return value;
  const today = startOfDay(new Date());
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  const name = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : null;
  const text = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date);
  return name ? `${name} · ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date)}` : text;
}

/** "09:30", or "9:30 AM" where the browser counts hours that way. */
export function timeLabel(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  return new Date(2000, 0, 1, Number(match[1]), Number(match[2])).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type Look = "field" | "inline";

const TRIGGER: Record<Look, string> = {
  field: "field flex w-full min-w-0 items-center gap-2 text-left",
  inline: "row-tile -mx-1.5 inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[13.5px]",
};

/** A day in the calendar grid's focus while it is open, kept in range. */
function clampDay(date: Date, min: Date | null, max: Date | null): Date {
  if (min && date < min) return min;
  if (max && date > max) return max;
  return date;
}

/** The calendar the date field opens; also inside menus (a task's Due ▸). `onClear` adds "No date". */
export function Calendar({ value, min, max, onPick, close, onClear }: { value: string; min?: string; max?: string; onPick: (value: string) => void; close: () => void; onClear?: () => void }) {
  const today = startOfDay(new Date());
  const lower = readDay(min);
  const upper = readDay(max);
  const chosen = readDay(value);
  const [focus, setFocus] = useState(() => clampDay(chosen ?? today, lower, upper));
  const [typed, setTyped] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const guessed = typed.trim() ? parseDay(typed) : null;
  const inRange = (date: Date) => (!lower || date >= lower) && (!upper || date <= upper);
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  // Weeks start on Monday.
  const lead = (first.getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index - lead));
  const weeks = cells[35]!.getMonth() !== focus.getMonth() ? 5 : 6;
  const heads = useMemo(() => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(new Date(2024, 0, 1 + index))), []);
  const title = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(focus);
  useEffect(() => {
    if (!moved.current) return;
    grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  }, [focus]);
  const pick = (date: Date) => {
    if (!inRange(date)) return;
    onPick(dayKey(date));
    close();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, event.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -((focus.getDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() + 6) % 7)),
    };
    if (step[event.key]) {
      event.preventDefault();
      moved.current = true;
      setFocus(clampDay(step[event.key]!(), lower, upper));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(focus);
    }
  };
  const quick: Array<[string, Date]> = [
    ["Today", today],
    ["Tomorrow", addDays(today, 1)],
    ["Next week", addDays(today, ((8 - today.getDay()) % 7) || 7)],
  ];
  return (
    <div className="dp">
      <label className="dp-type">
        <span className="sr-only">Type a date</span>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (guessed && inRange(guessed)) pick(guessed);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              moved.current = true;
              setFocus((current) => new Date(current));
            }
          }}
          placeholder="Type: tomorrow, fri, 14 nov…"
          spellCheck={false}
          autoComplete="off"
        />
        {typed.trim() ? <span className={cx("dp-guess", !guessed || !inRange(guessed) ? "text-danger" : "text-muted")}>{guessed ? (inRange(guessed) ? dayLabel(dayKey(guessed)) : "Out of range") : "?"}</span> : null}
      </label>
      <div className="dp-head">
        <button type="button" className="dp-nav" aria-label="Previous month" onClick={() => setFocus((current) => addMonths(current, -1))}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className="dp-title" title="Go to today" onClick={() => setFocus(clampDay(today, lower, upper))}>
          {title}
        </button>
        <button type="button" className="dp-nav" aria-label="Next month" onClick={() => setFocus((current) => addMonths(current, 1))}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div ref={grid} role="grid" aria-label={title} className="dp-grid" onKeyDown={keys}>
        <div role="row" className="dp-row">
          {heads.map((head, index) => (
            <span key={index} role="columnheader" className="dp-dow">
              {head}
            </span>
          ))}
        </div>
        {Array.from({ length: weeks }, (_, week) => (
          <div key={week} role="row" className="dp-row">
            {cells.slice(week * 7, week * 7 + 7).map((date) => {
              const key = dayKey(date);
              const outside = date.getMonth() !== focus.getMonth();
              const selected = value === key;
              const isFocus = key === dayKey(focus);
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  tabIndex={isFocus ? 0 : -1}
                  aria-selected={selected}
                  aria-current={key === dayKey(today) ? "date" : undefined}
                  aria-label={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date)}
                  disabled={!inRange(date)}
                  onClick={() => pick(date)}
                  className="dp-day"
                  data-outside={outside || undefined}
                  data-today={key === dayKey(today) || undefined}
                  data-selected={selected || undefined}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="dp-foot">
        {quick.map(([label, date]) => (
          <button key={label} type="button" className="dp-chip" disabled={!inRange(date)} onClick={() => pick(date)}>
            {label}
          </button>
        ))}
        {onClear && value ? (
          <button type="button" className="dp-chip ml-auto" onClick={() => { onClear(); close(); }}>
            No date
          </button>
        ) : null}
      </div>
    </div>
  );
}

type DateProps = {
  value: string;
  onChange: (value: string) => void;
  /** The field's name for screen readers. */
  label: string;
  placeholder?: string;
  min?: string;
  max?: string;
  /** A × that empties it. */
  clearable?: boolean;
  look?: Look;
  disabled?: boolean;
  className?: string;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
};

/** A day, as `YYYY-MM-DD` ("" when empty). */
export function DateInput({ value, onChange, label, placeholder = "Pick a date", min, max, clearable = true, look = "field", disabled, className, id, invalid, describedBy }: DateProps) {
  return (
    <span className={cx("dp-wrap", look === "field" ? "flex w-full min-w-0" : "inline-flex min-w-0", className)}>
      <Popover
        fill={look === "field"}
        width={272}
        maxHeight={440}
        trigger={(open, toggle) => (
          <button
            type="button"
            id={id}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onClick={toggle}
            className={cx(TRIGGER[look], "dp-trigger", invalid && "ring-1 ring-danger")}
            data-open={open || undefined}
          >
            <CalendarDays size={look === "inline" ? 13 : 14} className="dp-icon shrink-0" aria-hidden />
            <span className={cx("min-w-0 flex-1 truncate", !value && "text-faint")}>{value ? dayLabel(value) : placeholder}</span>
          </button>
        )}
      >
        {(close) => <Calendar value={value} min={min} max={max} onPick={onChange} close={close} />}
      </Popover>
      {clearable && value && !disabled ? (
        <button type="button" className="dp-clear" aria-label={`Clear ${label.toLowerCase()}`} title="Clear" onClick={() => onChange("")}>
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}

function TimeList({ value, step, onPick, close }: { value: string; step: number; onPick: (value: string) => void; close: () => void }) {
  const [typed, setTyped] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const guessed = parseTime(typed);
  const times = useMemo(() => {
    const out: string[] = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += step) out.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
    if (value && !out.includes(value)) out.push(value);
    return out.sort();
  }, [step, value]);
  const near = value || (() => {
    const now = new Date();
    const minutes = Math.ceil((now.getHours() * 60 + now.getMinutes()) / step) * step;
    return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  })();
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-time="${near}"]`);
    if (row && list.current) list.current.scrollTop = row.offsetTop - list.current.clientHeight / 2 + row.clientHeight / 2;
  }, [near]);
  const pick = (time: string) => {
    onPick(time);
    close();
  };
  return (
    <div className="dp">
      <label className="dp-type">
        <span className="sr-only">Type a time</span>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (guessed) pick(guessed);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              list.current?.querySelector<HTMLElement>(`[data-time="${near}"]`)?.focus();
            }
          }}
          placeholder="Type: 9:30, 2pm…"
          spellCheck={false}
          autoComplete="off"
        />
        {typed.trim() ? <span className={cx("dp-guess", guessed ? "text-muted" : "text-danger")}>{guessed ? timeLabel(guessed) : "?"}</span> : null}
      </label>
      <div
        ref={list}
        role="listbox"
        aria-label="Times"
        className="dp-times"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-time]") ?? []);
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }}
      >
        {times.map((time) => (
          <button key={time} type="button" role="option" aria-selected={time === value} data-time={time} data-selected={time === value || undefined} className="dp-time" onClick={() => pick(time)}>
            {timeLabel(time)}
          </button>
        ))}
      </div>
    </div>
  );
}

type TimeProps = { value: string; onChange: (value: string) => void; label: string; placeholder?: string; step?: number; clearable?: boolean; look?: Look; disabled?: boolean; className?: string; id?: string };

/** A time of day, as `HH:MM` ("" when empty). */
export function TimeInput({ value, onChange, label, placeholder = "Time", step = 15, clearable = false, look = "field", disabled, className, id }: TimeProps) {
  return (
    <span className={cx("dp-wrap", look === "field" ? "flex min-w-0" : "inline-flex min-w-0", className)}>
      <Popover
        fill={look === "field"}
        width={180}
        maxHeight={360}
        trigger={(open, toggle) => (
          <button type="button" id={id} aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={toggle} className={cx(TRIGGER[look], "dp-trigger")} data-open={open || undefined}>
            <Clock3 size={look === "inline" ? 13 : 14} className="dp-icon shrink-0" aria-hidden />
            <span className={cx("min-w-0 flex-1 truncate tabular-nums", !value && "text-faint")}>{value ? timeLabel(value) : placeholder}</span>
          </button>
        )}
      >
        {(close) => <TimeList value={value} step={step} onPick={onChange} close={close} />}
      </Popover>
      {clearable && value && !disabled ? (
        <button type="button" className="dp-clear" aria-label={`Clear ${label.toLowerCase()}`} title="Clear" onClick={() => onChange("")}>
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * A day and a time, as `YYYY-MM-DDTHH:MM` ("" when empty): the date first; its time starts at
 * `defaultTime` and can be changed. Clearing the date clears both.
 */
export function DateTimeInput({ value, onChange, label, defaultTime = "09:00", min, max, clearable = true, disabled, className, id }: { value: string; onChange: (value: string) => void; label: string; defaultTime?: string; min?: string; max?: string; clearable?: boolean; disabled?: boolean; className?: string; id?: string }) {
  const fallback = useId();
  const [day = "", time = ""] = value ? value.split("T") : [];
  return (
    <span className={cx("flex min-w-0 flex-wrap items-center gap-1.5", className)} role="group" aria-label={label}>
      <DateInput id={id ?? fallback} label={`${label}: date`} value={day} min={min} max={max} clearable={clearable} disabled={disabled} className="min-w-[150px] flex-[2_1_150px]" onChange={(next) => onChange(next ? `${next}T${time.slice(0, 5) || defaultTime}` : "")} />
      <TimeInput label={`${label}: time`} value={time.slice(0, 5)} disabled={disabled || !day} className="min-w-[104px] flex-[1_1_104px]" onChange={(next) => day && onChange(`${day}T${next || defaultTime}`)} />
    </span>
  );
}
