"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, Moon, PanelRight, PanelRightDashed, Redo2, Sun, Undo2 } from "lucide-react";
import { FetchGlyph } from "@/components/motion/slot";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useModKey } from "@/lib/platform";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, publishAppearance, usePersistentState } from "@/lib/prefs";
import { useLive } from "../live";
import { useToast } from "../toast";
import { cx } from "../ui";
import { ActivityControls } from "./activity-panel";
import { AskBar } from "./ask-bar";
import { NotificationBell } from "./notification-bell";
import { usePeek } from "./peek";

const TITLES: Array<[string, string]> = [
  ["/today", "Today"],
  ["/board", "Task board"],
  ["/needs-me", "Needs me"],
  ["/runs", "Runs"],
  ["/context", "Context"],
  ["/skills", "Skills"],
  ["/workspace", "Workspace"],
  ["/code", "Code"],
  ["/diagrams", "Block diagrams"],
  ["/plots", "Plots"],
  ["/metrics", "Metrics"],
  ["/connect", "Connect"],
  ["/meetings", "Meeting notes"],
  ["/recap", "Weekly recap"],
  ["/settings", "Settings"],
  ["/tasks", "Task"],
  ["/start", "Start"],
  ["/trash", "Trash"],
  ["/completed", "Completed"],
];

export function useUndoRedo() {
  const client = useQueryClient();
  const toast = useToast();
  const refresh = () => client.invalidateQueries();
  const announce = (result: { entryId?: string } | undefined, direction: "undo" | "redo") => {
    if (result?.entryId) window.dispatchEvent(new CustomEvent("ensemble:undo", { detail: { entryId: result.entryId, direction } }));
    void refresh();
  };
  const undo = useMutation({
    mutationFn: api.undo,
    onSuccess: (result) => {
      toast(result ? `Undid: ${result.label}` : "Nothing to undo.", {
        action: result ? { label: "Redo", run: () => redo.mutate() } : undefined,
      });
      announce(result, "undo");
    },
    onError: (error) => toast(String((error as Error).message), { tone: "error" }),
  });
  const redo = useMutation({
    mutationFn: api.redo,
    onSuccess: (result) => {
      toast(result ? `Redid: ${result.label}` : "Nothing to redo.");
      announce(result, "redo");
    },
    onError: (error) => toast(String((error as Error).message), { tone: "error" }),
  });
  return { undo, redo };
}

export function TopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const pathname = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const { connected, working } = useLive();
  const { mode, setMode } = usePeek();
  const { undo, redo } = useUndoRedo();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell });
  const canUndo = shell.data?.canUndo === true;
  const canRedo = shell.data?.canRedo === true;
  const [appearance] = usePersistentState<AppearanceSettings>(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  const title = TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Ensemble";

  const fetchNow = useMutation({
    mutationFn: api.fetchNow,
    onSuccess: (result) => {
      if (result.message) toast(result.message);
      else {
        const failed = result.results.filter((row) => !row.ok);
        toast(
          failed.length
            ? `${failed.length} source${failed.length === 1 ? "" : "s"} could not sync: ${failed[0]!.message}`
            : `Fetched ${result.results.length} source${result.results.length === 1 ? "" : "s"}.`,
          { tone: failed.length ? "error" : "ok" },
        );
      }
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable=true], .cm-editor, [data-diagram-editor]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const latest = client.getQueryData<{ canUndo?: boolean; canRedo?: boolean }>(["shell"]);
        if (event.shiftKey) {
          if (latest?.canRedo) redo.mutate();
        } else if (latest?.canUndo) undo.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, client]);

  const dark = appearance.theme !== "light";
  const mod = useModKey();

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
      <button type="button" className="icon-btn" onClick={onToggleSidebar} aria-label="Toggle sidebar">
        <Menu size={16} />
      </button>
      <div className="hidden min-w-0 shrink truncate text-[13.5px] font-medium sm:block sm:max-w-[140px]">{title}</div>
      <AskBar />
      <NotificationBell />
      <div className="flex items-center rounded-lg border border-line">
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-30" title={`Undo (${mod === "⌘" ? "⌘Z" : "Ctrl+Z"})`} onClick={() => undo.mutate()} disabled={!canUndo}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-30" title={`Redo (${mod === "⌘" ? "⇧⌘Z" : "Ctrl+Shift+Z"})`} onClick={() => redo.mutate()} disabled={!canRedo}>
          <Redo2 size={15} />
        </button>
      </div>
      <button
        type="button"
        className="btn-ghost text-ink"
        onClick={() => fetchNow.mutate()}
        disabled={fetchNow.isPending}
        title="Read every switched-on source now"
        aria-label="Fetch now"
      >
        <FetchGlyph active={fetchNow.isPending} size={14} />
        <span className="hidden sm:inline">Fetch now</span>
      </button>
      <ActivityControls connected={connected} />
      <button
        type="button"
        className="icon-btn"
        aria-label={mode === "side" ? "Tasks open in a side peek. Switch to a full page." : "Tasks open as a full page. Switch to a side peek."}
        aria-pressed={mode === "side"}
        title={mode === "side" ? "Tasks open in a side peek. Click for a full page." : "Tasks open as a full page. Click for a side peek."}
        onClick={() => {
          const next = mode === "side" ? "page" : "side";
          setMode(next);
          toast(next === "side" ? "Tasks will open in a side peek." : "Tasks will open as a full page.");
        }}
      >
        {mode === "side" ? <PanelRight size={15} /> : <PanelRightDashed size={15} />}
      </button>
      <button
        type="button"
        className="icon-btn"
        title={dark ? "Switch to light" : "Switch to dark"}
        onClick={() => publishAppearance({ ...appearance, theme: dark ? "light" : "dark" })}
      >
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}
