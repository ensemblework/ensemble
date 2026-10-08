"use client";

import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBinding } from "@ensemble/shared-types";
import { useShortcuts } from "@/lib/shortcut-store";
import { hasModule, moduleForPath } from "@ensemble/shared-types/modules";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { api } from "@/lib/api";
import { switchSpace } from "@/lib/spaces";
import { plural } from "@/lib/format";
import { isApplePlatform, modKey } from "@/lib/platform";
import { warmPeek } from "@/lib/warm";
import { SearchQuery } from "@/components/motion/search-query";
import { cx } from "../ui";
import { usePeek } from "./peek";

const PAGES: Array<{ href: string; label: string; hint: string }> = [
  { href: "/today", label: "Today", hint: "Focus and proposals" },
  { href: "/board", label: "Board", hint: "Move work by status" },
  { href: "/needs-me", label: "Needs me", hint: "Approvals and questions" },
  { href: "/meetings", label: "Meeting notes", hint: "Notes and recaps" },
  { href: "/recap", label: "Weekly recap", hint: "Done, decided, slipped" },
  { href: "/runs", label: "Runs", hint: "What the agent did" },
  { href: "/context", label: "Context", hint: "People, projects, graph" },
  { href: "/skills", label: "Skills", hint: "How the agent should work" },
  { href: "/workspace", label: "Workspace", hint: "The agent queue" },
  { href: "/code", label: "Code", hint: "Reviews and repos" },
  { href: "/diagrams", label: "Block diagrams", hint: "Draw systems and flows" },
  { href: "/plots", label: "Plots", hint: "Chart a table in two dimensions" },
  { href: "/metrics", label: "Metrics", hint: "Calls and cost" },
  { href: "/settings?tab=connections", label: "Connectors", hint: "Connect Google, Microsoft, Notion, Linear and more" },
  { href: "/connect", label: "Editors", hint: "Use Ensemble from VS Code, Cursor, Claude and other editors" },
  { href: "/settings", label: "Settings", hint: "Account and connections" },
  { href: "/settings#completed", label: "Completed", hint: "Finished tasks, in Settings" },
  { href: "/settings#trash", label: "Trash", hint: "Restore deleted items, in Settings" },
];

const ACTIONS: Array<{ id: string; label: string; hint: string; run: () => void }> = [
  { id: "act-capture", label: "Quick capture", hint: "New reminder", run: () => window.dispatchEvent(new CustomEvent("ensemble:capture")) },
  { id: "act-ask", label: "Ask Ensemble", hint: "Search your data", run: () => window.dispatchEvent(new CustomEvent("ensemble:ask")) },
  { id: "act-help", label: "Keyboard shortcuts", hint: "Help", run: () => window.dispatchEvent(new CustomEvent("ensemble:help")) },
];

type Item = { id: string; label: string; hint: string; run: () => void };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const peek = usePeek();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: open, staleTime: 20_000 });
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, enabled: open, staleTime: 30_000 });
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, enabled: open, staleTime: 30_000 });

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
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
      .filter((action) => !needle || `${action.label} ${action.hint}`.toLowerCase().includes(needle))
      .map((action) => ({
      id: action.id,
      label: action.label,
      hint: action.hint,
      run: action.run,
    }));
    const pages = PAGES.filter((page) => {
      const gate = moduleForPath(page.href);
      if (gate && !hasModule(modules, gate)) return false;
      // The owner's own pages are not there in a space shared with you.
      if (shell.data?.space?.shared && ["/today", "/metrics", "/connect", "/marketplace", "/trash"].includes(page.href)) return false;
      return !needle || `${page.label} ${page.hint}`.toLowerCase().includes(needle);
    }).map((page) => ({
      id: page.href,
      label: page.href === "/board" && shell.data?.labels?.board ? shell.data.labels.board : page.label,
      hint: page.hint,
      run: () => router.push(page.href),
    }));
    const rows = (tasks.data?.tasks ?? [])
      .filter((task) => task.status !== "dropped" && (!needle || task.title.toLowerCase().includes(needle)))
      .slice(0, 8)
      .map((task) => ({
        id: task.id,
        label: task.title,
        hint: shell.data?.labels?.task || "Task",
        run: () => peek.open(task.id),
      }));
    return [...actions, ...pages, ...rows];
  }, [query, tasks.data, router, peek, shell.data, spaces.data]);

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
  const tasksLoading = tasks.isLoading && !tasks.data;
  const needle = query.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pt-[14vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label="Command palette" className="pop-in w-full max-w-[560px]" onMouseDown={(event) => event.stopPropagation()}>
        <SearchQuery
          className="flex max-h-[calc(100dvh-14vh-16px)] min-h-0 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel p-2 shadow-pop"
          inputRef={input}
          value={query}
          onValue={setQuery}
          placeholder="Jump to a page or task"
          label="Jump to a page or task"
          kbd={`${modKey()}K`}
          pending={tasksLoading && needle && items.length === 0}
          count={items.length}
          list
          controls="command-list"
          resultsId="command-list"
          activeDescendant={items[selected] ? `cmd-${items[selected].id}` : undefined}
          status={tasksLoading ? "Looking up tasks…" : `${plural(items.length, "result")} · ↑↓ move · ↵ open`}
          emptyTitle="Nothing matches."
          emptyHint="Try a page name, or a task title."
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
                  if (item.hint === "Task") void warmPeek();
                }}
                onFocus={() => {
                  if (item.hint === "Task") void warmPeek();
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
