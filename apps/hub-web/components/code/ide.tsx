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
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  Columns2,
  Files,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  HelpCircle,
  Keyboard,
  Laptop,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  TerminalSquare,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";

import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import type { ChunkCounts, ReviewEditorHandle, ReviewMode } from "@/components/code/review-editor";
import { CommitPanel } from "@/components/code/commit-panel";
import { SourceControl } from "@/components/code/source-control";
import { Terminal } from "@/components/code/terminal";
import { useToast } from "@/components/toast";
import { Spinner, cx } from "@/components/ui";
import { useSpaceAccess } from "@/lib/access";
import { api, ApiError, type ChangedFile, type CodeTreeEntry, type CodeVersions } from "@/lib/api";
import { useCodeApi, type Source } from "@/lib/code-target";
import { openTab } from "@/lib/code-tabs";
import { dateTime, languageFor } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";

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
const SIDEBAR_DEFAULT = 260;
const FONT_DEFAULT = 13;
const FONT_MIN = 10;
const FONT_MAX = 24;
const SAVE_MS = 700;

type Panel = "files" | "search" | "scm";
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

const SHORTCUTS: Array<[string, string]> = [
  ["Alt+Y", "Accept the agent's change at the cursor (in a checkout: stage it)"],
  ["Alt+N", "Reject the agent's change, or revert your edit"],
  ["Ctrl+Z", "Undo, including a reject"],
  ["F7 / Shift+F7", "Next / previous change (crosses files)"],
  ["Alt+→ / Alt+←", "Next / previous changed file"],
  ["F4", "Changes ↔ whole file"],
  ["Ctrl+S", "Save now (it also saves by itself)"],
  ["Ctrl+F", "Find and replace in the file"],
  ["Ctrl+B", "Show or hide the explorer"],
  ["Ctrl+`", "Terminal"],
  ["Ctrl+Shift+= / - / 0", "Code text bigger / smaller / reset"],
  ["Alt+Shift+T", "Next starred theme"],
  ["Esc", "Leave full screen"],
  ["?", "These shortcuts (outside the editor)"],
];

export function CodeIde({ source }: { source: Source }) {
  const access = useSpaceAccess();
  const client = useQueryClient();
  const toast = useToast();
  const { code, key, target } = useCodeApi();
  const ReviewEditor = useReviewEditor();
  const viewOnly = access.guest;

  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: target.kind === "device", staleTime: 60_000 });
  const computer = target.kind === "device" ? computers.data?.devices.find((row) => row.id === target.deviceId) ?? null : null;
  const info = useQuery({ queryKey: ["code-source", key, source], queryFn: () => code.codeSource(source), retry: false });
  const isReview = info.data?.kind === "review";
  const progress = useQuery({ queryKey: ["code-progress", key, source], queryFn: () => code.progress(source), enabled: Boolean(isReview), staleTime: 5_000 });
  const scm = useQuery({ queryKey: ["scm", key, info.data?.repo], queryFn: () => code.scm(info.data!.repo), enabled: Boolean(info.data?.repo) && !viewOnly, refetchInterval: 15_000, retry: false });

  const [panel, setPanel] = usePersistentState<Panel>("ensemble.code.sidebarPanel", "files");
  const [sidebar, setSidebar] = usePersistentState("ensemble.code.panel", true);
  const [width, setWidth] = usePersistentState("ensemble.code.sidebarWidth", SIDEBAR_DEFAULT);
  const [fontSize, setFontSize] = usePersistentState("ensemble.code.fontSize", FONT_DEFAULT);
  const [terminal, setTerminal] = usePersistentState("ensemble.code.terminal", false);
  const [full, setFull] = useState(false);
  const [help, setHelp] = useState(false);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, ReviewMode>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
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

  // The first changed file opens by itself.
  useEffect(() => {
    if (!info.data || active) return;
    const first = changed[0]?.path;
    if (first) {
      setTabs([first]);
      setActive(first);
    }
  }, [info.data, changed, active]);

  const setState = useCallback((path: string, state: SaveState) => setSaveState((current) => (current[path] === state ? current : { ...current, [path]: state })), []);

  /** Writes one file now, unless it is unchanged. `force`: overwrite whatever is on disk (Keep mine). */
  const save = useCallback(
    async (path: string, force = false) => {
      window.clearTimeout(timers.current.get(path));
      const buffer = buffers.current.get(path);
      if (!buffer?.dirty) return;
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
      if (line) setReveal({ path, line, nonce: Date.now() });
    },
    [active, release, save, saveState, tabs, toast],
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

  // Keys that work anywhere in the IDE. None is a bare letter: every letter types.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === "`") {
        event.preventDefault();
        setTerminal(!terminal);
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebar(!sidebar);
      } else if (mod && event.shiftKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setFontSize(Math.min(FONT_MAX, fontSize + 1));
      } else if (mod && event.shiftKey && (event.key === "_" || event.key === "-")) {
        event.preventDefault();
        setFontSize(Math.max(FONT_MIN, fontSize - 1));
      } else if (mod && event.shiftKey && (event.key === ")" || event.key === "0")) {
        event.preventDefault();
        setFontSize(FONT_DEFAULT);
      } else if (event.key === "F4") {
        event.preventDefault();
        setMode(mode === "changes" ? "file" : "changes");
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
      toast("Marked reviewed. Commit and push from Source control when you are ready.", { tone: "ok" });
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

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => setWidth(Math.round(Math.min(window.innerWidth / 2, Math.max(180, startWidth + moveEvent.clientX - startX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (info.isLoading) return <div className="p-10"><Spinner /></div>;
  if (info.error || !info.data) {
    return (
      <div className="p-10 text-[13px] text-muted">
        {(info.error as Error | null)?.message ?? "Could not open this checkout."}{" "}
        <Link href="/code" className="text-accent hover:underline">Back to Code</Link>
      </div>
    );
  }
  const data = info.data;
  const totals = progress.data;
  const activeState = active ? saveState[active] ?? "saved" : "saved";
  const where = target.kind === "device" ? computer?.name ?? "your computer" : null;

  return (
    <IdeSpace className={cx("flex min-h-0 flex-col bg-bg", full ? "fixed inset-0 z-[70]" : "relative h-full")}>
      {/* Title bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line px-2 text-[13px]" data-testid="ide-titlebar">
        <Link href="/code" className="icon-btn" title="Back to Code"><ArrowLeft size={15} /></Link>
        <span className="truncate font-semibold">{data.title}</span>
        <span className="truncate text-muted">
          {data.repo.split("/").slice(-2).join("/")} · {data.branch}
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

      <div className="flex min-h-0 flex-1">
        {/* Activity bar */}
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-sidebar py-2" aria-label="Code views">
          {(
            [
              ["files", Files, "Explorer (Ctrl+B)"],
              ["search", Search, "Find in files"],
              ...(viewOnly ? [] : [["scm", GitBranch, "Source control"]]),
            ] as Array<[Panel, ComponentType<{ size?: number }>, string]>
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={sidebar && panel === id}
              onClick={() => {
                if (sidebar && panel === id) setSidebar(false);
                else {
                  setPanel(id);
                  setSidebar(true);
                }
              }}
              className={cx("flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-ink", sidebar && panel === id && "bg-hover text-ink")}
            >
              <Icon size={17} />
            </button>
          ))}
          <div className="flex-1" />
          {!viewOnly ? (
            <button type="button" title="Terminal (Ctrl+`)" aria-label="Terminal" aria-pressed={terminal} onClick={() => setTerminal(!terminal)} className={cx("flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-ink", terminal && "bg-hover text-ink")}>
              <TerminalSquare size={17} />
            </button>
          ) : null}
        </nav>

        {/* Side panel */}
        {sidebar ? (
          <aside className="relative flex shrink-0 flex-col border-r border-line bg-sidebar max-md:absolute max-md:inset-y-0 max-md:left-11 max-md:z-20 max-md:shadow-xl" style={{ width }} aria-label="Side panel">
            {panel === "files" ? (
              <Explorer
                source={source}
                changed={changed}
                unreviewable={data.unreviewable}
                review={Boolean(isReview)}
                active={active}
                progressOf={progressOf}
                onOpen={open}
              />
            ) : panel === "search" ? (
              <SearchPanel source={source} onOpen={open} />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Source control</div>
                <CommitPanel source={source} draftKey={source.review ?? `${target.kind === "device" ? `${target.deviceId}:` : ""}${data.repo}`} beforeCommit={saveAll} pending={progress.data?.pending ?? 0} />
                <SourceControl repo={data.repo} onOpenFile={(path) => open(path)} beforeCommit={saveAll} commitForm={false} />
              </div>
            )}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the side panel"
              aria-valuenow={width}
              tabIndex={0}
              onPointerDown={startResize}
              onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") setWidth(Math.max(180, width - 16));
                else if (event.key === "ArrowRight") setWidth(Math.min(window.innerWidth / 2, width + 16));
                else return;
                event.preventDefault();
              }}
              className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-[var(--accent-soft)] focus:bg-[var(--accent-soft)] focus:outline-none"
            />
          </aside>
        ) : null}

        {/* Editor column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-sidebar text-[12.5px]" role="tablist" aria-label="Open files">
            <button type="button" className="icon-btn my-auto ml-1 h-7 w-7 shrink-0" title="Show or hide the explorer (Ctrl+B)" onClick={() => setSidebar(!sidebar)}>
              <PanelLeft size={14} />
            </button>
            {tabs.map((path) => {
              const state = saveState[path];
              const name = path.split("/").pop();
              return (
                <div
                  key={path}
                  role="tab"
                  aria-selected={path === active}
                  className={cx("group flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-line px-3", path === active ? "bg-bg text-ink" : "text-muted hover:text-ink")}
                  onMouseDown={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      close(path);
                    }
                  }}
                >
                  <button type="button" className="min-w-0 truncate" title={path} onClick={() => open(path)}>{name}</button>
                  <button type="button" className="icon-btn h-4 w-4 shrink-0" title={state === "dirty" || state === "saving" ? "Unsaved changes" : "Close"} onClick={() => close(path)}>
                    {state === "dirty" || state === "saving" ? <span className="block h-2 w-2 rounded-full bg-current" /> : <X size={11} className="opacity-60 group-hover:opacity-100" />}
                  </button>
                </div>
              );
            })}
          </div>

          {data.planted?.length ? (
            <div className="shrink-0 border-b border-line bg-raised px-3 py-2 text-[12.5px]">
              <div className="font-medium text-warn">These files can run later, outside the sandbox, when this folder is opened.</div>
              <ul className="mt-1 space-y-0.5 text-muted">
                {data.planted.map((hit) => (
                  <li key={`${hit.kind}:${hit.path}`}><span className="font-mono text-ink">{hit.path}</span> - {hit.reason}</li>
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
              onEdge={(direction) => goFile(direction)}
              onAccepted={() => void client.invalidateQueries({ queryKey: ["code-progress", key, source] })}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-10 text-center text-[13px] text-muted">
              {changed.length ? "Pick a file in the explorer." : `No changes to review. Everything on disk matches ${isReview ? "the tree this run started from" : "the index"}. Open any file from the explorer to edit it.`}
            </div>
          )}

          {terminal && !viewOnly ? <Terminal initialCwd={data.repo} target={target} fontSize={fontSize} onClose={() => setTerminal(false)} /> : null}

          {/* Status bar */}
          <div className="flex h-6 shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-t border-line bg-sidebar px-3 text-[11.5px] text-muted" data-testid="ide-statusbar">
            <span className="flex items-center gap-1"><GitBranch size={11} /> {scm.data?.branch ?? data.branch}</span>
            {scm.data?.ahead ? <span className="flex items-center"><ArrowUp size={10} />{scm.data.ahead}</span> : null}
            {scm.data?.behind ? <span className="flex items-center"><ArrowDown size={10} />{scm.data.behind}</span> : null}
            {isReview && totals ? (
              <span data-testid="ide-progress">
                {totals.total - totals.pending} / {totals.total} — {totals.filesLeft ? `${totals.filesLeft} file${totals.filesLeft === 1 ? "" : "s"} left` : "all decided"}
              </span>
            ) : null}
            {where ? <span className="flex items-center gap-1"><Laptop size={11} /> {where}</span> : null}
            <div className="flex-1" />
            {active ? <span>Ln {cursor.line}, Col {cursor.column}</span> : null}
            {active ? <span>{languageFor(active)}</span> : null}
            {active ? <EolLabel source={source} path={active} /> : null}
            <span>UTF-8</span>
            {active ? (
              <span className={activeState === "error" || activeState === "conflict" ? "text-danger" : undefined} data-testid="ide-save-state">
                {activeState === "dirty" ? "• Unsaved" : activeState === "saving" ? "Saving…" : activeState === "error" ? "Not saved" : activeState === "conflict" ? "Changed on disk" : "Saved"}
              </span>
            ) : null}
            <span className="flex items-center gap-0.5">
              <button type="button" className="icon-btn h-5 w-5" title="Smaller code (Ctrl+Shift+-)" onClick={() => setFontSize(Math.max(FONT_MIN, fontSize - 1))}><Minus size={10} /></button>
              <button type="button" className="tabular-nums" title="Reset code size (Ctrl+Shift+0)" onClick={() => setFontSize(FONT_DEFAULT)}>{fontSize}px</button>
              <button type="button" className="icon-btn h-5 w-5" title="Bigger code (Ctrl+Shift+=)" onClick={() => setFontSize(Math.min(FONT_MAX, fontSize + 1))}><Plus size={10} /></button>
            </span>
            {data.model ? <span className="hidden lg:inline">agent · {data.model} · {data.createdAt ? dateTime(data.createdAt) : ""}</span> : null}
          </div>
        </div>
      </div>

      {help ? <ShortcutSheet onClose={() => setHelp(false)} /> : null}
    </IdeSpace>
  );
}

function EolLabel({ source, path }: { source: Source; path: string }) {
  const { key } = useCodeApi();
  const client = useQueryClient();
  const versions = client.getQueryData<CodeVersions>(["code-versions", key, source, path]);
  return <span>{versions?.eol === "crlf" ? "CRLF" : "LF"}</span>;
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 font-semibold">
          <HelpCircle size={15} /> Code shortcuts
          <div className="flex-1" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <table className="w-full text-[12.5px]">
          <tbody>
            {SHORTCUTS.map(([keys, what]) => (
              <tr key={keys} className="border-t border-line">
                <td className="py-1 pr-3 font-mono text-[12px]">{keys}</td>
                <td className="py-1 text-muted">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] text-faint">No shortcut is a bare letter: every letter types.</p>
      </div>
    </div>
  );
}

function Explorer({
  source,
  changed,
  unreviewable,
  review,
  active,
  progressOf,
  onOpen,
}: {
  source: Source;
  changed: ChangedFile[];
  unreviewable: ChangedFile[];
  review: boolean;
  active: string | null;
  progressOf: (path: string) => { total: number; pending: number; yours: number } | null;
  onOpen: (path: string, line?: number) => void;
}) {
  const { code, key } = useCodeApi();
  const [filter, setFilter] = useState("");
  const [wantFiles, setWantFiles] = useState(false);
  const all = useQuery({ queryKey: ["code-files", key, source], queryFn: () => code.files(source), enabled: wantFiles, staleTime: 30_000 });
  const matches = filter.trim() ? (all.data?.files ?? []).filter((path) => path.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 50) : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <div className="p-2">
        <div className="tile flex items-center gap-1.5 rounded-md bg-panel px-2 py-1">
          <Search size={12} className="text-faint" />
          <input
            value={filter}
            onFocus={() => setWantFiles(true)}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) {
                onOpen(matches[0]);
                setFilter("");
              }
            }}
            placeholder="Go to file"
            aria-label="Go to file"
            className="flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {filter.trim() ? (
          <ul className="px-1">
            {all.isLoading ? <li className="px-2 py-1"><Spinner size={11} /></li> : null}
            {matches.map((path) => (
              <li key={path}>
                <button type="button" className="row-tile flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-[3px] text-left" onClick={() => { onOpen(path); setFilter(""); }}>
                  <FileText size={12} className="shrink-0 text-faint" />
                  <span className="truncate">{path.split("/").pop()}</span>
                  <span className="truncate text-[11px] text-faint">{path.split("/").slice(0, -1).join("/")}</span>
                </button>
              </li>
            ))}
            {all.data && !matches.length ? <li className="px-2 py-1 text-muted">No file matches.</li> : null}
          </ul>
        ) : (
          <>
            <div className="flex items-center justify-between px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {review ? "Changes from this run" : "Changes"}
              <span className="rounded bg-raised px-1.5 font-normal">{changed.length}</span>
            </div>
            <ul className="px-1">
              {changed.map((row) => {
                const counts = progressOf(row.path);
                return (
                  <li key={row.path}>
                    <button
                      type="button"
                      onClick={() => onOpen(row.path)}
                      data-active={row.path === active || undefined}
                      className="row-tile flex min-h-6 w-full items-center gap-1.5 rounded px-2 py-1 text-left"
                      title={row.path}
                    >
                      <span className={cx("w-3 shrink-0 text-center font-mono text-[11px]", STATUS_COLOR[row.status])}>{row.status === "U" ? "A" : row.status}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {row.path.split("/").pop()}
                        <span className="ml-1.5 text-[11px] text-faint">{row.path.split("/").slice(0, -1).join("/")}</span>
                      </span>
                      {counts?.pending ? <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 text-[10.5px] font-medium">{counts.pending}</span> : null}
                      {counts ? <Ring done={counts.total - counts.pending} total={counts.total} /> : <span className="shrink-0 text-2xs"><span className="text-ok">+{row.added}</span> <span className="text-danger">−{row.removed}</span></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {unreviewable.length ? (
              <>
                <div className="mt-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Changed, can&apos;t be reviewed</div>
                {unreviewable.map((row) => (
                  <div key={row.path} className="truncate px-3 py-0.5 text-[12px] text-faint" title={row.path}>{row.path}</div>
                ))}
              </>
            ) : null}
            <div className="mt-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Folder</div>
            <TreeNode source={source} path="" depth={0} active={active} onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  );
}

function TreeNode({ source, path, depth, active, onOpen }: { source: Source; path: string; depth: number; active: string | null; onOpen: (path: string) => void }) {
  const { code, key } = useCodeApi();
  const listing = useQuery({ queryKey: ["code-tree", key, source, path], queryFn: () => code.tree(source, path), staleTime: 15_000, retry: false });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const pad = { paddingLeft: 12 + depth * 12 };
  if (listing.isLoading) return <div className="py-1" style={pad}><Spinner size={11} /></div>;
  if (listing.error) return <div className="py-1 pr-3 text-[12px] text-danger" style={pad}>{(listing.error as Error).message}</div>;
  const data = listing.data;
  if (!data) return null;
  return (
    <ul>
      {data.entries.map((entry: CodeTreeEntry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const dir = entry.kind === "dir";
        const expanded = Boolean(open[entry.name]);
        return (
          <li key={entry.name}>
            <button
              type="button"
              disabled={entry.kind === "link"}
              title={entry.kind === "link" ? "A link that leads outside the repository" : child}
              onClick={() => (dir ? setOpen({ ...open, [entry.name]: !expanded }) : onOpen(child))}
              className={cx("flex w-full min-w-0 items-center gap-1 py-[3px] pr-3 text-left hover:bg-hover disabled:cursor-default disabled:opacity-50", active === child && "bg-[var(--accent-soft)]")}
              style={pad}
              aria-expanded={dir ? expanded : undefined}
            >
              {dir ? <ChevronRight size={11} className={cx("shrink-0 text-faint transition-transform", expanded && "rotate-90")} /> : <span className="w-[11px] shrink-0" />}
              {dir ? expanded ? <FolderOpen size={12} className="shrink-0 text-muted" /> : <Folder size={12} className="shrink-0 text-muted" /> : <FileText size={12} className="shrink-0 text-faint" />}
              <span className={cx("min-w-0 flex-1 truncate", entry.secret && "text-faint")}>{entry.name}</span>
            </button>
            {dir && expanded ? <TreeNode source={source} path={child} depth={depth + 1} active={active} onOpen={onOpen} /> : null}
          </li>
        );
      })}
      {data.truncated ? <li className="py-1 text-[11px] text-faint" style={pad}>Only the first 2,000 entries.</li> : null}
      {data.hidden ? <li className="py-0.5 text-[11px] text-faint" style={pad}>{data.hidden} files of keys or secrets are not shown here</li> : null}
    </ul>
  );
}

function SearchPanel({ source, onOpen }: { source: Source; onOpen: (path: string, line?: number) => void }) {
  const { code, key } = useCodeApi();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<{ q: string; matchCase: boolean } | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const found = useQuery({ queryKey: ["code-search", key, source, asked], queryFn: () => code.search(source, asked!.q, asked!.matchCase), enabled: Boolean(asked?.q), retry: false });
  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ line: number; text: string }>>();
    for (const row of found.data?.results ?? []) map.set(row.path, [...(map.get(row.path) ?? []), { line: row.line, text: row.text }]);
    return [...map.entries()];
  }, [found.data]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Find in files</div>
      <form
        className="flex items-center gap-1 px-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) setAsked({ q: text.trim(), matchCase });
        }}
      >
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Search" aria-label="Find in files" className="field min-w-0 flex-1 py-1 text-[12.5px]" />
        <button type="button" className={cx("icon-btn h-7 w-7 font-mono text-[11px]", matchCase && "bg-hover text-ink")} title="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(!matchCase)}>Aa</button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {found.isLoading && asked ? <div className="px-3"><Spinner size={12} /></div> : null}
        {found.error ? <div className="px-3 text-danger">{(found.error as Error).message}</div> : null}
        {found.data && !grouped.length ? <div className="px-3 text-muted">Nothing found.</div> : null}
        {grouped.map(([path, rows]) => (
          <div key={path} className="mb-1">
            <div className="truncate px-3 py-0.5 font-medium" title={path}>{path}</div>
            {rows.map((row) => (
              <button key={row.line} type="button" className="row-tile flex w-full min-w-0 gap-2 px-3 py-[2px] text-left font-mono text-[11.5px]" onClick={() => onOpen(path, row.line)}>
                <span className="w-8 shrink-0 text-right text-faint">{row.line}</span>
                <span className="truncate">{row.text}</span>
              </button>
            ))}
          </div>
        ))}
        {found.data?.truncated ? <div className="px-3 text-[11px] text-faint">The first 500 results.</div> : null}
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
  onEdge: (direction: 1 | -1) => void;
  onAccepted: () => void;
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
      toast("Back as the run left it.", { tone: "ok" });
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
    if (changedOnDisk && !dirty) props.onUseDisk();
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line px-3 text-[12px]" data-testid="ide-filebar">
        <span className="flex min-w-0 items-center gap-1 truncate text-muted">
          {parts.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              {index ? <ChevronRight size={10} className="text-faint" /> : null}
              <span className={index === parts.length - 1 ? "font-medium text-ink" : undefined}>{part}</span>
            </span>
          ))}
        </span>
        {props.changed ? <span><span className="text-ok">+{props.changed.added}</span> <span className="text-danger">−{props.changed.removed}</span></span> : null}
        <div className="flex-1" />
        {props.review && counts ? (
          counts.agent === 0 ? (
            <span className="text-ok" data-testid="ide-file-reviewed">Reviewed — edit freely</span>
          ) : (
            <span className="text-muted">{counts.agent} agent change{counts.agent === 1 ? "" : "s"} to decide{counts.yours ? ` · ${counts.yours} yours` : ""}</span>
          )
        ) : null}
        <button type="button" className="icon-btn h-6 w-6" title="Previous change (Shift+F7)" onClick={() => props.editorRef.current?.previous()}><ArrowUp size={13} /></button>
        <button type="button" className="icon-btn h-6 w-6" title="Next change (F7)" onClick={() => props.editorRef.current?.next()}><ArrowDown size={13} /></button>
        <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="View">
          {(["changes", "file"] as const).map((value) => (
            <button key={value} type="button" title={value === "changes" ? "Only the changes (F4)" : "The whole file (F4)"} onClick={() => props.setMode(value)} className={cx("flex items-center gap-1 px-2 py-0.5", props.mode === value ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink")}>
              {value === "changes" ? <Columns2 size={11} /> : <FileText size={11} />} {value === "changes" ? "Changes" : "File"}
            </button>
          ))}
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {versions.isLoading || !props.Editor ? (
          <div className="p-6"><Spinner /></div>
        ) : versions.error ? (
          <div className="p-6 text-[13px] text-danger">{(versions.error as Error).message}</div>
        ) : !opened.current ? null : opened.current.binary ? (
          <div className="p-6 text-[13px] text-muted">A binary file. It is not shown.</div>
        ) : opened.current.tooLarge ? (
          <div className="p-6 text-[13px] text-muted">Files over 5 MB are not opened here.</div>
        ) : !opened.current.exists.current && !opened.current.exists.start && !opened.current.exists.agent ? (
          <div className="p-6 text-[13px] text-muted">This file is not there.</div>
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
