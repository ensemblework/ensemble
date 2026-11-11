"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Bell, CircleUser, Database, Keyboard, Layers, Palette, Plug, Sparkles, Users, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useRef, type ComponentType } from "react";
import { AgentIcon } from "../agent-icon";
import { cx } from "../ui";
import { SETTINGS_TAB_GROUPS, SETTINGS_TABS, type SettingsTab } from "./url-state";

const ICONS: Record<SettingsTab, LucideIcon | ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>> = {
  account: CircleUser,
  appearance: Palette,
  notifications: Bell,
  shortcuts: Keyboard,
  assistant: Sparkles,
  agents: AgentIcon,
  connections: Plug,
  spaces: Layers,
  sharing: Users,
  data: Database,
};

/**
 * Settings tabs: a grouped vertical list on wide screens, a scrolling row on narrow
 * ones. Arrow keys, Home and End move between tabs; each tab is also a real
 * link, so it can be opened in a new browser tab.
 */
export function SettingsTabs({ value, onChange, hidden = [] }: { value: SettingsTab; onChange: (tab: SettingsTab) => void; hidden?: SettingsTab[] }) {
  const refs = useRef<Partial<Record<SettingsTab, HTMLAnchorElement | null>>>({});
  const list = useRef<HTMLDivElement>(null);
  const tabs = SETTINGS_TABS.filter((tab) => !hidden.includes(tab.id));
  useEffect(() => {
    // On a narrow screen the tabs are one scrolling row; bring the open tab into it. Only sideways, so the page stays put.
    const row = list.current;
    const node = refs.current[value];
    if (!row || !node || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const tab = node.getBoundingClientRect();
    if (tab.left < box.left) row.scrollLeft -= box.left - tab.left + 12;
    else if (tab.right > box.right) row.scrollLeft += tab.right - box.right + 12;
  }, [value]);
  const move = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const last = tabs.length - 1;
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
    const id = tabs[next]!.id;
    onChange(id);
    const node = refs.current[id];
    node?.focus();
    node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Settings sections"
      onKeyDown={move}
      className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0"
      data-settings-nav
    >
      {SETTINGS_TAB_GROUPS.map((group, groupIndex) => {
        const rows = tabs.filter((tab) => tab.group === group.id);
        if (!rows.length) return null;
        return (
          <Fragment key={group.id}>
            <div role="presentation" aria-hidden className={cx("hidden px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-faint lg:block", groupIndex > 0 && "pt-4")}>
              {group.label}
            </div>
            {rows.map((tab) => {
              const selected = tab.id === value;
              const Icon = ICONS[tab.id];
              return (
                <a
                  key={tab.id}
                  ref={(node) => {
                    refs.current[tab.id] = node;
                  }}
                  id={`settings-tab-${tab.id}`}
                  role="tab"
                  href={`?tab=${tab.id}`}
                  title={tab.hint}
                  aria-selected={selected}
                  aria-controls="settings-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                    event.preventDefault();
                    if (!selected) onChange(tab.id);
                  }}
                  className={cx(
                    "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors lg:flex lg:items-center lg:gap-2.5 lg:px-2.5 lg:py-[7px] lg:text-[13.5px]",
                    selected ? "bg-accent-soft font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
                  )}
                >
                  <Icon size={15} aria-hidden className={cx("hidden shrink-0 lg:block", selected ? "text-accent" : "text-faint")} />
                  <span className="block min-w-0 truncate">{tab.label}</span>
                </a>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
