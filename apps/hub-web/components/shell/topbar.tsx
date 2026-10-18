"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, MoreHorizontal, PanelRight, PanelRightDashed, Redo2, RefreshCw, Undo2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { sidebarRailForced } from "@/lib/sidebar-rail";
import { useModKey } from "@/lib/platform";
import { editingText, undoButtonLabel } from "@/lib/undo-ui";
import { useLive } from "../live";
import { useToast } from "../toast";
import { HomeLogoLink } from "../motion/brand-morph";
import { MenuItem, Popover, cx } from "../ui";
import { ActivityControls } from "./activity-panel";
import { AccountMenu } from "./account-menu";
import { AskBar } from "./ask-bar";
import { NotificationBell } from "./notification-bell";
import { usePeek } from "./peek";
import { SharedBadge, SpacePeople } from "../sharing/people";

const TITLES: Array<[string, string]> = [
  ["/today", "Today"],
  ["/pages", "Pages"],
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
  ["/files", "Files"],
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
      toast(result ? `Undid: ${result.label}` : "Nothing to undo from the last few minutes.", {
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

/** Whether the sidebar is showing: the drawer on a phone, the full (not rail) sidebar otherwise. */
function useSidebarExpanded(drawerOpen: boolean): boolean {
  const [state, setState] = useState({ narrow: false, rail: false });
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const read = () => {
      const root = document.documentElement;
      setState({ narrow: media.matches, rail: root.dataset.sidebar === "rail" || sidebarRailForced(root) });
    };
    read();
    media.addEventListener("change", read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar", "data-sidebar-auto", "data-pages-panel"] });
    return () => {
      media.removeEventListener("change", read);
      observer.disconnect();
    };
  }, []);
  return state.narrow ? drawerOpen : !state.rail;
}

export function TopBar({ onToggleSidebar, drawerOpen = false }: { onToggleSidebar: () => void; drawerOpen?: boolean }) {
  const pathname = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const { connected, serverError } = useLive();
  const { mode, setMode } = usePeek();
  const sidebarExpanded = useSidebarExpanded(drawerOpen);
  const { undo, redo } = useUndoRedo();
  const mod = useModKey();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell });
  const canUndo = shell.data?.canUndo === true;
  const canRedo = shell.data?.canRedo === true;
  const undoKeys = mod === "⌘" ? "⌘Z" : "Ctrl+Z";
  const redoKeys = mod === "⌘" ? "⇧⌘Z" : "Ctrl+Shift+Z";
  const undoName = canUndo ? undoButtonLabel("Undo", shell.data?.undoLabel) : "Nothing recent to undo";
  const redoName = canRedo ? undoButtonLabel("Redo", shell.data?.redoLabel) : "Nothing to redo";
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
      // In a text field or editor, Ctrl/Cmd+Z is that editor's own undo of your typing.
      if (editingText(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        // Not gated on the shell's cached canUndo: it can lag behind; the API says when there is nothing.
        if (event.shiftKey) redo.mutate();
        else undo.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const toggleMode = () => {
    const next = mode === "side" ? "page" : "side";
    setMode(next);
    toast(next === "side" ? "Tasks will open in a side peek." : "Tasks will open as a full page.");
  };

  return (
    <header className="topbar relative grid h-11 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,560px)_minmax(max-content,1fr)] items-center gap-3 border-b border-line px-3 max-md:grid-cols-[auto_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="topbar-sidebar-toggle icon-btn" onClick={onToggleSidebar} aria-label="Toggle sidebar" aria-expanded={sidebarExpanded}>
          <Menu size={16} />
        </button>
        <HomeLogoLink size={24} wordmark={false} className="md:hidden" />
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
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-70" title={`${undoName} (${undoKeys})`} aria-label={undoName} onClick={() => undo.mutate()} disabled={!canUndo || undo.isPending}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="icon-btn disabled:pointer-events-none disabled:opacity-70" title={`${redoName} (${redoKeys})`} aria-label={redoName} onClick={() => redo.mutate()} disabled={!canRedo || redo.isPending}>
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
        <RefreshCw className={fetchNow.isPending ? "animate-spin" : undefined} size={15} />
      </button>
      <ActivityControls connected={connected} serverError={serverError} />
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
            <MenuItem disabled={!canUndo || undo.isPending} onClick={() => { undo.mutate(); close(); }}><Undo2 size={14} /> <span className="min-w-0 truncate">{canUndo ? undoName : "Undo"}</span></MenuItem>
            <MenuItem disabled={!canRedo || redo.isPending} onClick={() => { redo.mutate(); close(); }}><Redo2 size={14} /> <span className="min-w-0 truncate">{canRedo ? redoName : "Redo"}</span></MenuItem>
            {guest ? null : <MenuItem disabled={fetchNow.isPending} onClick={() => { fetchNow.mutate(); close(); }}><RefreshCw size={14} /> Fetch now</MenuItem>}
            <MenuItem onClick={() => { toggleMode(); close(); }}><PanelRight size={14} /> {mode === "side" ? "Open tasks as full pages" : "Open tasks in a side peek"}</MenuItem>
          </>
        )}
      </Popover>
      <AccountMenu />
      </div>
    </header>
  );
}
