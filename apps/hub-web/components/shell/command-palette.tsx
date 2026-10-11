"use client";

import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBinding } from "@ensemble/shared-types";
import { useShortcuts } from "@/lib/shortcut-store";
import { hasModule } from "@ensemble/shared-types/modules";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { api } from "@/lib/api";
import { switchSpace } from "@/lib/spaces";
import { plural } from "@/lib/format";
import { isApplePlatform, modKey } from "@/lib/platform";
import { findSettingsTarget, SETTINGS_DESTINATION_BY_ID } from "../settings/navigation";
import { navigationDestinations, navigationScore } from "./navigation-destinations";
import { useModalFocus } from "@/lib/modal-focus";
import { SearchQuery } from "@/components/motion/search-query";
import { cx } from "../ui";

const ACTIONS: Array<{ id: string; label: string; hint: string; run: () => void }> = [
  { id: "act-capture", label: "Quick capture", hint: "New reminder", run: () => window.dispatchEvent(new CustomEvent("ensemble:capture")) },
  { id: "act-ask", label: "Ask Ensemble", hint: "Search your data", run: () => window.dispatchEvent(new CustomEvent("ensemble:ask")) },
  { id: "act-help", label: "Keyboard shortcuts", hint: "Help", run: () => window.dispatchEvent(new CustomEvent("ensemble:help")) },
];

type Item = { id: string; label: string; hint: string; run: () => void };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, onClose);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, enabled: open, staleTime: 30_000 });
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, enabled: open, staleTime: 30_000 });

  const items = useMemo<Item[]>(() => {
    const modules = shell.data?.modules;
    const actions = [
      ...ACTIONS,
      {
        id: "act-diagram",
        label: "Create diagram",
        hint: "New block diagram",
        run: () => {
          void api.createDiagram().then(({ diagram }) => router.push(`/diagrams/${diagram.id}`));
        },
      },
    ]
      .filter((action) => action.id !== "act-diagram" || hasModule(modules, "diagrams"))
      .concat(
        hasModule(modules, "plots")
          ? [{
              id: "act-plot",
              label: "Create plot",
              hint: "New 2D chart",
              run: () => {
                void api.createPlot().then(({ plot }) => router.push(`/plots/${plot.id}`));
              },
            }]
          : [],
      )
      .concat(
        (spaces.data?.spaces ?? [])
          .filter((space) => space.id !== spaces.data?.activeId)
          .map((space) => ({ id: `space-${space.id}`, label: `Switch to ${space.name}`, hint: "Space", run: () => void switchSpace(space.id) })),
        [{ id: "act-new-space", label: "New space", hint: "A separate line of work", run: () => router.push("/spaces/new") }],
      )
      .concat(
        shell.data?.devTools
          ? DESK_IDS.map((id) => ({
              id: `desk-${id}`,
              label: `Switch desk to ${DESKS[id].name}`,
              hint: "Tester",
              run: () => {
                void api.applyTemplate(MARKET_ID[id]).then(() => router.push("/today?apply=1"));
              },
            }))
          : [],
      )
      .filter((action) => navigationScore(query, action.label, action.hint)>0)
      .map((action) => ({
      id: action.id,
      label: action.label,
      hint: action.hint,
      run: action.run,
    }));
    const destinations = navigationDestinations(query, { modules, guest:Boolean(shell.data?.space?.shared), template:shell.data?.activeTemplateId, boardLabel:shell.data?.labels?.board }).map(row => ({ id:row.href, label:row.label, hint:row.hint, run:()=>{
      const url = new URL(row.href, window.location.origin);
      if (url.href === window.location.href) {
        const key = decodeURIComponent(url.hash.slice(1)), setting = SETTINGS_DESTINATION_BY_ID.get(key);
        const section = setting ? document.getElementById(setting.section) : null;
        (setting && section ? findSettingsTarget(section, setting.target) ?? section : document.getElementById(key))?.scrollIntoView({ block:"start" });
      } else router.push(row.href);
    } }));
    return [...destinations, ...actions];
  }, [query, router, shell.data, spaces.data]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    if (!open) return;
    const id = items[Math.min(index, Math.max(items.length - 1, 0))]?.id;
    const row = id ? document.getElementById(`cmd-${id}`) : null;
    const list = document.getElementById("command-list");
    if (!row || !list) return;
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
    else if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
  }, [open, index, items]);

  if (!open) return null;
  const selected = Math.min(index, Math.max(items.length - 1, 0));

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pt-[14vh]" onMouseDown={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Command palette" className="pop-in w-full max-w-[560px]" onMouseDown={(event) => event.stopPropagation()}>
        <SearchQuery
          className="flex max-h-[calc(100dvh-14vh-16px)] min-h-0 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel p-2 shadow-pop"
          inputRef={input}
          value={query}
          onValue={setQuery}
          placeholder="Jump to a view or setting"
          label="Jump to a view or setting"
          kbd={`${modKey()}K`}
          count={items.length}
          list
          controls="command-list"
          resultsId="command-list"
          activeDescendant={items[selected] ? `cmd-${items[selected].id}` : undefined}
          status={`${plural(items.length, "result")} · ↑↓ move · ↵ open`}
          emptyTitle="Nothing matches."
          emptyHint="Try a view or a setting, like Avatar or Devices."
          resultsClassName="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter" && items[selected]) {
              event.preventDefault();
              items[selected].run();
              onClose();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          results={items.map((item, itemIndex) => (
            <li key={item.id} id={`cmd-${item.id}`} className="sq-item" role="option" aria-selected={itemIndex === selected} style={{ ["--i" as string]: itemIndex }}>
              <button
                type="button"
                className={cx("flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left", itemIndex === selected ? "text-ink" : "text-ink/90")}
                onMouseEnter={() => {
                  setIndex(itemIndex);
                }}
                onClick={() => {
                  item.run();
                  onClose();
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{item.label}</span>
                <span className="k shrink-0">{item.hint}</span>
                {itemIndex === selected ? <CornerDownLeft size={13} className="text-faint" /> : null}
              </button>
            </li>
          ))}
        />
      </div>
    </div>
  );
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bindings } = useShortcuts();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pt-[18vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="pop-in max-h-[70vh] w-full max-w-[460px] overflow-y-auto rounded-xl border border-line-strong bg-panel p-4 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Shortcuts</h2>
          <span className="flex items-center gap-1">
            <a href="/settings?tab=shortcuts" className="btn-ghost" onClick={onClose}>
              Change
            </a>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        <ul className="space-y-1.5">
          {bindings.map((binding) => (
            <li key={binding.id} className="flex items-center justify-between gap-4 text-[13px]">
              <span className="text-muted">{binding.label}</span>
              <span className="kbd">{formatBinding(binding, isApplePlatform())}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
