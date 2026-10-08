"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, MoreHorizontal, PanelRight, PanelRightDashed, Redo2, Undo2 } from "lucide-react";
import { FetchGlyph } from "@/components/motion/slot";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useModKey } from "@/lib/platform";
import { useLive } from "../live";
import { useToast } from "../toast";
import { MenuItem, Popover, cx } from "../ui";
import { ActivityControls } from "./activity-panel";
import { AccountMenu } from "./account-menu";
import { AskBar } from "./ask-bar";
import { NotificationBell } from "./notification-bell";
import { usePeek } from "./peek";
import { SharedBadge, SpacePeople } from "../sharing/people";

const TITLES: Array<[string, string]> = [
  ["/today", "Today"],
  ["/shared", "Shared with you"],
  ["/board", "Task board"],
  ["/needs-me", "Needs me"],
  ["/runs", "Runs"],
  ["/context", "Context"],
  ["/skills", "Skills"],
  ["/workspace", "Workspace"],
  ["/code", "Code"],
  ["/diagrams", "Diagrams"],
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
  // Connected apps are the owner's: someone a space is shared with does not fetch them.
  const guest = Boolean(shell.data?.space?.shared);
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

  const mod = useModKey();
  const toggleMode = () => {
    const next = mode === "side" ? "page" : "side";
    setMode(next);
    toast(next === "side" ? "Tasks will open in a side peek." : "Tasks will open as a full page.");
  };

  return (
    <header className="topbar grid h-11 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,560px)_minmax(max-content,1fr)] items-center gap-3 border-b border-line px-3 max-md:grid-cols-[auto_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="icon-btn" onClick={onToggleSidebar} aria-label="Toggle sidebar">
          <Menu size={16} />
        </button>
        <div className="hidden min-w-0 truncate text-[13.5px] font-medium sm:block">{title}</div>
        <SharedBadge />
      </div>
      <div className="flex min-w-0 justify-center">
        <AskBar />
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
      <SpacePeople />
      <NotificationBell />
      <div className="hidden items-center lg:flex">
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-30" title={`Undo (${mod === "⌘" ? "⌘Z" : "Ctrl+Z"})`} aria-label="Undo" onClick={() => undo.mutate()} disabled={!canUndo}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-30" title={`Redo (${mod === "⌘" ? "⇧⌘Z" : "Ctrl+Shift+Z"})`} aria-label="Redo" onClick={() => redo.mutate()} disabled={!canRedo}>
          <Redo2 size={15} />
        </button>
      </div>
      <span className="mx-1 hidden h-4 w-px bg-line lg:block" aria-hidden />
      <button
        type="button"
        className={cx("icon-btn hidden", !guest && "lg:inline-flex")}
        onClick={() => fetchNow.mutate()}
        disabled={fetchNow.isPending}
        title="Fetch now: read every switched-on source"
        aria-label="Fetch now"
      >
        <FetchGlyph active={fetchNow.isPending} size={15} />
      </button>
      <ActivityControls connected={connected} />
      <button
        type="button"
        className="icon-btn hidden lg:inline-flex"
        aria-label={mode === "side" ? "Tasks open in a side peek. Switch to a full page." : "Tasks open as a full page. Switch to a side peek."}
        aria-pressed={mode === "side"}
        title={mode === "side" ? "Tasks open in a side peek. Click for a full page." : "Tasks open as a full page. Click for a side peek."}
        onClick={toggleMode}
      >
        {mode === "side" ? <PanelRight size={15} /> : <PanelRightDashed size={15} />}
      </button>
      <Popover
        align="right"
        className="lg:hidden"
        trigger={(open, toggle) => (
          <button type="button" className="icon-btn" aria-label="More actions" aria-expanded={open} onClick={toggle}>
            <MoreHorizontal size={16} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem disabled={!canUndo || undo.isPending} onClick={() => { undo.mutate(); close(); }}><Undo2 size={14} /> Undo</MenuItem>
            <MenuItem disabled={!canRedo || redo.isPending} onClick={() => { redo.mutate(); close(); }}><Redo2 size={14} /> Redo</MenuItem>
            {guest ? null : <MenuItem disabled={fetchNow.isPending} onClick={() => { fetchNow.mutate(); close(); }}><FetchGlyph active={fetchNow.isPending} size={14} /> Fetch now</MenuItem>}
            <MenuItem onClick={() => { toggleMode(); close(); }}><PanelRight size={14} /> {mode === "side" ? "Open tasks as full pages" : "Open tasks in a side peek"}</MenuItem>
          </>
        )}
      </Popover>
      <AccountMenu />
      </div>
    </header>
  );
}
