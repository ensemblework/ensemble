"use client";

/**
 * Code's quick open (docs/16 §1), as VS Code's: one box at the top of the window that finds a file
 * (Ctrl/⌘+P), runs a command (`>`, Ctrl/⌘+Shift+P or F1) or goes to a line (`:`, Ctrl+G). The window
 * says what each mode lists (`resolve`); this draws the box, the list and the keys. Styles: `code.css`.
 */
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { keyLabel } from "@/lib/code-quick-open";
import { isApplePlatform } from "@/lib/platform";

export type QuickItem = {
  id: string;
  label: string;
  /** Muted text after the label: a folder, a branch, a computer. */
  detail?: string;
  icon?: ReactNode;
  /** The command's shortcut, as `keyLabel` takes it (`mod+shift+p`). */
  keys?: string;
  /** Matched characters in the label and the detail, drawn in the accent. */
  hits?: number[];
  detailHits?: number[];
  /** Shown at the right of the first row of a run of rows with the same group ("recently opened"). */
  group?: string;
  run: () => void;
};

export type QuickList = {
  items: QuickItem[];
  placeholder: string;
  /** Said when nothing is listed. */
  empty: string;
  /** A line above the list (how to use this mode, or what Enter will do). */
  note?: string;
  loading?: boolean;
  /** The row picked first; quick open's history picks the second so Enter goes back to the last file. */
  preselect?: number;
};

/** `keyLabel` for this platform: Ctrl on the server's render and in tests, ⌘ once a Mac is seen. */
export function useKeyLabel(): (chords: string) => string {
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApplePlatform()), []);
  return (chords: string) => keyLabel(chords, apple);
}

/**
 * Goes to a page the way a link does (Next's client navigation) from a command. `link` must be rendered;
 * it is a hidden link that is clicked once. The window does not need the app router's hook for this.
 */
export function useLinkNavigate(): { link: ReactNode; go: (href: string) => void } {
  const [target, setTarget] = useState<{ href: string; nonce: number } | null>(null);
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (target) anchor.current?.click();
  }, [target]);
  return {
    link: target ? <Link key={target.nonce} ref={anchor} href={target.href} hidden tabIndex={-1} aria-hidden /> : null,
    go: (href: string) => setTarget({ href, nonce: Date.now() }),
  };
}

function Marked({ text, hits, className }: { text: string; hits?: number[]; className?: string }) {
  if (!hits?.length) return <span className={className}>{text}</span>;
  const marked = new Set(hits);
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const hit = marked.has(index);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[index];
    else parts.push({ text: text[index]!, hit });
  }
  return (
    <span className={className}>
      {parts.map((part, index) => (part.hit ? <span key={index} className="quick-open-hit">{part.text}</span> : part.text))}
    </span>
  );
}

export function QuickOpen({ initial, resolve, onClose }: { initial: string; resolve: (text: string) => QuickList; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const list = resolve(text);
  const [index, setIndex] = useState(list.preselect ?? 0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLUListElement>(null);
  const opener = useRef<Element | null>(null);
  const label = useKeyLabel();
  const count = list.items.length;
  const current = count ? Math.min(Math.max(0, index), count - 1) : -1;

  useLayoutEffect(() => {
    opener.current = document.activeElement;
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, []);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current, text]);

  const close = (restore: boolean) => {
    onClose();
    if (restore && opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true });
  };
  // The command runs after this key or click is over, so what it opens (a picker that listens for
  // Enter on the window) does not take the same key press.
  const choose = (item: QuickItem | undefined) => {
    if (!item) return;
    close(false);
    window.setTimeout(item.run, 0);
  };

  return (
    <div className="quick-open-layer" onMouseDown={() => close(true)}>
      <div className="quick-open" role="dialog" aria-label="Quick open" onMouseDown={(event) => event.stopPropagation()}>
        <div className="quick-open-field compound-field">
          <input
            ref={input}
            value={text}
            placeholder={list.placeholder}
            aria-label={list.placeholder}
            role="combobox"
            aria-expanded
            aria-controls="code-quick-open-list"
            aria-activedescendant={current >= 0 ? `code-quick-open-${current}` : undefined}
            spellCheck={false}
            autoComplete="off"
            className="bg-transparent outline-none"
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              setIndex(resolve(next).preselect ?? 0);
            }}
            onKeyDown={(event) => {
              const step = (delta: number) => {
                event.preventDefault();
                if (count) setIndex((current + delta + count) % count);
              };
              if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) step(1);
              else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) step(-1);
              else if (event.key === "PageDown") {
                event.preventDefault();
                setIndex(Math.min(count - 1, current + 10));
              } else if (event.key === "PageUp") {
                event.preventDefault();
                setIndex(Math.max(0, current - 10));
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                choose(list.items[current]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === "Tab") event.preventDefault();
            }}
          />
        </div>
        {list.note ? <div className="quick-open-note">{list.note}</div> : null}
        <ul ref={box} id="code-quick-open-list" role="listbox" aria-label="Results" className="quick-open-list">
          {list.items.map((item, row) => (
            <li
              key={item.id}
              id={`code-quick-open-${row}`}
              role="option"
              aria-selected={row === current}
              className="quick-open-row"
              onMouseMove={() => row !== current && setIndex(row)}
              onClick={() => choose(item)}
            >
              {item.icon ? <span className="quick-open-icon">{item.icon}</span> : null}
              <Marked text={item.label} hits={item.hits} className="quick-open-label" />
              {item.detail ? <Marked text={item.detail} hits={item.detailHits} className="quick-open-detail" /> : null}
              <span className="flex-1" />
              {item.group && item.group !== list.items[row - 1]?.group ? <span className="quick-open-group">{item.group}</span> : null}
              {item.keys ? <kbd className="quick-open-keys">{label(item.keys)}</kbd> : null}
            </li>
          ))}
          {!count ? <li className={cx("quick-open-empty", list.loading && "is-loading")}>{list.loading ? "Reading the files…" : list.empty}</li> : null}
        </ul>
      </div>
    </div>
  );
}
