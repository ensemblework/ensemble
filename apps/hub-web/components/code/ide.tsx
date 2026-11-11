"use client";

/**
 * The Code tab's IDE (docs/16 §1): an activity bar (files, find in files, source control), the
 * explorer with the run's changes and the whole folder, editor tabs, the editor (Changes and File
 * views of one document), a terminal panel and a status bar. Full screen fills the window.
 *
 * It works on this computer's Ensemble or, on Ensemble on the web, on a paired computer through it
 * (`lib/code-target.tsx`); nothing here knows which.
 *
 * Saving: 0.7 s after typing stops, on Ctrl+S, when you switch file or view, and before a commit or
 * push. A save names the file as the editor read it, so a file something else changed meanwhile is
 * never overwritten: a bar offers Keep mine or Use the version on disk.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  ChevronsDownUp,
  Code2,
  Columns2,
  Copy,
  Download,
  Eye,
  FilePlus2,
  Files,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HelpCircle,
  House,
  Keyboard,
  Laptop,
  ListChecks,
  Lock,
  Maximize2,
  Minimize2,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  Search,
  TerminalSquare,
  Undo2,
  Upload,
  WifiOff,
  X,
} from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { ActivityBar, BottomPanel, FONT_MAX, FONT_MIN, FontSizeControl, OnlineDot, PanelHeader, SidePanel, StatusBar, StatusItem, useIdeKeys, useIdeLayout, type IdeLayout } from "@/components/code/ide-chrome";
import { IdeSpace, THEME_PICKER_EVENT, ThemeControl } from "@/components/code/ide-theme";
import type { ChunkCounts, ReviewEditorHandle, ReviewMode } from "@/components/code/review-editor";
import { CommitPanel } from "@/components/code/commit-panel";
import { SourceControl } from "@/components/code/source-control";
import { Terminal } from "@/components/code/terminal";
import { useToast } from "@/components/toast";
import { MenuItem, Popover, SkeletonRows, Spinner, cx } from "@/components/ui";
import { useSpaceAccess } from "@/lib/access";
import { api, ApiError, type ChangedFile, type CodeCreated, type CodeTreeEntry, type CodeVersions } from "@/lib/api";
import { useCodeApi, type Source } from "@/lib/code-target";
import { openTab } from "@/lib/code-tabs";
import { dateTime, languageFor } from "@/lib/format";
import { looksLikeId, repoName, repoViews, shortBranch, viewFor } from "@/lib/code-repos";
import { usePersistentState } from "@/lib/prefs";
import { Fold } from "./code-lists";
import { FileIcon } from "./file-icon";
import { FilePreview } from "./file-preview";
import { CODE_ASKS, askEnsemble, codeEditorMenu, downloadFromCode, explorerMenu, folderMenu, folderOf, nameOf, tabMenu, type CodeMenuContext } from "./code-menus";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { copyText } from "@/components/context-menu/builders";
import { previewOf } from "@/lib/file-kinds";
import { desktopShell } from "@/lib/desktop-param";
import { parseQuickInput, rankByLabel, rankFiles } from "@/lib/code-quick-open";
import { QuickOpen, useKeyLabel, type QuickItem, type QuickList } from "./quick-open";

type EditorModule = typeof import("@/components/code/review-editor");
let editorModule: EditorModule | null = null;
let editorPromise: Promise<EditorModule> | null = null;
function loadEditor(): Promise<EditorModule> {
  editorPromise ??= import("@/components/code/review-editor").then((mod) => (editorModule = mod));
  return editorPromise;
}

function useReviewEditor(): EditorModule["ReviewEditor"] | null {
  const [mod, setMod] = useState<EditorModule | null>(editorModule);
  useEffect(() => {
    if (mod) return;
    let live = true;
    void loadEditor().then((loaded) => live && setMod(loaded));
    return () => {
      live = false;
    };
  }, [mod]);
  return mod?.ReviewEditor ?? null;
}

const STATUS_COLOR: Record<string, string> = { A: "text-ok", U: "text-ok", M: "text-warn", D: "text-danger", R: "text-accent" };
const SAVE_MS = 700;

type Panel = "files" | "search" | "scm";
/** What the command palette asks of the explorer. */
type ExplorerAsk = "new-file" | "new-folder" | "collapse";

/** Whether this browser is online (`navigator.onLine`), kept up to date. */
function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type Buffer = { text: string; dirty: boolean; hash: string | null };

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.("input, textarea, select, [contenteditable=true]"));
}

function inEditor(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.(".cm-editor"));
}

/** A small ring for how much of a file's agent changes are decided. */
function Ring({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const share = Math.min(1, done / total);
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" aria-label={`${done} of ${total} decided`}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke={share >= 1 ? "rgb(var(--ok-rgb, 46 160 67))" : "currentColor"} strokeWidth="2" strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

/** The shortcut sheet, as `keyLabel` chords (`mod` is ⌘ on a Mac, Ctrl elsewhere). */
const SHORTCUTS: Array<[string, string]> = [
  ["mod+p", "Go to file (type :12 after the name for a line)"],
  ["mod+shift+p / f1", "Show all commands"],
  ["ctrl+g", "Go to line"],
  ["mod+shift+f", "Find in files (with the selection)"],
  ["mod+shift+e", "Explorer"],
  ["ctrl+shift+g", "Source control"],
  ["alt+y", "Accept the agent's change at the cursor (in a checkout: stage it)"],
  ["alt+n", "Reject the agent's change, or revert your edit"],
  ["mod+z", "Undo, including a reject"],
  ["f7 / shift+f7", "Next / previous change (crosses files)"],
  ["alt+arrowright / alt+arrowleft", "Next / previous changed file"],
  ["f4", "Changes ↔ whole file"],
  ["mod+shift+v", "Preview ↔ source (Markdown, HTML, SVG, CSV)"],
  ["f2", "Rename the file or folder picked in the explorer"],
  ["mod+s", "Save now (it also saves by itself)"],
  ["alt+w", "Close the file"],
  ["alt+1 / alt+9", "The first to eighth open file; 9 the last"],
  ["ctrl+pagedown / ctrl+pageup", "Next / previous open file"],
  ["mod+f", "Find and replace in the file"],
  ["mod+b", "Show or hide the side panel"],
  ["ctrl+`", "Terminal"],
  ["mod+shift+= / mod+shift+- / mod+shift+0", "Code text bigger / smaller / reset"],
  ["alt+shift+t", "Next starred theme"],
  ["escape", "Leave full screen"],
  ["?", "These shortcuts (outside the editor)"],
];

export function CodeIde({ source }: { source: Source }) {
  const access = useSpaceAccess();
  const client = useQueryClient();
  const toast = useToast();
  const { code, key, target } = useCodeApi();
  const ReviewEditor = useReviewEditor();
  const viewOnly = access.guest;

  // A paired computer's online state is read again every 30 s while its code is open.
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: target.kind === "device", staleTime: 30_000, refetchInterval: target.kind === "device" ? 30_000 : false });
  const computer = target.kind === "device" ? computers.data?.devices.find((row) => row.id === target.deviceId) ?? null : null;
  const info = useQuery({ queryKey: ["code-source", key, source], queryFn: () => code.codeSource(source), retry: false });
  const isReview = info.data?.kind === "review";
  const progress = useQuery({ queryKey: ["code-progress", key, source], queryFn: () => code.progress(source), enabled: Boolean(isReview), staleTime: 5_000 });
  // Names the checkout as Code's Welcome listed it, without asking again (`lib/code-repos.ts`).
  const knownRepos = useQuery({ queryKey: key === "local" ? ["code-repos"] : ["code-repos", key], queryFn: () => code.codeRepos(), enabled: false });
  const scm = useQuery({ queryKey: ["scm", key, info.data?.repo], queryFn: () => code.scm(info.data!.repo), enabled: Boolean(info.data?.repo) && !viewOnly, refetchInterval: 15_000, retry: false });

  const [panel, setPanel] = usePersistentState<Panel>("ensemble.code.sidebarPanel", "files");
  const layout = useIdeLayout();
  const [quick, setQuick] = useState<{ text: string; nonce: number } | null>(null);
  const openQuick = useCallback((text: string) => setQuick({ text, nonce: Date.now() }), []);
  useIdeKeys(layout, openQuick);
  const label = useKeyLabel();
  const { sideOpen, setSideOpen, closeOverlay, fontSize, setFontSize, terminal, setTerminal } = layout;
  // Saving waits while this browser or the computer is offline, and resumes when both are back.
  const online = useOnline();
  const reachable = online && (target.kind !== "device" || computer?.online !== false);
  const reachableRef = useRef(reachable);
  reachableRef.current = reachable;
  const [recent, setRecent] = useState<string[]>([]);
  const [searchAsk, setSearchAsk] = useState<{ text: string; nonce: number } | null>(null);
  const [explorerAsk, setExplorerAsk] = useState<{ kind: ExplorerAsk; nonce: number } | null>(null);
  const [flash, setFlash] = useState<{ path: string; text: string } | null>(null);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const files = useQuery({ queryKey: ["code-files", key, source], queryFn: () => code.files(source), enabled: quick !== null && !quick.text.startsWith(">"), staleTime: 30_000 });
  const [full, setFull] = useState(false);
  const [help, setHelp] = useState(false);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, ReviewMode>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const [revealInTree, setRevealInTree] = useState<{ path: string; nonce: number } | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [counts, setCounts] = useState<Record<string, ChunkCounts>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const buffers = useRef(new Map<string, Buffer>());
  const timers = useRef(new Map<string, number>());
  const openTabs = useRef<string[]>([]);
  useEffect(() => {
    openTabs.current = tabs;
  }, [tabs]);
  const editor = useRef<ReviewEditorHandle>(null);

  const changed: ChangedFile[] = useMemo(() => info.data?.files ?? [], [info.data]);
  const progressOf = useCallback((path: string) => progress.data?.files.find((row) => row.path === path) ?? null, [progress.data]);

  // The first changed file opens by itself, once: closing every file leaves the editor empty.
  useEffect(() => {
    if (!info.data || active || autoOpened.current) return;
    autoOpened.current = true;
    const first = changed[0]?.path;
    if (first) {
      setTabs([first]);
      setActive(first);
      setRecent([first]);
    }
  }, [info.data, changed, active]);

  const setState = useCallback((path: string, state: SaveState) => setSaveState((current) => (current[path] === state ? current : { ...current, [path]: state })), []);

  /** Writes one file now, unless it is unchanged. `force`: overwrite whatever is on disk (Keep mine). */
  const save = useCallback(
    async (path: string, force = false) => {
      window.clearTimeout(timers.current.get(path));
      const buffer = buffers.current.get(path);
      if (!buffer?.dirty) return;
      // Offline: the edit stays here, marked unsaved, and is written when the connection is back.
      if (!reachableRef.current) return;
      const text = buffer.text;
      setState(path, "saving");
      try {
        const result = await code.saveCodeFile(source, path, text, force ? undefined : buffer.hash);
        const now = buffers.current.get(path);
        if (now) buffers.current.set(path, { text: now.text, dirty: now.text !== text, hash: result.hash ?? now.hash });
        setState(path, now && now.text !== text ? "dirty" : "saved");
        client.setQueryData<CodeVersions>(["code-versions", key, source, path], (old) => (old ? { ...old, current: text, hash: result.hash ?? old.hash } : old));
        void client.invalidateQueries({ queryKey: ["code-progress", key, source] });
        void client.invalidateQueries({ queryKey: ["scm"] });
        void client.invalidateQueries({ queryKey: ["code-source", key, source] });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setState(path, "conflict");
          return;
        }
        setState(path, "error");
        toast((error as Error).message, { tone: "error" });
      }
    },
    [client, code, key, source, setState, toast],
  );

  const saveAll = useCallback(async () => {
    await Promise.all([...buffers.current.entries()].filter(([, buffer]) => buffer.dirty).map(([path]) => save(path)));
  }, [save]);

  // Back online: what waited is saved, and closed files' text then leaves the browser.
  useEffect(() => {
    if (reachable) void saveAll().then(() => {
      for (const path of [...buffers.current.keys()]) releaseRef.current(path);
    });
  }, [reachable, saveAll]);

  const onChange = useCallback(
    (path: string, text: string) => {
      const buffer = buffers.current.get(path);
      buffers.current.set(path, { text, dirty: true, hash: buffer?.hash ?? null });
      setState(path, "dirty");
      window.clearTimeout(timers.current.get(path));
      timers.current.set(path, window.setTimeout(() => void save(path), SAVE_MS));
    },
    [save, setState],
  );

  const releaseRef = useRef<(path: string) => void>(() => undefined);
  /** Drops a closed file's text from the browser once it is saved; an unsaved edit stays until it is. */
  const release = useCallback(
    (path: string) => {
      if (openTabs.current.includes(path) || buffers.current.get(path)?.dirty) return;
      window.clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      buffers.current.delete(path);
      client.removeQueries({ queryKey: ["code-versions", key, source, path] });
    },
    [client, key, source],
  );
  releaseRef.current = release;

  const open = useCallback(
    (path: string, line?: number) => {
      const next = openTab(tabs, path, active, (row) => Boolean(buffers.current.get(row)?.dirty) || saveState[row] === "saving");
      if ("refused" in next) {
        toast(next.refused, { tone: "error" });
        return;
      }
      if (active && active !== path) void save(active);
      openTabs.current = next.tabs;
      setTabs(next.tabs);
      if (next.closed) release(next.closed);
      setActive(path);
      setRecent((current) => (current[0] === path ? current : [path, ...current.filter((row) => row !== path)].slice(0, 30)));
      closeOverlay();
      if (line) setReveal({ path, line, nonce: Date.now() });
    },
    [active, closeOverlay, release, save, saveState, tabs, toast],
  );

  const close = useCallback(
    (path: string) => {
      const next = tabs.filter((row) => row !== path);
      openTabs.current = next;
      setTabs(next);
      if (active === path) setActive(next[Math.max(0, tabs.indexOf(path) - 1)] ?? null);
      void save(path).finally(() => release(path));
    },
    [active, release, save, tabs],
  );

  /** Several tabs at once (Close others, Close all…), each saved first. */
  const closeMany = useCallback(
    (paths: string[]) => {
      const gone = new Set(paths);
      const next = tabs.filter((row) => !gone.has(row));
      openTabs.current = next;
      setTabs(next);
      if (active && gone.has(active)) setActive(next[Math.max(0, Math.min(tabs.indexOf(active), next.length - 1))] ?? null);
      for (const path of paths) void save(path).finally(() => release(path));
    },
    [active, release, save, tabs],
  );

  /** A file or folder was renamed or moved: its tabs, and what they hold, follow it. */
  const moved = useCallback(
    (from: string, to: string) => {
      const map = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);
      for (const [path, buffer] of [...buffers.current.entries()]) {
        const next = map(path);
        if (next === path) continue;
        buffers.current.delete(path);
        buffers.current.set(next, buffer);
        window.clearTimeout(timers.current.get(path));
        timers.current.delete(path);
      }
      const remap = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).map(([path, value]) => [map(path), value]));
      setRecent((current) => current.map(map));
      setModes(remap);
      setPreviews(remap);
      setSaveState(remap);
      const next = tabs.map(map);
      openTabs.current = next;
      setTabs(next);
      if (active) setActive(map(active));
      void client.invalidateQueries({ queryKey: ["code-versions", key, source] });
    },
    [active, client, key, source, tabs],
  );

  /** Deleted from disk: its tabs close without saving (there is nothing to save to). */
  const removed = useCallback(
    (path: string) => {
      const gone = (row: string) => row === path || row.startsWith(`${path}/`);
      for (const row of [...buffers.current.keys()]) if (gone(row)) buffers.current.delete(row);
      const next = tabs.filter((row) => !gone(row));
      openTabs.current = next;
      setTabs(next);
      setRecent((current) => current.filter((row) => !gone(row)));
      if (active && gone(active)) setActive(next[next.length - 1] ?? null);
    },
    [active, tabs],
  );

  const showPreview = useCallback(
    (path: string, on?: boolean) => {
      if (!previewOf(path)) return;
      if (!tabs.includes(path) || active !== path) open(path);
      setPreviews((current) => ({ ...current, [path]: on ?? !current[path] }));
    },
    [active, open, tabs],
  );

  const reload = useCallback(
    async (path: string) => {
      buffers.current.delete(path);
      setState(path, "saved");
      await client.invalidateQueries({ queryKey: ["code-versions", key, source, path] });
      setReloads((current) => ({ ...current, [path]: (current[path] ?? 0) + 1 }));
    },
    [client, key, source, setState],
  );

  const changedIndex = active ? changed.findIndex((row) => row.path === active) : -1;
  const goFile = useCallback(
    (delta: number) => {
      if (!changed.length) return;
      const next = changed[(changedIndex + delta + changed.length) % changed.length];
      if (next) open(next.path);
    },
    [changed, changedIndex, open],
  );

  const mode: ReviewMode = (active && modes[active]) || "changes";
  const setMode = (next: ReviewMode) => {
    if (!active) return;
    void save(active);
    setModes((current) => ({ ...current, [active]: next }));
  };

  const showPanel = (id: Panel) => {
    setPanel(id);
    setSideOpen(true);
  };
  /** Find in files, with the editor's selection when it is one short line, searched at once. */
  const findInFiles = () => {
    const picked = editor.current?.selected().text ?? "";
    showPanel("search");
    setSearchAsk({ text: picked && !picked.includes("\n") && picked.length <= 200 ? picked : "", nonce: Date.now() });
  };
  const tabAt = (index: number) => {
    const path = index < 0 ? tabs[tabs.length - 1] : tabs[index];
    if (path) open(path);
  };
  const stepTab = (delta: number) => {
    if (!tabs.length) return;
    const from = active ? tabs.indexOf(active) : 0;
    tabAt((from + delta + tabs.length) % tabs.length);
  };

  // The editor's own keys (the window's are in useIdeKeys). None is a bare letter: every letter types.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
      // Option on a Mac turns letters and digits into other characters: read the physical key.
      const physical = /^(?:Key|Digit)(.)$/.exec(event.code ?? "")?.[1]?.toLowerCase() ?? letter;
      const writing = typing(event.target) && !inEditor(event.target);
      if (event.defaultPrevented) return;
      if (event.key === "F4") {
        event.preventDefault();
        setMode(mode === "changes" ? "file" : "changes");
      } else if (mod && event.shiftKey && (event.key === "V" || event.key === "v") && active && previewOf(active)) {
        event.preventDefault();
        showPreview(active);
      } else if (mod && !event.shiftKey && !event.altKey && letter === "s") {
        event.preventDefault();
        void saveAll();
      } else if (mod && event.shiftKey && !event.altKey && letter === "f") {
        event.preventDefault();
        findInFiles();
      } else if (mod && event.shiftKey && !event.altKey && letter === "e") {
        event.preventDefault();
        showPanel("files");
      } else if (event.ctrlKey && !event.metaKey && event.shiftKey && letter === "g" && !viewOnly) {
        event.preventDefault();
        showPanel("scm");
      } else if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && letter === "g") {
        event.preventDefault();
        openQuick(":");
      } else if (event.ctrlKey && !event.metaKey && (event.key === "PageDown" || event.key === "PageUp")) {
        event.preventDefault();
        stepTab(event.key === "PageDown" ? 1 : -1);
      } else if (event.altKey && !mod && !event.shiftKey && !writing && physical === "w") {
        event.preventDefault();
        if (active) close(active);
      } else if (mod && !event.altKey && !event.shiftKey && letter === "w" && active) {
        // Only the desktop app gets this far: a browser keeps Ctrl/⌘+W for its own tab.
        event.preventDefault();
        close(active);
      } else if (event.altKey && !mod && !event.shiftKey && !writing && /^[1-9]$/.test(physical)) {
        event.preventDefault();
        tabAt(physical === "9" ? -1 : Number(physical) - 1);
      } else if (event.altKey && !mod && event.key === "ArrowRight" && !typing(event.target)) {
        event.preventDefault();
        goFile(1);
      } else if (event.altKey && !mod && event.key === "ArrowLeft" && !typing(event.target)) {
        event.preventDefault();
        goFile(-1);
      } else if (event.key === "F7" && !inEditor(event.target)) {
        event.preventDefault();
        editor.current?.focus();
        if (event.shiftKey) editor.current?.previous();
        else editor.current?.next();
      } else if (event.key === "Escape" && full && !inEditor(event.target)) {
        setFull(false);
      } else if (event.key === "?" && !typing(event.target) && !inEditor(event.target)) {
        event.preventDefault();
        setHelp(!help);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Unsaved typing is written when the page goes away.
  useEffect(() => {
    const onHide = () => void saveAll();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void saveAll();
    };
  }, [saveAll]);

  const afterReview = () => {
    for (const query of [["reviews"], ["code-source", key, source], ["code-progress", key, source], ["code-versions"], ["scm"], ["task-jobs"]]) void client.invalidateQueries({ queryKey: query });
    for (const path of tabs) setReloads((current) => ({ ...current, [path]: (current[path] ?? 0) + 1 }));
  };
  const complete = useMutation({
    mutationFn: () => code.completeReview(source.review!),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
  const accept = useMutation({
    mutationFn: async () => {
      await saveAll();
      return code.acceptReview(source.review!);
    },
    onSuccess: (result) => {
      toast(result.commit ? `Accepted and committed on ${result.branch}.${result.pushable ? " Push when you are ready." : ""}` : "Accepted. The changes stay in the folder, uncommitted.", { tone: "ok" });
      afterReview();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const discard = useMutation({
    mutationFn: async () => {
      await saveAll();
      return code.discardReview(source.review!);
    },
    onSuccess: (result) => {
      setConfirmDiscard(false);
      toast(`Discarded. ${result.restored} ${result.restored === 1 ? "file is" : "files are"} back as the run found them.${result.keptCommits ? " Commits on this branch were kept; undo them in Source control." : ""}`, { tone: "ok" });
      afterReview();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const push = useMutation({
    mutationFn: () => code.pushReview(source.review!),
    onSuccess: (result) => toast(`Pushed ${result.branch} (fast-forward).`, { tone: "ok" }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (info.isLoading) return <IdeLoading layout={layout} />;
  if (info.error || !info.data) {
    return (
      <IdeSpace className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg" root>
        <IdeEmpty
          icon={<AlertTriangle size={40} strokeWidth={1.25} />}
          title="This folder could not be opened"
          message={(info.error as Error | null)?.message ?? "Code could not read it."}
          actions={
            <>
              <button type="button" className="btn" onClick={() => void info.refetch()}>
                <RefreshCw size={13} /> Try again
              </button>
              <Link href="/code" className="btn-ghost">Back to Code</Link>
            </>
          }
        />
      </IdeSpace>
    );
  }
  const data = info.data;
  const totals = progress.data;
  const activeState = active ? saveState[active] ?? "saved" : "saved";
  const where = target.kind === "device" ? computer?.name ?? "your computer" : null;
  const placeName = where ?? (desktopShell() ? "This computer" : "This server");
  const repoView = viewFor(data.repo, repoViews(knownRepos.data));
  const repoLabel = repoName(repoView);
  // A run's checkout is a folder named by its job id: it is shown by its task or origin instead.
  const title = !isReview && looksLikeId(data.title) ? repoView.name : data.title;
  const menuBase: CodeMenuContext = {
    code,
    source,
    repo: data.repo,
    repoLabel: repoLabel || title,
    viewOnly,
    toast,
    open: (path) => open(path),
    text: async (path) => buffers.current.get(path)?.text ?? (await code.codeFile(source, path)).content,
    preview: (path) => showPreview(path, true),
    reveal: (path) => {
      setPanel("files");
      setSideOpen(true);
      setRevealInTree({ path, nonce: Date.now() });
    },
  };
  const canDecide = !viewOnly && isReview && Boolean(data.review) && !data.review?.completedAt;
  const absolute = (path: string) => `${data.repo.replace(/[\\/]+$/, "")}/${path}`;
  const goHome = () => document.querySelector<HTMLAnchorElement>("[data-ide-home]")?.click();

  /** Every command the palette lists (Ctrl/⌘+Shift+P), in the order it lists them before you type. */
  const commands = (): Array<{ id: string; label: string; keys?: string; run: () => void }> => {
    const picked = editor.current?.selected();
    const selection = picked?.text.trim() ? picked : undefined;
    const fileCommands = active
      ? [
          { id: "save", label: "Save", keys: "mod+s", run: () => void save(active) },
          { id: "close", label: "Close the file", keys: "alt+w", run: () => close(active) },
          ...(changed.length ? [{ id: "view", label: mode === "changes" ? "Show the whole file" : "Show only the changes", keys: "f4", run: () => setMode(mode === "changes" ? "file" : "changes") }] : []),
          ...(previewOf(active) && previewOf(active) !== "image" ? [{ id: "preview", label: previews[active] ? "Show the source" : "Open preview", keys: "mod+shift+v", run: () => showPreview(active) }] : []),
          { id: "next-change", label: "Next change", keys: "f7", run: () => { editor.current?.focus(); editor.current?.next(); } },
          { id: "previous-change", label: "Previous change", keys: "shift+f7", run: () => { editor.current?.focus(); editor.current?.previous(); } },
          { id: "reveal", label: "Reveal the file in the explorer", run: () => menuBase.reveal!(active) },
          { id: "copy-path", label: "Copy the file's path", run: () => void copyText(absolute(active)) },
          { id: "copy-relative", label: "Copy the file's relative path", run: () => void copyText(active) },
          ...CODE_ASKS.map((ask) => ({ id: `ask-${ask.id}`, label: `Ask Ensemble: ${ask.label}${selection ? " (selection)" : ""}`, run: () => void askEnsemble(menuBase, active, ask.prompt, selection) })),
          { id: "attach", label: selection ? "Attach the selection to the assistant" : "Attach the file to the assistant", run: () => void askEnsemble(menuBase, active, undefined, selection) },
          { id: "download-file", label: "Download the file", run: () => void downloadFromCode(code, source, active, toast) },
        ]
      : [];
    return [
      { id: "go-file", label: "Go to file", keys: "mod+p", run: () => openQuick("") },
      ...(active ? [{ id: "go-line", label: "Go to line", keys: "ctrl+g", run: () => openQuick(":") }] : []),
      { id: "find", label: "Find in files", keys: "mod+shift+f", run: findInFiles },
      { id: "explorer", label: "Show the explorer", keys: "mod+shift+e", run: () => showPanel("files") },
      ...(viewOnly ? [] : [{ id: "scm", label: "Show source control", keys: "ctrl+shift+g", run: () => showPanel("scm") }]),
      { id: "side", label: sideOpen ? "Hide the side panel" : "Show the side panel", keys: "mod+b", run: () => setSideOpen(!sideOpen) },
      ...(viewOnly ? [] : [{ id: "terminal", label: terminal ? "Hide the terminal" : "Show the terminal", keys: "ctrl+`", run: () => setTerminal(!terminal) }]),
      ...fileCommands,
      ...(changed.length > 1 ? [
        { id: "next-file", label: "Next changed file", keys: "alt+arrowright", run: () => goFile(1) },
        { id: "previous-file", label: "Previous changed file", keys: "alt+arrowleft", run: () => goFile(-1) },
      ] : []),
      ...(tabs.length ? [{ id: "save-all", label: "Save all", run: () => void saveAll() }] : []),
      ...(tabs.length > 1 ? [{ id: "close-others", label: "Close the other files", run: () => closeMany(tabs.filter((row) => row !== active)) }] : []),
      ...(tabs.length ? [{ id: "close-all", label: "Close all files", run: () => closeMany(tabs) }] : []),
      ...(viewOnly ? [] : [
        { id: "new-file", label: "New file…", run: () => { showPanel("files"); setExplorerAsk({ kind: "new-file", nonce: Date.now() }); } },
        { id: "new-folder", label: "New folder…", run: () => { showPanel("files"); setExplorerAsk({ kind: "new-folder", nonce: Date.now() }); } },
      ]),
      { id: "collapse", label: "Collapse folders in the explorer", run: () => setExplorerAsk({ kind: "collapse", nonce: Date.now() }) },
      { id: "refresh", label: "Refresh the explorer", run: () => { for (const query of [["code-tree", key], ["code-files", key], ["code-source", key], ["scm"]]) void client.invalidateQueries({ queryKey: query }); } },
      ...(canDecide ? [
        { id: "accept-all", label: "Accept all agent changes", run: () => accept.mutate() },
        { id: "discard-all", label: "Discard all agent changes…", run: () => setConfirmDiscard(true) },
      ] : []),
      ...(!viewOnly && isReview && !data.review ? [{ id: "mark-reviewed", label: "Mark reviewed", run: () => complete.mutate() }] : []),
      ...(!viewOnly && isReview && data.review?.completedAt && data.review.canPush ? [{ id: "push", label: `Push ${data.branch}`, run: () => push.mutate() }] : []),
      { id: "download-repo", label: "Download the repository as a zip", run: () => void downloadFromCode(code, source, "", toast) },
      { id: "copy-folder", label: "Copy the folder's path", run: () => void copyText(data.repo) },
      { id: "theme", label: "Color theme…", run: () => window.dispatchEvent(new Event(THEME_PICKER_EVENT)) },
      { id: "bigger", label: "Bigger code text", keys: "mod+shift+=", run: () => setFontSize(Math.min(FONT_MAX, fontSize + 1)) },
      { id: "smaller", label: "Smaller code text", keys: "mod+shift+-", run: () => setFontSize(Math.max(FONT_MIN, fontSize - 1)) },
      { id: "full", label: full ? "Leave full screen" : "Full screen", run: () => setFull(!full) },
      { id: "shortcuts", label: "Keyboard shortcuts", keys: "?", run: () => setHelp(true) },
      { id: "home", label: "Back to Code home", run: goHome },
    ];
  };

  const fileItem = (path: string, run: () => void, extra: Partial<QuickItem> = {}): QuickItem => ({
    id: path,
    label: nameOf(path),
    detail: folderOf(path),
    icon: <FileIcon name={path} size={14} />,
    run,
    ...extra,
  });
  const resolveQuick = (text: string): QuickList => {
    const input = parseQuickInput(text);
    if (input.mode === "commands") {
      return {
        placeholder: "Type the name of a command",
        empty: "No command matches.",
        items: rankByLabel(input.query, commands()).map((row) => ({ id: row.id, label: row.label, keys: row.keys, hits: row.hits, run: row.run })),
      };
    }
    if (input.mode === "line") {
      if (!active) return { placeholder: "Go to line", empty: "Open a file first.", items: [] };
      const lines = (buffers.current.get(active)?.text ?? "").split("\n").length;
      const line = input.line ? Math.min(input.line, lines) : null;
      return {
        placeholder: "Go to line",
        note: `Type a line number between 1 and ${lines} in ${nameOf(active)}.`,
        empty: "",
        items: line ? [{ id: "line", label: `Go to line ${line}`, detail: nameOf(active), run: () => open(active, line) }] : [],
      };
    }
    const goTo = (path: string) => () => {
      open(path, input.line ?? undefined);
      focusEditorSoon();
    };
    if (!input.query) {
      const history = recent.length ? recent : changed.map((row) => row.path);
      return {
        placeholder: "Go to file by name. > for commands, : for a line",
        empty: "Type to find a file.",
        items: history.map((path) => fileItem(path, goTo(path), { group: recent.length ? "recently opened" : "changed" })),
        // The first is the file in view: Enter goes back to the one before it.
        preselect: history[0] === active && history.length > 1 ? 1 : 0,
      };
    }
    return {
      placeholder: "Go to file by name. > for commands, : for a line",
      empty: files.error ? (files.error as Error).message : "No file matches.",
      loading: files.isLoading,
      items: rankFiles(input.query, files.data?.files ?? []).map((row) => fileItem(row.path, goTo(row.path), { hits: row.nameHits, detailHits: row.folderHits })),
    };
  };
  /** Quick open hands the keyboard to the editor once the file it opened is there. */
  function focusEditorSoon() {
    let tries = 0;
    const tick = () => {
      if (editor.current && !document.querySelector(".quick-open")) {
        editor.current.focus();
        return;
      }
      if ((tries += 1) < 40) window.setTimeout(tick, 50);
    };
    window.setTimeout(tick, 50);
  }

  return (
    <IdeSpace className={cx("flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg", full ? "fixed inset-0 z-[70]" : "relative h-full")} root>
      {/* Title bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line px-2 text-[13px]" data-testid="ide-titlebar">
        <Link href="/code" className="icon-btn" title="Back to Code" aria-label="Back to Code" data-ide-home><ArrowLeft size={15} /></Link>
        <span className="truncate font-semibold">{title}</span>
        <span className="truncate text-muted" title={data.repo}>
          {repoLabel === title ? "" : `${repoLabel} · `}
          {shortBranch(data.branch)}
          {where ? ` · on ${where}` : ""}
        </span>
        <div className="flex-1" />
        {viewOnly ? (
          <span className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px] text-muted" title={`Accepting, rejecting, editing and pushing stay with ${access.owner ?? "the owner"}.`}>
            <Lock size={12} /> View only
          </span>
        ) : null}
        {!viewOnly && isReview && data.review && !data.review.completedAt ? (
          confirmDiscard ? (
            <>
              <span className="text-[12px] text-muted">Put the agent&apos;s files back as the run found them?</span>
              <button type="button" className="btn text-danger" disabled={discard.isPending} onClick={() => discard.mutate()}>
                {discard.isPending ? <Spinner size={12} /> : <Undo2 size={13} />} Yes, discard
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirmDiscard(false)}>Keep</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscard(true)}><Undo2 size={13} /> Discard all</button>
              <button type="button" className="btn-primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
                {accept.isPending ? <Spinner size={12} /> : <Check size={13} />} Accept all
              </button>
            </>
          )
        ) : null}
        {isReview && data.review?.completedAt ? <span className="text-[12px] text-muted">Reviewed</span> : null}
        {!viewOnly && isReview && data.review?.completedAt && data.review.canPush ? (
          <button type="button" className="btn" disabled={push.isPending} onClick={() => push.mutate()} title="Pushes this run's branch, fast-forward only, to the repository it was cloned from">
            {push.isPending ? <Spinner size={12} /> : <Upload size={13} />} Push {data.branch}
          </button>
        ) : null}
        {!viewOnly && isReview && !data.review ? (
          <button type="button" className="btn" onClick={() => complete.mutate()}><CheckCheck size={13} /> Mark reviewed</button>
        ) : null}
        <ThemeControl />
        <button type="button" className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => setHelp(!help)}><Keyboard size={15} /></button>
        <button type="button" className="icon-btn" title={full ? "Leave full screen (Esc)" : "Full screen"} aria-label={full ? "Leave full screen" : "Full screen"} onClick={() => setFull(!full)}>
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ActivityBar
          items={[
            { id: "home", icon: House, label: "Code home", href: "/code" },
            ...(
              [
                ["files", Files, `Explorer (${label("mod+b")})`],
                ["search", Search, `Find in files (${label("mod+shift+f")})`],
                ...(viewOnly ? [] : [["scm", GitBranch, `Source control (${label("ctrl+shift+g")})`] as const]),
              ] satisfies Array<readonly [Panel, typeof Files, string]>
            ).map(([id, icon, name]) => ({
              id,
              icon,
              label: name,
              active: sideOpen && panel === id,
              onClick: () => {
                if (sideOpen && panel === id) setSideOpen(false);
                else showPanel(id);
              },
            })),
          ]}
          bottom={viewOnly ? [] : [{ id: "terminal", icon: TerminalSquare, label: `Terminal (${label("ctrl+`")})`, active: terminal, onClick: () => setTerminal(!terminal) }]}
        />

        <SidePanel layout={layout}>
          {panel === "files" ? (
            <Explorer
              source={source}
              changed={changed}
              unreviewable={data.unreviewable}
              review={Boolean(isReview)}
              active={active}
              progressOf={progressOf}
              onOpen={open}
              canCreate={!viewOnly}
              menuBase={menuBase}
              reveal={revealInTree}
              onMoved={moved}
              onRemoved={removed}
              ask={explorerAsk}
              onQuickOpen={() => openQuick("")}
              folderName={repoLabel || title}
            />
          ) : panel === "search" ? (
            <SearchPanel source={source} onOpen={open} ask={searchAsk} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <PanelHeader title="Source control" />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CommitPanel source={source} draftKey={source.review ?? `${target.kind === "device" ? `${target.deviceId}:` : ""}${data.repo}`} beforeCommit={saveAll} pending={progress.data?.pending ?? 0} />
                <SourceControl repo={data.repo} onOpenFile={(path) => open(path)} beforeCommit={saveAll} commitForm={false} />
              </div>
            </div>
          )}
        </SidePanel>

        {/* Editor column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-sidebar text-[12.5px]">
            <button type="button" className="icon-btn my-auto ml-1 mr-0.5 h-7 w-7 shrink-0" title={`Show or hide the side panel (${label("mod+b")})`} aria-label="Show or hide the side panel" onClick={() => setSideOpen(!sideOpen)}>
              <PanelLeft size={14} />
            </button>
            <TabStrip
              tabs={tabs}
              active={active}
              saveState={saveState}
              previews={previews}
              closeLabel={label("alt+w")}
              onOpen={(path) => open(path)}
              onClose={close}
              onMenu={(event, path) => openContextMenu(event, () => tabMenu(menuBase, path, tabs, closeMany))}
            />
          </div>

          {!reachable ? (
            <div className="ide-notice" role="status" data-testid="ide-offline">
              <WifiOff size={13} className="shrink-0" />
              <span className="min-w-0 truncate">
                {online ? `${placeName} is offline. Your edits stay here and are saved when it is back.` : "You are offline. Your edits stay here and are saved when you are back online."}
              </span>
            </div>
          ) : null}

          {data.planted?.length ? (
            <div className="shrink-0 border-b border-line bg-raised px-3 py-2 text-[12.5px]">
              <div className="font-medium text-warn">These files can run later, outside the sandbox, when this folder is opened.</div>
              <ul className="mt-1 space-y-0.5 text-muted">
                {data.planted.map((hit) => (
                  <li key={`${hit.kind}:${hit.path}`}><span className="font-mono text-ink">{hit.path}</span> · {hit.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {active ? (
            <FilePane
              key={`${active}:${reloads[active] ?? 0}`}
              path={active}
              source={source}
              review={Boolean(isReview)}
              reviewId={data.review?.id ?? source.review ?? null}
              mode={mode}
              modeChosen={Boolean(modes[active])}
              setMode={setMode}
              viewOnly={viewOnly}
              fontSize={fontSize}
              reveal={reveal?.path === active ? reveal : null}
              saveState={activeState}
              buffers={buffers}
              editorRef={editor}
              Editor={ReviewEditor}
              taskId={data.taskId}
              changed={changed.find((row) => row.path === active) ?? null}
              counts={counts[active] ?? null}
              onCounts={(value) => setCounts((current) => ({ ...current, [active]: value }))}
              onCursor={(line, column) => setCursor({ line, column })}
              onChange={(text) => onChange(active, text)}
              onSave={() => void save(active)}
              onKeepMine={() => void save(active, true)}
              onUseDisk={() => void reload(active)}
              onChangedOnDisk={() => {
                void reload(active);
                setFlash({ path: active, text: "Updated from disk" });
              }}
              onReveal={(path) => menuBase.reveal!(path)}
              onEdge={(direction) => goFile(direction)}
              onAccepted={() => void client.invalidateQueries({ queryKey: ["code-progress", key, source] })}
              preview={Boolean(previews[active])}
              onPreview={() => showPreview(active)}
              onEditorMenu={(event) => {
                const handle = editor.current;
                if (!handle) return;
                openContextMenu(event, () => codeEditorMenu(menuBase, active, handle, viewOnly), { inFields: true });
              }}
            />
          ) : (
            <Watermark
              message={changed.length ? "Pick a file in the explorer, or find one by name." : `No changes to review. Everything on disk matches ${isReview ? "the tree this run started from" : "the index"}.`}
              rows={[
                ["Show all commands", "mod+shift+p", () => openQuick(">")],
                ["Go to file", "mod+p", () => openQuick("")],
                ["Find in files", "mod+shift+f", findInFiles],
                ...(viewOnly ? [] : [["Show or hide the terminal", "ctrl+`", () => setTerminal(!terminal)] as [string, string, () => void]]),
                ["Show or hide the side panel", "mod+b", () => setSideOpen(!sideOpen)],
              ]}
            />
          )}

          {terminal && !viewOnly ? (
            <BottomPanel layout={layout}>
              <Terminal initialCwd={data.repo} target={target} fontSize={fontSize} onClose={() => setTerminal(false)} />
            </BottomPanel>
          ) : null}
        </div>
      </div>

      <StatusBar>
        <PlaceIndicator
          name={placeName}
          online={reachable}
          browserOnline={online}
          folder={data.repo}
          onTerminal={viewOnly ? null : () => setTerminal(true)}
          onHome={goHome}
        />
        <StatusItem icon={GitBranch} title={scm.data?.branch ?? data.branch} onClick={viewOnly ? undefined : () => showPanel("scm")}>{shortBranch(scm.data?.branch ?? data.branch)}</StatusItem>
        {scm.data?.ahead ? <StatusItem icon={ArrowUp} title="Commits to push">{scm.data.ahead}</StatusItem> : null}
        {scm.data?.behind ? <StatusItem icon={ArrowDown} title="Commits to pull">{scm.data.behind}</StatusItem> : null}
        {isReview && totals ? (
          <StatusItem icon={ListChecks} title="Agent changes decided" onClick={() => showPanel("files")}>
            <span data-testid="ide-progress">
              {totals.total - totals.pending} / {totals.total} · {totals.filesLeft ? `${totals.filesLeft} file${totals.filesLeft === 1 ? "" : "s"} left` : "all decided"}
            </span>
          </StatusItem>
        ) : null}
        <div className="flex-1" />
        {active ? <StatusItem title={`Go to line (${label("ctrl+g")})`} onClick={() => openQuick(":")}>Ln {cursor.line}, Col {cursor.column}</StatusItem> : null}
        {active ? <span className="px-1.5">{languageFor(active)}</span> : null}
        {active ? <EolLabel source={source} path={active} /> : null}
        {active ? <span className="px-1.5 max-md:hidden">UTF-8</span> : null}
        {active ? (
          <span className={cx("px-1.5", (activeState === "error" || activeState === "conflict") && "text-danger", flash?.path === active && activeState === "saved" && "text-ink")} data-testid="ide-save-state">
            {activeState === "dirty" ? (reachable ? "• Unsaved" : "• Unsaved, offline") : activeState === "saving" ? "Saving…" : activeState === "error" ? "Not saved" : activeState === "conflict" ? "Changed on disk" : flash?.path === active ? flash.text : "Saved"}
          </span>
        ) : null}
        <FontSizeControl fontSize={fontSize} setFontSize={setFontSize} />
        {data.model ? <span className="hidden px-1.5 lg:inline">agent · {data.model} · {data.createdAt ? dateTime(data.createdAt) : ""}</span> : null}
      </StatusBar>

      {quick ? <QuickOpen key={quick.nonce} initial={quick.text} resolve={resolveQuick} onClose={() => setQuick(null)} /> : null}
      {help ? <ShortcutSheet onClose={() => setHelp(false)} /> : null}
    </IdeSpace>
  );
}

/**
 * The open files, as VS Code's tabs: the whole tab opens its file, a middle click closes it, the close
 * button shows on hover and on the file in view, and an unsaved file shows a dot that turns into the
 * close button on hover. Two files with one name show their folder. The strip scrolls sideways with the
 * wheel and keeps the file in view on screen; arrow keys move between tabs.
 */
function TabStrip({
  tabs,
  active,
  saveState,
  previews,
  closeLabel,
  onOpen,
  onClose,
  onMenu,
}: {
  tabs: string[];
  active: string | null;
  saveState: Record<string, SaveState>;
  previews: Record<string, boolean>;
  closeLabel: string;
  onOpen: (path: string) => void;
  onClose: (path: string) => void;
  onMenu: (event: React.MouseEvent, path: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  const names = new Map<string, number>();
  for (const path of tabs) names.set(nameOf(path), (names.get(nameOf(path)) ?? 0) + 1);
  const focusTab = (path: string) => window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(path)}"]`)?.focus());
  return (
    <div
      ref={strip}
      className="code-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto"
      role="tablist"
      aria-label="Open files"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {tabs.map((path, index) => {
        const state = saveState[path];
        const dirty = state === "dirty" || state === "saving";
        const name = nameOf(path);
        const folder = folderOf(path);
        const selected = path === active;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={selected}
            tabIndex={selected || (!active && index === 0) ? 0 : -1}
            title={dirty ? `${path} · unsaved` : path}
            data-tab-path={path}
            data-dirty={dirty || undefined}
            className="code-tab"
            onClick={() => {
              if (!selected) onOpen(path);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(path);
              }
            }}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? tabs[index + 1] : event.key === "ArrowLeft" ? tabs[index - 1] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
              if (next) {
                event.preventDefault();
                onOpen(next);
                focusTab(next);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(path);
              }
            }}
            onContextMenu={(event) => onMenu(event, path)}
          >
            {previews[path] ? <Eye size={14} className="shrink-0 text-muted" /> : <FileIcon name={path} size={14} />}
            <span className="min-w-0 truncate">{previews[path] ? `Preview ${name}` : name}</span>
            {(names.get(name) ?? 0) > 1 && folder ? <span className="code-tab-folder">{folder.split("/").pop()}</span> : null}
            <button
              type="button"
              className="code-tab-close"
              tabIndex={-1}
              aria-label={`Close ${name}`}
              title={dirty ? "Unsaved. It saves by itself; close it anyway" : `Close (${closeLabel})`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(path);
              }}
            >
              <span className="code-tab-dot" aria-hidden />
              <X size={13} className="code-tab-x" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The editor with no file open, as VS Code's watermark: what to do next and its keys. */
function Watermark({ message, rows }: { message: string; rows: Array<[string, string, () => void]> }) {
  const label = useKeyLabel();
  return (
    <div className="ide-watermark" data-testid="ide-watermark">
      <Code2 size={64} strokeWidth={1} className="ide-watermark-mark" aria-hidden />
      <p className="max-w-md text-center text-[13px] text-muted">{message}</p>
      <div className="ide-watermark-keys">
        {rows.map(([name, keys, run]) => (
          <button key={name} type="button" onClick={run}>
            <span>{name}</span>
            <kbd>{label(keys)}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A centred message in the editor area: an icon, what happened and what to do. */
function IdeEmpty({ icon, title, message, actions }: { icon: React.ReactNode; title: string; message: string; actions?: React.ReactNode }) {
  return (
    <div className="ide-watermark" role="alert">
      <span className="ide-watermark-mark">{icon}</span>
      <div className="max-w-md text-center">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="mt-1 text-[13px] text-muted [overflow-wrap:anywhere]">{message}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The window's frame while the folder is read, so nothing jumps when it arrives. */
function IdeLoading({ layout }: { layout: IdeLayout }) {
  return (
    <IdeSpace className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg" root>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2" data-testid="ide-loading">
        <Link href="/code" className="icon-btn" title="Back to Code" aria-label="Back to Code"><ArrowLeft size={15} /></Link>
        <span className="h-3 w-40 rounded bg-raised" aria-hidden />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-11 shrink-0 border-r border-line bg-sidebar" />
        {layout.sideOpen && !layout.phone ? (
          <div className="shrink-0 border-r border-line bg-sidebar px-3 pt-12" style={{ width: Math.max(200, layout.width) }}>
            <SkeletonRows count={7} rowClassName="h-[14px]" className="space-y-2" />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="h-9 shrink-0 border-b border-line bg-sidebar" />
          <div className="ide-progress" role="progressbar" aria-label="Opening the folder" />
        </div>
      </div>
      <div className="h-[22px] shrink-0 border-t border-line bg-sidebar" />
    </IdeSpace>
  );
}

/**
 * The status bar's first item, like VS Code's remote indicator: which computer this window works on,
 * whether it can be reached now, and its folder.
 */
function PlaceIndicator({ name, online, browserOnline, folder, onTerminal, onHome }: { name: string; online: boolean; browserOnline: boolean; folder: string; onTerminal: (() => void) | null; onHome: () => void }) {
  const state = online ? "online" : browserOnline ? "offline" : "this browser is offline";
  return (
    <Popover
      align="left"
      width={300}
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} className="ide-status-place" data-offline={online ? undefined : ""} title={`${name} · ${state}\n${folder}`} data-testid="ide-place">
          <Laptop size={11} className="shrink-0" />
          <span className="max-w-[14rem] truncate">{name}</span>
          <OnlineDot online={online} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pb-1.5 pt-1 text-[12px]">
            <div className="flex items-center gap-1.5 font-medium text-ink">
              <Laptop size={12} /> {name}
              <span className={cx("ml-auto text-[11px] font-normal", online ? "text-ok" : "text-muted")}>{state}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={folder}>{folder}</div>
          </div>
          <MenuItem onClick={() => { void copyText(folder); close(); }}>
            <span className="flex items-center gap-2"><Copy size={13} /> Copy the folder&apos;s path</span>
          </MenuItem>
          {onTerminal ? (
            <MenuItem onClick={() => { onTerminal(); close(); }}>
              <span className="flex items-center gap-2"><TerminalSquare size={13} /> Open the terminal here</span>
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => { onHome(); close(); }}>
            <span className="flex items-center gap-2"><House size={13} /> Back to Code</span>
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

function EolLabel({ source, path }: { source: Source; path: string }) {
  const { key } = useCodeApi();
  const client = useQueryClient();
  const versions = client.getQueryData<CodeVersions>(["code-versions", key, source, path]);
  return <span className="px-1.5">{versions?.eol === "crlf" ? "CRLF" : "LF"}</span>;
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const label = useKeyLabel();
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-lg flex-col rounded-lg border border-line bg-panel p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 font-semibold">
          <HelpCircle size={15} /> Code shortcuts
          <div className="flex-1" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          <table className="w-full text-[12.5px]">
            <tbody>
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={keys} className="border-t border-line">
                  <td className="whitespace-nowrap py-1 pr-3 font-mono text-[12px]">{label(keys).replace("Alt+1 / Alt+9", "Alt+1…9").replace("⌥1 / ⌥9", "⌥1…9")}</td>
                  <td className="py-1 text-muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-faint">No shortcut is a bare letter: every letter types.</p>
      </div>
    </div>
  );
}

type TreeEntryRef = { path: string; dir: boolean };

/** What every row of the explorer's tree shares: open folders, the drag in progress, renaming, menus. */
type TreeCtx = {
  source: Source;
  active: string | null;
  openDirs: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  canEdit: boolean;
  statusOf: (path: string) => string | null;
  dragging: string | null;
  dropDir: string | null;
  dragStart: (event: React.DragEvent, path: string) => void;
  dragEnd: () => void;
  dragOver: (event: React.DragEvent, folder: string) => void;
  drop: (event: React.DragEvent, folder: string) => void;
  renaming: string | null;
  setRenaming: (path: string | null) => void;
  rename: (from: string, name: string) => Promise<void>;
  menu: (event: React.MouseEvent, entry: TreeEntryRef) => void;
};

const TreeContext = createContext<TreeCtx | null>(null);
const TREE_DRAG = "application/x-ensemble-code-path";

function Explorer({
  source,
  changed,
  unreviewable,
  review,
  active,
  progressOf,
  onOpen,
  canCreate,
  menuBase,
  reveal,
  onMoved,
  onRemoved,
  ask,
  onQuickOpen,
  folderName,
}: {
  source: Source;
  changed: ChangedFile[];
  unreviewable: ChangedFile[];
  review: boolean;
  active: string | null;
  progressOf: (path: string) => { total: number; pending: number; yours: number } | null;
  onOpen: (path: string, line?: number) => void;
  canCreate: boolean;
  menuBase: CodeMenuContext;
  reveal: { path: string; nonce: number } | null;
  onMoved: (from: string, to: string) => void;
  onRemoved: (path: string) => void;
  /** A command palette request: a new file or folder where the explorer would put it, or fold every folder. */
  ask: { kind: ExplorerAsk; nonce: number } | null;
  onQuickOpen: () => void;
  folderName: string;
}) {
  const { code, key } = useCodeApi();
  const client = useQueryClient();
  const toast = useToast();
  // The folders open in the tree, and the one a new file goes in: the folder last clicked, or the open file's.
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [here, setHere] = useState<string | null>(null);
  const [creating, setCreatingRow] = useState<"file" | "folder" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const hover = useRef<{ dir: string; timer: number } | null>(null);
  const treeBox = useRef<HTMLDivElement>(null);
  const [, setFolds] = usePersistentState<Record<string, boolean>>("ensemble.code.folds", {});
  // Naming something new opens the Folder section, where the name is typed.
  const setCreating = (kind: "file" | "folder" | null) => {
    if (kind) setFolds((current) => (current.folder === false ? { ...current, folder: true } : current));
    setCreatingRow(kind);
  };
  const toggleDir = useCallback((path: string) => {
    setHere(path);
    setOpenDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const openFolders = useCallback((paths: string[]) => setOpenDirs((current) => new Set([...current, ...paths.filter(Boolean)])), []);
  const ancestors = (path: string) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  const base = here ?? (active && active.includes("/") ? active.slice(0, active.lastIndexOf("/")) : "");
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["code-tree", key] });
    void client.invalidateQueries({ queryKey: ["code-files", key] });
    void client.invalidateQueries({ queryKey: ["code-source", key] });
    void client.invalidateQueries({ queryKey: ["scm"] });
  }, [client, key]);
  const made = (created: CodeCreated) => {
    setCreating(null);
    refresh();
    if (!created.path) return;
    // Every folder on the way opens, so what was made shows in the tree.
    const parts = created.path.split("/");
    openFolders(parts.slice(0, created.kind === "folder" ? parts.length : -1).map((_, index) => parts.slice(0, index + 1).join("/")));
    if (created.kind === "folder") setHere(created.path);
    else onOpen(created.path);
  };

  // "Reveal in explorer": every folder on the way opens and the row scrolls into view.
  useEffect(() => {
    if (!reveal) return;
    openFolders(ancestors(reveal.path));
    const timer = window.setTimeout(() => {
      const row = treeBox.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(reveal.path)}"]`);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const move = useCallback(
    async (from: string, to: string) => {
      if (from === to) return;
      try {
        await code.move(source, from, to);
        onMoved(from, to);
        openFolders(ancestors(to));
        refresh();
      } catch (error) {
        toast(error instanceof Error ? error.message : "That could not be moved.", { tone: "error" });
      }
    },
    [code, source, onMoved, openFolders, refresh, toast],
  );

  /** Where a dragged entry may go: not where it is already, not into itself. */
  const canDrop = (from: string | null, folder: string) => Boolean(from && folder !== folderOf(from) && folder !== from && !folder.startsWith(`${from}/`));
  const stopHover = () => {
    if (hover.current) window.clearTimeout(hover.current.timer);
    hover.current = null;
  };

  const ctx = useMemo<CodeMenuContext>(
    () => ({
      ...menuBase,
      newEntry: (kind, folder) => {
        setHere(folder);
        if (folder) openFolders([...ancestors(folder), folder]);
        setCreating(kind);
      },
      rename: (path) => {
        openFolders(ancestors(path));
        setRenaming(path);
      },
      removed: (path) => {
        onRemoved(path);
        refresh();
      },
      refresh,
      collapse: () => {
        setOpenDirs(new Set());
        setHere(null);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuBase, onRemoved, refresh, openFolders],
  );

  const statusOf = useMemo(() => {
    const map = new Map(changed.map((row) => [row.path, row.status === "U" ? "A" : row.status]));
    return (path: string) => map.get(path) ?? null;
  }, [changed]);

  const tree: TreeCtx = {
    source,
    active,
    openDirs,
    onToggle: toggleDir,
    onOpen: (path) => {
      setHere(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
      onOpen(path);
    },
    canEdit: canCreate,
    statusOf,
    dragging,
    dropDir,
    dragStart: (event, path) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(TREE_DRAG, path);
      event.dataTransfer.setData("text/plain", path);
      setDragging(path);
    },
    dragEnd: () => {
      stopHover();
      setDragging(null);
      setDropDir(null);
    },
    dragOver: (event, folder) => {
      if (!canDrop(dragging, folder)) {
        if (dropDir !== null) setDropDir(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (dropDir !== folder) setDropDir(folder);
      // Holding over a closed folder opens it, as in VS Code.
      if (folder && !openDirs.has(folder) && hover.current?.dir !== folder) {
        stopHover();
        hover.current = { dir: folder, timer: window.setTimeout(() => openFolders([folder]), 650) };
      }
    },
    drop: (event, folder) => {
      const from = dragging ?? event.dataTransfer.getData(TREE_DRAG);
      stopHover();
      setDragging(null);
      setDropDir(null);
      if (!canDrop(from, folder)) return;
      event.preventDefault();
      event.stopPropagation();
      void move(from, folder ? `${folder}/${nameOf(from)}` : nameOf(from));
    },
    renaming,
    setRenaming,
    rename: async (from, name) => {
      setRenaming(null);
      const clean = name.trim();
      if (!clean || clean === nameOf(from)) return;
      const folder = folderOf(from);
      await move(from, folder ? `${folder}/${clean}` : clean);
    },
    menu: (event, entry) => openContextMenu(event, () => explorerMenu(ctx, entry)),
  };

  // The command palette's New file, New folder and Collapse folders.
  useEffect(() => {
    if (!ask) return;
    if (ask.kind === "collapse") {
      setOpenDirs(new Set());
      setHere(null);
    } else ctx.newEntry?.(ask.kind === "new-file" ? "file" : "folder", base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.nonce]);

  const label = useKeyLabel();
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title="Explorer" />
      <div className="px-2 pb-1.5">
        <button type="button" className="code-goto" onClick={onQuickOpen} title={`Go to file (${label("mod+p")})`}>
          <Search size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Go to file</span>
          <kbd>{label("mod+p")}</kbd>
        </button>
      </div>
      <div ref={treeBox} className="min-h-0 flex-1 overflow-y-auto pb-3">
        <Fold title={review ? "Changes from this run" : "Changes"} count={changed.length} persist="changes">
          <ul>
            {changed.map((row) => {
              const counts = progressOf(row.path);
              return (
                <li key={row.path}>
                  <button
                    type="button"
                    onClick={() => onOpen(row.path)}
                    onContextMenu={(event) => tree.menu(event, { path: row.path, dir: false })}
                    data-active={row.path === active || undefined}
                    className="code-tree-row pl-2"
                    title={row.path}
                  >
                    <FileIcon name={row.path} size={14} />
                    <span className={cx("min-w-0 flex-1 truncate", STATUS_COLOR[row.status])}>
                      {nameOf(row.path)}
                      <span className="ml-1.5 text-[11px] text-faint">{folderOf(row.path)}</span>
                    </span>
                    {counts?.pending ? <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 text-[10.5px] font-medium leading-4">{counts.pending}</span> : null}
                    {counts ? <Ring done={counts.total - counts.pending} total={counts.total} /> : <span className="shrink-0 text-2xs"><span className="text-ok">+{row.added}</span> <span className="text-danger">−{row.removed}</span></span>}
                    <span className={cx("w-3 shrink-0 text-center font-mono text-[11px]", STATUS_COLOR[row.status])}>{row.status === "U" ? "A" : row.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!changed.length ? <p className="px-5 py-0.5 text-[12px] text-faint">{review ? "Nothing left from this run." : "Nothing changed since the last commit."}</p> : null}
        </Fold>
        {unreviewable.length ? (
          <Fold title="Changed, can't be reviewed" count={unreviewable.length} persist="unreviewable">
            {unreviewable.map((row) => (
              <div key={row.path} className="truncate px-5 py-0.5 text-[12px] text-faint" title={row.path}>{row.path}</div>
            ))}
          </Fold>
        ) : null}
        <Fold
          title={<span title={menuBase.repo}>{folderName}</span>}
          persist="folder"
          actions={
            <span className="code-fold-actions">
              {canCreate ? (
                <>
                  <button type="button" className="icon-btn" title={`New file in ${base || "the top folder"}`} aria-label="New file" onClick={() => setCreating("file")}>
                    <FilePlus2 size={14} />
                  </button>
                  <button type="button" className="icon-btn" title={`New folder in ${base || "the top folder"}`} aria-label="New folder" onClick={() => setCreating("folder")}>
                    <FolderPlus size={14} />
                  </button>
                </>
              ) : null}
              <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh the folder" onClick={refresh}>
                <RefreshCw size={13} />
              </button>
              <button type="button" className="icon-btn" title="Collapse folders" aria-label="Collapse folders" onClick={() => { setOpenDirs(new Set()); setHere(null); }}>
                <ChevronsDownUp size={14} />
              </button>
              <button type="button" className="icon-btn" title="Download the repository as a zip (up to 20 MB)" aria-label="Download the repository" onClick={() => void downloadFromCode(code, source, "", toast)}>
                <Download size={14} />
              </button>
            </span>
          }
        >
          <div
            className={cx("code-tree min-h-16", dropDir === "" && "is-drop-root")}
            onContextMenu={(event) => openContextMenu(event, () => folderMenu(ctx))}
            onDragOver={(event) => tree.dragOver(event, "")}
            onDrop={(event) => tree.drop(event, "")}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(null);
            }}
          >
            {creating ? <CreateRow kind={creating} base={base} source={source} onDone={made} onCancel={() => setCreating(null)} /> : null}
            <TreeContext.Provider value={tree}>
              <TreeNode path="" depth={0} />
            </TreeContext.Provider>
          </div>
        </Fold>
      </div>
    </div>
  );
}

/** Renaming in place, as VS Code does: the name without its extension is picked, Enter renames, Esc keeps it. */
function RenameRow({ path, dir, depth }: { path: string; dir: boolean; depth: number }) {
  const tree = useContext(TreeContext)!;
  const input = useRef<HTMLInputElement>(null);
  const name = nameOf(path);
  const done = useRef(false);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    const dot = dir ? -1 : name.lastIndexOf(".");
    field.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [dir, name]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value === null) tree.setRenaming(null);
    else void tree.rename(path, value);
  };
  return (
    <div className="code-tree-row is-renaming" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="w-[11px] shrink-0" />
      {dir ? <Folder size={14} className="shrink-0 text-muted" /> : <FileIcon name={path} size={14} />}
      <input
        ref={input}
        defaultValue={name}
        aria-label={`Rename ${name}`}
        spellCheck={false}
        className="code-tree-rename"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          }
        }}
        onBlur={(event) => finish(event.currentTarget.value)}
      />
    </div>
  );
}

/**
 * Naming a new file or folder, as an editor's explorer does: the name (or a path, `lib/new.ts`, whose
 * folders are made too) goes in the folder shown; a full path (`~/notes/todo.md`) makes it elsewhere,
 * in the workspace or a folder Code can use. Enter makes it, Escape or leaving it empty cancels.
 */
function CreateRow({ kind, base, source, onDone, onCancel }: { kind: "file" | "folder"; base: string; source: Source; onDone: (created: CodeCreated) => void; onCancel: () => void }) {
  const { code } = useCodeApi();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const typedFull = /^[~/]/.test(name.trim());
  const create = useMutation({
    mutationFn: () => {
      const value = name.trim().replace(/\\/g, "/");
      return code.create(source, typedFull ? value : [base, value.replace(/^\.\//, "")].filter(Boolean).join("/"), kind);
    },
    onSuccess: onDone,
    onError: (failure) => setError((failure as Error).message),
  });
  const submit = () => {
    if (create.isPending) return;
    if (!name.trim()) return onCancel();
    setError("");
    create.mutate();
  };
  const Icon = kind === "file" ? FileText : Folder;
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-[rgb(var(--accent-rgb)/0.45)] bg-panel px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="shrink-0 text-muted" />
        <input
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            if (!name.trim() && !create.isPending) onCancel();
          }}
          placeholder={kind === "file" ? "File name" : "Folder name"}
          aria-label={kind === "file" ? "New file name" : "New folder name"}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-faint"
        />
        {create.isPending ? <Spinner size={11} /> : null}
      </div>
      <p className={cx("mt-1 truncate text-[10.5px]", error ? "text-danger" : "text-faint")} title={error || undefined}>
        {error || (typedFull ? "A full path: made there, if it is in the workspace or a folder Code can use" : `In ${base ? `${base}/` : "the top folder"} · Enter to make · Esc to cancel`)}
      </p>
    </div>
  );
}


function TreeNode({ path, depth }: { path: string; depth: number }) {
  const tree = useContext(TreeContext)!;
  const { code, key } = useCodeApi();
  const listing = useQuery({ queryKey: ["code-tree", key, tree.source, path], queryFn: () => code.tree(tree.source, path), staleTime: 15_000, retry: false });
  const pad = { paddingLeft: 8 + depth * 12 };
  if (listing.isLoading) return <div className="py-1" style={{ paddingLeft: 20 + depth * 12 }}><Spinner size={11} /></div>;
  if (listing.error) return <div className="py-1 pr-3 text-[12px] text-danger" style={pad}>{(listing.error as Error).message}</div>;
  const data = listing.data;
  if (!data) return null;
  return (
    <ul className="code-tree-level" style={{ "--tree-guide": `${14 + depth * 12}px` } as React.CSSProperties}>
      {data.entries.map((entry: CodeTreeEntry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const dir = entry.kind === "dir";
        const expanded = dir && tree.openDirs.has(child);
        const status = dir ? null : tree.statusOf(child);
        const drop = dir && tree.dropDir === child;
        return (
          <li key={entry.name} className={cx(drop && "is-drop")}>
            {tree.renaming === child ? (
              <RenameRow path={child} dir={dir} depth={depth} />
            ) : (
              <button
                type="button"
                disabled={entry.kind === "link"}
                title={entry.kind === "link" ? "A link that leads outside the repository" : child}
                data-tree-path={child}
                data-active={tree.active === child || undefined}
                data-dragging={tree.dragging === child || undefined}
                draggable={tree.canEdit && entry.kind !== "link"}
                onDragStart={(event) => tree.dragStart(event, child)}
                onDragEnd={tree.dragEnd}
                onDragOver={(event) => tree.dragOver(event, dir ? child : path)}
                onDrop={(event) => tree.drop(event, dir ? child : path)}
                onClick={() => (dir ? tree.onToggle(child) : tree.onOpen(child))}
                onContextMenu={(event) => tree.menu(event, { path: child, dir })}
                onKeyDown={(event) => {
                  if (event.key === "F2" && tree.canEdit) {
                    event.preventDefault();
                    tree.setRenaming(child);
                  }
                }}
                className="code-tree-row"
                style={pad}
                aria-expanded={dir ? expanded : undefined}
              >
                {dir ? <ChevronRight size={11} className={cx("shrink-0 text-faint transition-transform", expanded && "rotate-90")} /> : <span className="w-[11px] shrink-0" />}
                {dir ? expanded ? <FolderOpen size={14} className="code-tree-folder shrink-0" /> : <Folder size={14} className="code-tree-folder shrink-0" /> : <FileIcon name={entry.name} size={14} />}
                <span className={cx("min-w-0 flex-1 truncate", entry.secret && "text-faint", status && STATUS_COLOR[status])}>{entry.name}</span>
                {status ? <span className={cx("shrink-0 font-mono text-[10.5px]", STATUS_COLOR[status])}>{status}</span> : null}
              </button>
            )}
            {expanded ? <TreeNode path={child} depth={depth + 1} /> : null}
          </li>
        );
      })}
      {data.truncated ? <li className="py-1 text-[11px] text-faint" style={pad}>Only the first 2,000 entries.</li> : null}
      {data.hidden ? <li className="py-0.5 text-[11px] text-faint" style={pad}>{data.hidden} files of keys or secrets are not shown here</li> : null}
    </ul>
  );
}

/** The matched text in a result line, marked as VS Code marks it. */
function MatchLine({ text, query, matchCase }: { text: string; query: string; matchCase: boolean }) {
  const at = matchCase ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || !query) return <span className="truncate">{text}</span>;
  // Long lines start a little before the match so it is on screen.
  const from = at > 40 ? at - 24 : 0;
  return (
    <span className="truncate">
      {from ? "…" : ""}
      {text.slice(from, at)}
      <mark className="code-search-hit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </span>
  );
}

function SearchPanel({ source, onOpen, ask }: { source: Source; onOpen: (path: string, line?: number) => void; ask: { text: string; nonce: number } | null }) {
  const { code, key } = useCodeApi();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<{ q: string; matchCase: boolean } | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const field = useRef<HTMLInputElement>(null);
  const found = useQuery({ queryKey: ["code-search", key, source, asked], queryFn: () => code.search(source, asked!.q, asked!.matchCase), enabled: Boolean(asked?.q), retry: false });
  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ line: number; text: string }>>();
    for (const row of found.data?.results ?? []) map.set(row.path, [...(map.get(row.path) ?? []), { line: row.line, text: row.text }]);
    return [...map.entries()];
  }, [found.data]);
  // Ctrl/⌘+Shift+F: focus the box; with a selection, search for it at once.
  useEffect(() => {
    if (!ask) return;
    if (ask.text) {
      setText(ask.text);
      setAsked({ q: ask.text, matchCase });
    }
    window.requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.nonce]);
  const total = found.data?.results.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title="Find in files" />
      <form
        className="flex items-center gap-1 px-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) setAsked({ q: text.trim(), matchCase });
        }}
      >
        <input ref={field} value={text} onChange={(event) => setText(event.target.value)} placeholder="Search" aria-label="Find in files" className="field min-w-0 flex-1 py-1 text-[12.5px]" />
        <button type="button" className={cx("icon-btn h-7 w-7 font-mono text-[11px]", matchCase && "bg-hover text-ink")} title="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(!matchCase)}>Aa</button>
      </form>
      {found.data && grouped.length ? (
        <div className="px-3 pb-1 text-[11.5px] text-muted">
          {total}{found.data.truncated ? "+" : ""} {total === 1 ? "result" : "results"} in {grouped.length} {grouped.length === 1 ? "file" : "files"}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {found.isLoading && asked ? <div className="ide-progress" role="progressbar" aria-label="Searching" /> : null}
        {found.error ? <div className="px-3 text-danger">{(found.error as Error).message}</div> : null}
        {found.data && !grouped.length ? <div className="px-3 text-muted">Nothing found.</div> : null}
        {grouped.map(([path, rows]) => {
          const closed = folded.has(path);
          return (
            <div key={path}>
              <button
                type="button"
                className="code-tree-row pl-1.5"
                title={path}
                aria-expanded={!closed}
                onClick={() => setFolded((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })}
              >
                <ChevronRight size={11} className={cx("shrink-0 text-faint transition-transform", !closed && "rotate-90")} />
                <FileIcon name={path} size={14} />
                <span className="min-w-0 flex-1 truncate">
                  {nameOf(path)}
                  <span className="ml-1.5 text-[11px] text-faint">{folderOf(path)}</span>
                </span>
                <span className="shrink-0 rounded-full bg-raised px-1.5 text-[10.5px] tabular-nums leading-4 text-muted">{rows.length}</span>
              </button>
              {closed
                ? null
                : rows.map((row) => (
                    <button key={row.line} type="button" className="code-tree-row code-search-line pl-7" title={`${path}:${row.line}`} onClick={() => onOpen(path, row.line)}>
                      <MatchLine text={row.text} query={asked?.q ?? ""} matchCase={asked?.matchCase ?? false} />
                      <span className="ml-auto shrink-0 text-[10.5px] text-faint">{row.line}</span>
                    </button>
                  ))}
            </div>
          );
        })}
        {found.data?.truncated ? <div className="px-3 pt-1 text-[11px] text-faint">The first 500 results.</div> : null}
      </div>
    </div>
  );
}

function FilePane(props: {
  path: string;
  source: Source;
  review: boolean;
  reviewId: string | null;
  mode: ReviewMode;
  /** The person chose the view for this file; otherwise a file with nothing to review opens whole. */
  modeChosen: boolean;
  setMode: (mode: ReviewMode) => void;
  viewOnly: boolean;
  fontSize: number;
  reveal: { line: number; nonce: number } | null;
  saveState: SaveState;
  buffers: React.MutableRefObject<Map<string, Buffer>>;
  editorRef: React.RefObject<ReviewEditorHandle | null>;
  Editor: EditorModule["ReviewEditor"] | null;
  taskId: string | null;
  changed: ChangedFile | null;
  counts: ChunkCounts | null;
  onCounts: (counts: ChunkCounts) => void;
  onCursor: (line: number, column: number) => void;
  onChange: (text: string) => void;
  onSave: () => void;
  onKeepMine: () => void;
  onUseDisk: () => void;
  /** The file changed on the computer and nothing is typed here: it reloads. */
  onChangedOnDisk: () => void;
  /** A breadcrumb was clicked: that folder or file in the explorer. */
  onReveal: (path: string) => void;
  onEdge: (direction: 1 | -1) => void;
  onAccepted: () => void;
  /** Markdown, HTML, SVG and tables: rendered instead of the source. */
  preview: boolean;
  onPreview: () => void;
  onEditorMenu: (event: React.MouseEvent) => void;
}) {
  const { code, key } = useCodeApi();
  const client = useQueryClient();
  const toast = useToast();
  const { path, source, buffers } = props;
  const versions = useQuery({
    queryKey: ["code-versions", key, source, path],
    queryFn: () => code.versions(source, path),
    retry: false,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const [line, setLine] = useState(1);
  const restore = useMutation({
    mutationFn: () => code.restore(props.reviewId!, path),
    onSuccess: () => {
      props.onUseDisk();
      void client.invalidateQueries({ queryKey: ["code-progress", key, source] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const [confirmRestore, setConfirmRestore] = useState(false);

  const data = versions.data;
  // The text the editor opened with, kept so a refetch never replaces what you are typing.
  const opened = useRef<CodeVersions | null>(null);
  if (data && !opened.current) {
    opened.current = data;
    if (!buffers.current.get(path)?.dirty) buffers.current.set(path, { text: data.current ?? "", dirty: false, hash: data.hash });
  }
  // Something else changed the file: reload when nothing is typed here, otherwise ask (the save does too).
  const changedOnDisk = Boolean(data && opened.current && data.hash !== buffers.current.get(path)?.hash);
  const dirty = buffers.current.get(path)?.dirty ?? false;
  useEffect(() => {
    if (changedOnDisk && !dirty) props.onChangedOnDisk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedOnDisk, dirty]);

  useEffect(() => {
    const first = opened.current;
    if (first && !props.modeChosen && props.mode === "changes" && first.original === first.current) props.setMode("file");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const counts = props.counts;
  const readOnlyReason = props.viewOnly ? "View only." : data?.readOnly ?? (data?.tooLarge ? "Files over 5 MB are not opened here." : null);
  const parts = path.split("/");
  const previewKind = previewOf(path);
  // An image has nothing to read as text: it shows as the picture itself.
  const canPreview = Boolean(previewKind && previewKind !== "image");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line px-3 text-[12px]" data-testid="ide-filebar">
        <nav className="flex min-w-0 items-center gap-0.5 truncate text-muted" aria-label="Breadcrumbs">
          {parts.map((part, index) => (
            <span key={index} className="flex items-center gap-0.5">
              {index ? <ChevronRight size={11} className="shrink-0 text-faint" /> : null}
              <button type="button" className={cx("code-crumb", index === parts.length - 1 && "font-medium text-ink")} title={index === parts.length - 1 ? "Reveal in the explorer" : `Show ${parts.slice(0, index + 1).join("/")} in the explorer`} onClick={() => props.onReveal(parts.slice(0, index + 1).join("/"))}>
                {index === parts.length - 1 ? <FileIcon name={part} size={13} /> : null}
                {part}
              </button>
            </span>
          ))}
        </nav>
        {props.changed ? <span><span className="text-ok">+{props.changed.added}</span> <span className="text-danger">−{props.changed.removed}</span></span> : null}
        <div className="flex-1" />
        {props.review && counts ? (
          counts.agent === 0 ? (
            <span className="text-ok" data-testid="ide-file-reviewed">Reviewed. Edit freely</span>
          ) : (
            <span className="text-muted">{counts.agent} agent change{counts.agent === 1 ? "" : "s"} to decide{counts.yours ? ` · ${counts.yours} yours` : ""}</span>
          )
        ) : null}
        <button type="button" className="icon-btn h-6 w-6" title="Previous change (Shift+F7)" onClick={() => props.editorRef.current?.previous()}><ArrowUp size={13} /></button>
        <button type="button" className="icon-btn h-6 w-6" title="Next change (F7)" onClick={() => props.editorRef.current?.next()}><ArrowDown size={13} /></button>
        <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="View">
          {(["changes", "file"] as const).map((value) => (
            <button key={value} type="button" title={value === "changes" ? "Only the changes (F4)" : "The whole file (F4)"} onClick={() => { if (props.preview) props.onPreview(); props.setMode(value); }} className={cx("flex items-center gap-1 px-2 py-0.5", !props.preview && props.mode === value ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink")}>
              {value === "changes" ? <Columns2 size={11} /> : <FileText size={11} />} {value === "changes" ? "Changes" : "File"}
            </button>
          ))}
          {canPreview ? (
            <button type="button" title="Preview (Ctrl+Shift+V)" aria-pressed={props.preview} onClick={props.onPreview} className={cx("flex items-center gap-1 px-2 py-0.5", props.preview ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink")} data-testid="ide-preview">
              <Eye size={11} /> Preview
            </button>
          ) : null}
        </div>
        {props.review && props.reviewId && !props.viewOnly && data?.exists.agent !== undefined ? (
          confirmRestore ? (
            <span className="flex items-center gap-1">
              <span className="text-muted">Drop your edits and rejects in this file?</span>
              <button type="button" className="btn px-1.5 py-0 text-[11.5px] text-danger" disabled={restore.isPending} onClick={() => restore.mutate()}>Restore</button>
              <button type="button" className="btn-ghost px-1.5 py-0 text-[11.5px]" onClick={() => setConfirmRestore(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="btn-ghost gap-1 px-1.5 py-0 text-[11.5px]" title="Put this file back as the run left it" onClick={() => setConfirmRestore(true)}>
              <RotateCcw size={11} /> Restore the run&apos;s version
            </button>
          )
        ) : null}
      </div>

      {props.saveState === "conflict" || (changedOnDisk && dirty) ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1 text-[12px]" role="alert" data-testid="ide-conflict">
          <span className="text-warn">This file changed on disk while you were typing.</span>
          <button type="button" className="btn px-1.5 py-0 text-[11.5px]" onClick={props.onKeepMine}>Keep mine (overwrite)</button>
          <button type="button" className="btn-ghost px-1.5 py-0 text-[11.5px]" onClick={props.onUseDisk}>Use the version on disk</button>
        </div>
      ) : null}
      {readOnlyReason ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-raised px-3 py-1 text-[12px] text-muted"><Lock size={12} /> {readOnlyReason}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden" onContextMenu={(event) => { if ((event.target as HTMLElement).closest(".cm-editor")) props.onEditorMenu(event); }}>
        {previewKind === "image" ? (
          <FilePreview path={path} text="" code={code} source={source} />
        ) : props.preview && canPreview && opened.current && !opened.current.binary && !opened.current.tooLarge ? (
          <FilePreview path={path} text={buffers.current.get(path)?.text ?? opened.current.current ?? ""} code={code} source={source} />
        ) : versions.isLoading || !props.Editor ? (
          <div className="ide-progress" role="progressbar" aria-label="Opening the file" />
        ) : versions.error && !opened.current ? (
          // A later read that fails (offline, the computer asleep) keeps the editor; only a first read shows this.
          <IdeEmpty
            icon={<AlertTriangle size={36} strokeWidth={1.25} />}
            title={`${nameOf(path)} could not be opened`}
            message={(versions.error as Error).message}
            actions={
              <button type="button" className="btn" onClick={() => void versions.refetch()}>
                <RefreshCw size={13} /> Try again
              </button>
            }
          />
        ) : !opened.current ? null : opened.current.binary ? (
          <IdeEmpty icon={<FileText size={36} strokeWidth={1.25} />} title="A binary file" message="It is not shown here. Download it to open it." />
        ) : opened.current.tooLarge ? (
          <IdeEmpty icon={<FileText size={36} strokeWidth={1.25} />} title="Too large to open here" message="Files over 5 MB are not opened in the browser." />
        ) : !opened.current.exists.current && !opened.current.exists.start && !opened.current.exists.agent ? (
          <IdeEmpty icon={<FileText size={36} strokeWidth={1.25} />} title="This file is not there" message="It was moved or deleted on the computer." />
        ) : (
          <props.Editor
            ref={props.editorRef}
            path={path}
            original={opened.current.original ?? ""}
            value={buffers.current.get(path)?.text ?? opened.current.current ?? ""}
            start={props.review ? opened.current.start : null}
            agent={props.review ? opened.current.agent : null}
            kind={props.review ? "review" : "repo"}
            mode={props.mode}
            readOnly={Boolean(readOnlyReason)}
            fontSize={props.fontSize}
            reveal={props.reveal}
            onChange={props.onChange}
            onAccept={(original) => {
              void code
                .acceptContent(source, path, original)
                .then(() => {
                  client.setQueryData<CodeVersions>(["code-versions", key, source, path], (old) => (old ? { ...old, original } : old));
                  props.onAccepted();
                })
                .catch((error: Error) => toast(error.message, { tone: "error" }));
            }}
            onCursor={(lineNumber, column) => {
              setLine(lineNumber);
              props.onCursor(lineNumber, column);
            }}
            onSave={props.onSave}
            onEdge={props.onEdge}
            onCounts={props.onCounts}
          />
        )}
      </div>
    </div>
  );
}
