"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useRef } from "react";
import { cx } from "../ui";
import { SETTINGS_TABS, type SettingsTab } from "./url-state";

/**
 * Settings tabs: a vertical list on wide screens, a scrolling row on narrow
 * ones. Arrow keys, Home and End move between tabs; each tab is also a real
 * link, so it can be opened in a new browser tab.
 */
export function SettingsTabs({ value, onChange }: { value: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const refs = useRef<Partial<Record<SettingsTab, HTMLAnchorElement | null>>>({});
  const move = (event: React.KeyboardEvent) => {
    const index = SETTINGS_TABS.findIndex((tab) => tab.id === value);
    const last = SETTINGS_TABS.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = SETTINGS_TABS[next]!.id;
    onChange(id);
    const node = refs.current[id];
    node?.focus();
    node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      onKeyDown={move}
      className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      data-settings-nav
    >
      {SETTINGS_TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <a
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            id={`settings-tab-${tab.id}`}
            role="tab"
            href={`?tab=${tab.id}`}
            aria-selected={selected}
            aria-controls="settings-panel"
            tabIndex={selected ? 0 : -1}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              if (!selected) onChange(tab.id);
            }}
            className={cx(
              "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors lg:whitespace-normal lg:px-2.5 lg:py-2",
              selected ? "bg-accent-soft font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
            )}
          >
            <span className="block">{tab.label}</span>
            <span className={cx("hidden text-[11.5px] font-normal leading-4 lg:block", selected ? "text-muted" : "text-faint")}>{tab.hint}</span>
          </a>
        );
      })}
    </div>
  );
}
