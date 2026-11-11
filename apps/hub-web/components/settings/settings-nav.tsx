"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { cx } from "../ui";
import { searchSettings, type SettingsHit } from "./settings-search";
import { SettingsTabs } from "./settings-tabs";
import type { SettingsTab } from "./url-state";

type NavProps = {
  value: SettingsTab;
  onChange: (tab: SettingsTab) => void;
  onJump: (hit: SettingsHit) => void;
  hidden?: SettingsTab[];
  guest?: boolean;
  /** The element that scrolls the Settings page, for "On this page". */
  scroller: RefObject<HTMLElement | null>;
};

/**
 * The Settings nav: search, the grouped tabs, and the open tab's cards with the one in view marked.
 * On a narrow screen the tabs are one row and search opens in its place.
 */
export function SettingsNav({ value, onChange, onJump, hidden = [], guest = false, scroller }: NavProps) {
  const [searching, setSearching] = useState(false);
  return (
    <div className="relative" data-settings-sidebar>
      <div className={cx("items-center gap-2 lg:mb-5 lg:block", searching ? "flex" : "hidden")}>
        <SettingsSearch
          hidden={hidden}
          guest={guest}
          focus={searching}
          onJump={(hit) => {
            setSearching(false);
            onJump(hit);
          }}
          onDismiss={() => setSearching(false)}
        />
        <button type="button" className="btn-ghost shrink-0 px-2 text-[13px] lg:hidden" onClick={() => setSearching(false)}>
          Cancel
        </button>
      </div>
      <div className={cx("flex items-center gap-1 lg:block", searching && "hidden lg:block")}>
        <div className="min-w-0 flex-1">
          <SettingsTabs value={value} onChange={onChange} hidden={hidden} />
        </div>
        <button type="button" className="icon-btn shrink-0 lg:hidden" aria-label="Search settings" onClick={() => setSearching(true)}>
          <Search size={15} />
        </button>
      </div>
      <SettingsOutline tab={value} scroller={scroller} />
    </div>
  );
}

/** Finds a setting by a few words and jumps to it. ↑↓ choose, Enter opens, Esc clears. */
export function SettingsSearch({ hidden, guest, focus, onJump, onDismiss }: { hidden: SettingsTab[]; guest: boolean; focus?: boolean; onJump: (hit: SettingsHit) => void; onDismiss?: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchSettings(query, { guest, hidden }), [query, guest, hidden]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const shown = open && Boolean(query.trim());
  const go = (hit: SettingsHit | undefined) => {
    if (!hit) return;
    setQuery("");
    setOpen(false);
    input.current?.blur();
    onJump(hit);
  };
  return (
    <div className="relative min-w-0 flex-1">
      <div className="field compound-field flex h-8 items-center gap-2 px-2.5">
        <Search size={14} className="shrink-0 text-faint" aria-hidden />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="Search settings"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={`${id}-results`}
          aria-activedescendant={shown && hits[active] ? `${id}-${active}` : undefined}
          placeholder="Search settings"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (!hits.length) return;
              event.preventDefault();
              setOpen(true);
              setActive((current) => (current + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(hits[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery("");
              else {
                input.current?.blur();
                onDismiss?.();
              }
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button type="button" className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-faint hover:text-ink" aria-label="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        ) : null}
      </div>
      {shown ? (
        <div
          id={`${id}-results`}
          role="listbox"
          aria-label="Matching settings"
          className="absolute left-0 right-0 top-full z-40 mt-1.5 max-h-[min(26rem,70vh)] overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 shadow-pop lg:right-auto lg:w-[22rem]"
        >
          {hits.length ? (
            hits.map((hit, index) => (
              <div
                key={hit.key}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => go(hit)}
                className={cx("cursor-pointer rounded-md px-2.5 py-1.5", index === active && "bg-hover")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[13px] text-ink">{hit.label}</span>
                  <span className="shrink-0 text-[11.5px] text-faint">{hit.place}</span>
                </div>
                {hit.about ? <div className="truncate text-[12px] leading-[17px] text-muted">{hit.about}</div> : null}
              </div>
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12.5px] text-muted">No setting matches “{query.trim()}”.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

type OutlineItem = { label: string; node: HTMLElement };

/** The open tab's cards, read from the page, with the one in view marked. Wide screens only. */
function SettingsOutline({ tab, scroller }: { tab: SettingsTab; scroller: RefObject<HTMLElement | null> }) {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [current, setCurrent] = useState(0);
  // After a click the clicked card stays marked while the page scrolls to it, even if the page cannot bring it to the top.
  const pinned = useRef(0);
  useEffect(() => {
    const panel = document.getElementById("settings-panel");
    if (!panel) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const cards = [...panel.querySelectorAll<HTMLElement>("section[data-setting-label]")].filter((node) => !node.parentElement?.closest("section[data-setting-label]"));
        const next = cards.map((node) => ({ label: node.dataset.settingLabel!, node }));
        setItems((before) => (before.length === next.length && before.every((item, index) => item.node === next[index]!.node && item.label === next[index]!.label) ? before : next));
      });
    };
    read();
    // Cards come and go as a lazy tab loads and as data arrives (watchers, imports).
    const observer = new MutationObserver(read);
    observer.observe(panel, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [tab]);
  useEffect(() => {
    const root = scroller.current;
    if (!root || !items.length) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Date.now() < pinned.current) return;
        const line = root.getBoundingClientRect().top + 120;
        let index = 0;
        items.forEach((item, at) => {
          if (item.node.getBoundingClientRect().top <= line) index = at;
        });
        if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) index = items.length - 1;
        setCurrent(index);
      });
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      root.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [items, scroller]);
  if (items.length < 2) return null;
  return (
    <nav aria-label="On this page" className="mt-6 hidden lg:block [@media(max-height:760px)]:hidden" data-settings-outline>
      <div className="mb-2 px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">On this page</div>
      <ul className="ml-2.5 border-l border-line">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <button
              type="button"
              aria-current={index === current ? "location" : undefined}
              onClick={() => {
                setCurrent(index);
                pinned.current = Date.now() + 900;
                item.node.style.scrollMarginTop = "1.5rem";
                const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.reduceMotion === "true";
                item.node.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
              }}
              className={cx(
                "-ml-px block w-full truncate border-l py-[5px] pl-3 pr-2 text-left text-[12.5px] transition-colors",
                index === current ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink",
              )}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
