"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  PanelLeft,
  Search,
  TerminalSquare,
  Undo2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffView } from "@/components/code/diff-view";
import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import { AskEnsemble } from "@/components/ensemble/ask-button";
import { SourceControl } from "@/components/code/source-control";
import { Terminal } from "@/components/code/terminal";
import { useToast } from "@/components/toast";
import { Spinner, cx } from "@/components/ui";
import { api, type ChangedFile } from "@/lib/api";
import { dateTime, languageFor } from "@/lib/format";
import { fileEditor, useWarmEditors, warmFileEditor } from "@/lib/warm";
import { usePersistentState } from "@/lib/prefs";

const STATUS_COLOR: Record<string, string> = { A: "text-ok", U: "text-ok", M: "text-warn", D: "text-danger", R: "text-accent" };

function useFileEditor() {
  const [Editor, setEditor] = useState(() => fileEditor);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void warmFileEditor().then(() => {
      if (live && fileEditor) setEditor(() => fileEditor);
    });
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor;
}

export default function ReviewPage() {
  const params = useSearchParams();
  const client = useQueryClient();
  useWarmEditors("file");
  const toast = useToast();
  const FileEditor = useFileEditor();
  const source = useMemo(
    () => ({ review: params.get("review") ?? undefined, repo: params.get("repo") ?? undefined }),
    [params],
  );
  const [panel, setPanel] = usePersistentState("ensemble.code.panel", true);
  const [narrow, setNarrow] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  const showFiles = narrow ? sheet : panel;
  const [scmOpen, setScmOpen] = usePersistentState("ensemble.code.scm", true);
  const [mode, setMode] = useState<"changes" | "file">("changes");
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [hunk, setHunk] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const diffRef = useRef<HTMLDivElement>(null);

  const info = useQuery({ queryKey: ["code-source", source], queryFn: () => api.codeSource(source), retry: false });
  const files = info.data?.files ?? [];
  const visibleFiles = files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()));
  const file: ChangedFile | undefined = files.find((row) => row.path === path) ?? files[0];
  const filePath = path ?? file?.path ?? null;

  useEffect(() => {
    if (!info.data) return;
    if (!path || !files.some((row) => row.path === path)) setPath(files[0]?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.data]);

  const diff = useQuery({
    queryKey: ["code-diff", source, filePath],
    queryFn: () => api.codeDiff(source, filePath!, file?.status === "U"),
    enabled: Boolean(filePath) && mode === "changes",
  });
  const fileContent = useQuery({
    queryKey: ["code-file", source, filePath],
    queryFn: () => api.codeFile(source, filePath!),
    enabled: Boolean(filePath) && mode === "file",
  });

  useEffect(() => {
    if (fileContent.data && !dirty) setContent(fileContent.data.content);
  }, [fileContent.data, dirty]);

  useEffect(() => {
    setHunk(0);
    setDirty(false);
    setContent(null);
  }, [filePath]);

  const decisions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of diff.data?.decisions ?? []) map.set(row.chunkKey, row.decision);
    return map;
  }, [diff.data]);
  const hunks = diff.data?.diff.hunks ?? [];
  const decidedHere = hunks.filter((row) => decisions.has(row.key)).length + (diff.data?.decisions ?? []).filter((row) => row.decision === "rejected").length;
  const totalHere = hunks.length + (diff.data?.decisions ?? []).filter((row) => row.decision === "rejected").length;

  const decide = useMutation({
    mutationFn: (input: { key: string; decision: "accepted" | "rejected" }) =>
      api.decideHunk({ ...source, path: filePath!, key: input.key, untracked: file?.status === "U", decision: input.decision }),
    onSuccess: async (_result, input) => {
      await client.invalidateQueries({ queryKey: ["code-diff", source, filePath] });
      void client.invalidateQueries({ queryKey: ["code-source", source] });
      void client.invalidateQueries({ queryKey: ["scm"] });
      if (input.decision === "accepted") setHunk((value) => Math.min(value + 1, Math.max(hunks.length - 1, 0)));
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const [terminal, setTerminal] = usePersistentState("ensemble.code.terminal", false);
  /** The pending edit, tagged with the file it belongs to, so a switch never saves text under the wrong path. */
  const latest = useRef<{ path: string | null; content: string | null; dirty: boolean }>({ path: null, content: null, dirty: false });
  const saveTimer = useRef<number | undefined>(undefined);

  /** Writes the file now. Called 0.7 s after typing stops, on Cmd+S, and before switching file or view. */
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const { path: target, content: text, dirty: pending } = latest.current;
    if (!pending || !target || text === null) return;
    setSaving("saving");
    try {
      await api.saveCodeFile(source, target, text);
      if (latest.current.path === target && latest.current.content === text) {
        latest.current = { ...latest.current, dirty: false };
        setDirty(false);
      }
      setSaving("saved");
      void client.invalidateQueries({ queryKey: ["code-source", source] });
      void client.invalidateQueries({ queryKey: ["code-diff"] });
      void client.invalidateQueries({ queryKey: ["scm"] });
    } catch (error) {
      setSaving("error");
      toast((error as Error).message, { tone: "error" });
    }
  }, [client, source, toast]);
  const onSave = useCallback(() => void flush(), [flush]);

  useEffect(() => () => void flush(), [filePath, mode, flush]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setTerminal(!terminal);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminal, setTerminal]);

  const complete = useMutation({
    mutationFn: () => api.completeReview(source.review!),
    onSuccess: () => {
      toast("Marked reviewed. Commit and push from Source control when you are ready.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["reviews"] });
    },
  });

  const afterReview = () => {
    void client.invalidateQueries({ queryKey: ["reviews"] });
    void client.invalidateQueries({ queryKey: ["code-source", source] });
    void client.invalidateQueries({ queryKey: ["code-diff"] });
    void client.invalidateQueries({ queryKey: ["scm"] });
    void client.invalidateQueries({ queryKey: ["task-jobs"] });
  };
  const accept = useMutation({
    mutationFn: () => api.acceptReview(source.review!),
    onSuccess: (result) => {
      toast(
        result.commit
          ? `Accepted and committed on ${result.branch}.${result.pushable ? " Push when you are ready." : ""}`
          : "Accepted. The changes stay in the folder, uncommitted.",
        { tone: "ok" },
      );
      afterReview();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const discard = useMutation({
    mutationFn: () => api.discardReview(source.review!),
    onSuccess: (result) => {
      toast(
        `Discarded. ${result.restored} ${result.restored === 1 ? "file is" : "files are"} back as the run found them.${result.keptCommits ? " Commits on this branch were kept; undo them in Source control." : ""}`,
        { tone: "ok" },
      );
      afterReview();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const push = useMutation({
    mutationFn: () => api.pushReview(source.review!),
    onSuccess: (result) => toast(`Pushed ${result.branch} (fast-forward).`, { tone: "ok" }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const fileIndex = files.findIndex((row) => row.path === filePath);
  const goFile = (delta: number) => {
    const next = files[fileIndex + delta];
    if (next) setPath(next.path);
  };
  const goHunk = (delta: number) => {
    const next = Math.min(Math.max(hunk + delta, 0), Math.max(hunks.length - 1, 0));
    setHunk(next);
    diffRef.current?.querySelector(`[data-hunk="${next}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, .cm-editor, [contenteditable=true], [data-ide-theme-picker]") || mode !== "changes") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const current = hunks[hunk];
      if (event.key === "j") goHunk(1);
      else if (event.key === "k") goHunk(-1);
      else if (event.key === "]") goFile(1);
      else if (event.key === "[") goFile(-1);
      else if (event.key === "y" && current) decide.mutate({ key: current.key, decision: "accepted" });
      else if (event.key === "n" && current) decide.mutate({ key: current.key, decision: "rejected" });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
  const filesLeft = files.length - (fileIndex + 1);

  return (
    <IdeSpace className="relative flex h-full min-h-0 max-md:flex-col">
      {showFiles ? (
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-sidebar max-md:max-h-[38vh] max-md:w-full max-md:border-b max-md:border-r-0">
          <div className="p-2">
            <div className="tile flex items-center gap-1.5 rounded-md bg-panel px-2 py-1">
              <Search size={12} className="text-faint" />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" className="flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            <div className="flex items-center justify-between px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {data.kind === "review" ? "Changes from this run" : "Changes"}
              <span className="rounded bg-raised px-1.5 font-normal">{files.length}</span>
            </div>
            {visibleFiles.map((row) => (
              <button
                key={row.path}
                type="button"
                onClick={() => setPath(row.path)}
                data-active={row.path === filePath || undefined}
                className="row-tile flex min-h-6 w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px]"
              >
                <span className={cx("w-3 shrink-0 text-center font-mono text-[11px]", STATUS_COLOR[row.status])}>{row.status === "U" ? "A" : row.status}</span>
                <span className="min-w-0 flex-1 truncate" title={row.path}>{row.path.split("/").pop()}</span>
                <span className="shrink-0 text-2xs"><span className="text-ok">+{row.added}</span> <span className="text-danger">−{row.removed}</span></span>
              </button>
            ))}
            {data.unreviewable.length ? (
              <>
                <div className="mt-3 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Changed, can&apos;t be reviewed</div>
                {data.unreviewable.map((row) => (
                  <div key={row.path} className="truncate px-1.5 py-0.5 text-[12px] text-faint" title={row.path}>{row.path}</div>
                ))}
              </>
            ) : null}
          </div>
          <div className="border-t border-line">
            <button type="button" onClick={() => setScmOpen(!scmOpen)} className="flex w-full items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-ink">
              <ChevronUp size={12} className={cx("transition-transform", !scmOpen && "rotate-180")} />
              Source control
            </button>
            {scmOpen ? (
              <div className="max-h-[48vh] overflow-y-auto">
                <SourceControl repo={data.repo} onOpenFile={(value) => { setPath(value); setMode("changes"); }} />
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line px-2 text-[13px]">
          <Link href="/code" className="icon-btn" title="Back to Code"><ArrowLeft size={15} /></Link>
          <button type="button" className="icon-btn" title="Toggle file panel" onClick={() => (narrow ? setSheet((open) => !open) : setPanel(!panel))}><PanelLeft size={15} /></button>
          <span className="truncate font-semibold">{data.title}</span>
          <span className="truncate text-muted">{data.repo.split("/").slice(-2).join("/")} · {data.branch}</span>
          <div className="flex-1" />
          <ThemeControl />
          <button type="button" className={cx("btn", terminal && "bg-hover")} onClick={() => setTerminal(!terminal)} title="Terminal (Ctrl+`)">
            <TerminalSquare size={13} /> Terminal
          </button>
          {data.kind === "review" && data.review && !data.review.completedAt ? (
            <>
              {confirmDiscard ? (
                <>
                  <span className="text-[12px] text-muted">Put the agent&apos;s files back as the run found them?</span>
                  <button type="button" className="btn text-danger" disabled={discard.isPending} onClick={() => discard.mutate()}>
                    {discard.isPending ? <Spinner size={12} /> : <Undo2 size={13} />} Yes, discard
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setConfirmDiscard(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirmDiscard(true)}>
                  <Undo2 size={13} /> Discard all
                </button>
              )}
              <button type="button" className="btn-primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
                {accept.isPending ? <Spinner size={12} /> : <Check size={13} />} Accept all
              </button>
            </>
          ) : null}
          {data.kind === "review" && data.review?.completedAt ? <span className="text-[12px] text-muted">Reviewed</span> : null}
          {data.kind === "review" && data.review?.completedAt && data.review.canPush ? (
            <button type="button" className="btn" disabled={push.isPending} onClick={() => push.mutate()} title="Fast-forward only, to this run's own branch, at the repository it was cloned from">
              {push.isPending ? <Spinner size={12} /> : <Upload size={13} />} Push {data.branch}
            </button>
          ) : null}
          {data.kind === "review" && !data.review ? (
            <button type="button" className="btn" onClick={() => complete.mutate()}>
              <CheckCheck size={13} /> Mark reviewed
            </button>
          ) : null}
        </div>
        {data.planted?.length ? (
          <div className="border-b border-line bg-raised px-3 py-2 text-[12.5px]">
            <div className="font-medium text-warn">These files can run later, outside the sandbox, when this folder is opened.</div>
            <ul className="mt-1 space-y-0.5 text-muted">
              {data.planted.map((hit) => (
                <li key={`${hit.kind}:${hit.path}`}>
                  <span className="font-mono text-ink">{hit.path}</span> - {hit.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-line bg-sidebar px-3 text-[12.5px]">
          <span className="min-w-0 truncate font-medium">{filePath ?? "No changes"}</span>
          <AskEnsemble
            surface="code"
            anchorKey={`code:${filePath ?? "none"}:${cursor.line}`}
            label="Ask Ensemble about this line"
            contextLabel={filePath ? `${filePath}:${cursor.line}` : "No file open"}
            path={filePath ?? undefined}
            line={cursor.line}
            entityIds={data.taskId ? [data.taskId] : undefined}
            codeText={
              mode === "file" && content
                ? content.split("\n").slice(Math.max(0, cursor.line - 12), cursor.line + 12).join("\n")
                : (diff.data?.diff.hunks ?? [])
                    .map((hunk) => hunk.lines.map((row) => `${row.type === "add" ? "+" : row.type === "del" ? "-" : " "}${row.text}`).join("\n"))
                    .join("\n")
                    .slice(0, 6000)
            }
          />
          {file ? <span><span className="text-ok">+{file.added}</span> <span className="text-danger">−{file.removed}</span></span> : null}
          <div className="flex-1" />
          <span className="text-muted">{fileIndex + 1}/{files.length} · {filesLeft} file{filesLeft === 1 ? "" : "s"} left</span>
          <button type="button" className="icon-btn h-6 w-6" title="Next change (J)" onClick={() => goHunk(1)}><ArrowDown size={13} /></button>
          <button type="button" className="icon-btn h-6 w-6" title="Previous change (K)" onClick={() => goHunk(-1)}><ArrowUp size={13} /></button>
          <button type="button" className="icon-btn h-6 w-6" title="Previous file ([)" onClick={() => goFile(-1)}><ChevronLeft size={14} /></button>
          <button type="button" className="icon-btn h-6 w-6" title="Next file (])" onClick={() => goFile(1)}><ChevronRight size={14} /></button>
          <div className="ml-1 flex overflow-hidden rounded-md border border-line">
            {(["changes", "file"] as const).map((value) => (
              <button key={value} type="button" onMouseEnter={() => void warmFileEditor()} onFocus={() => void warmFileEditor()} onClick={() => setMode(value)} className={cx("px-2.5 py-0.5 capitalize", mode === value ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink")}>
                {value}
              </button>
            ))}
          </div>
          {mode === "file" ? (
            <span className="w-16 text-right text-[12px] text-muted">{dirty ? "Editing…" : saving === "saving" ? "Saving…" : saving === "error" ? "Not saved" : "Saved"}</span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!filePath ? (
            <div className="p-10 text-[13px] text-muted">No changes to review. Everything on disk matches {data.kind === "review" ? "the tree this run started from" : "HEAD"}.</div>
          ) : mode === "changes" ? (
            diff.isLoading || !diff.data ? (
              <div className="p-6"><Spinner /></div>
            ) : (
              <DiffView
                ref={diffRef}
                diff={diff.data.diff}
                decisions={decisions}
                current={hunk}
                kind={data.kind}
                busy={decide.isPending}
                onDecide={(key, decision) => decide.mutate({ key, decision })}
                onFocusHunk={setHunk}
              />
            )
          ) : content === null || !FileEditor ? (
            <div className="p-6"><Spinner /></div>
          ) : (
            <FileEditor
              path={filePath}
              value={content}
              onChange={(value) => {
                setContent(value);
                setDirty(true);
                latest.current = { path: filePath, content: value, dirty: true };
                window.clearTimeout(saveTimer.current);
                saveTimer.current = window.setTimeout(() => void flush(), 700);
              }}
              onCursor={(line, column) => setCursor({ line, column })}
              onSave={onSave}
            />
          )}
        </div>

        {terminal ? <Terminal initialCwd={data.repo} onClose={() => setTerminal(false)} /> : null}

        <div className="flex h-6 shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-t border-line bg-sidebar px-3 text-[11.5px] text-muted">
          <span>{filePath ? languageFor(filePath) : "-"}</span>
          {mode === "file" ? <span>Ln {cursor.line}, Col {cursor.column}</span> : null}
          <span>LF</span>
          <span>UTF-8</span>
          {mode === "changes" ? (
            <span>
              {decidedHere}/{totalHere} {data.kind === "review" ? "agent changes decided" : "hunks handled"} in this file
            </span>
          ) : (
            <span className={saving === "error" ? "text-danger" : undefined}>{dirty || saving === "saving" ? "Saving…" : saving === "error" ? "Could not save" : "Saved automatically"}</span>
          )}
          <div className="flex-1" />
          {data.model ? <span>agent · {data.model} · {dateTime(data.createdAt)}</span> : null}
          <span className="hidden lg:inline">Y accept · N reject · J/K move · [ ] files · Alt+Shift+T themes</span>
        </div>
      </div>
    </IdeSpace>
  );
}
