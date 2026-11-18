"use client";

/**
 * A folder picker drawn like a computer's own Open panel (docs/16 §1): places on the left (home,
 * Desktop, Documents, project folders, Ensemble's workspace, the folders Code can use), the folders of
 * the one open on the right, a path to step back along, a filter and New folder. It browses the
 * computer Code works on through its Code API (`GET /api/code/browse`), never this browser's own
 * disk: the two are often different machines. The computer shows only those places; system folders,
 * `/` and dot-folders in the home folder never appear.
 *
 * A folder outside the workspace and the folders Code can use is trusted once, here, before it is
 * used: it joins the folders Code can use on that computer. Code and agents work in git repositories,
 * so a folder that is not one can become one as it is picked.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Folder, FolderGit2, FolderPlus, Home, Laptop, Monitor, FileText, Search, ShieldCheck, Boxes } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Spinner, cx } from "@/components/ui";
import type { CodeBrowse, CodeBrowsePlace } from "@/lib/api";
import { codeApiFor, type CodeTarget } from "@/lib/code-target";

const PLACE_ICON: Record<CodeBrowsePlace["kind"], typeof Folder> = { home: Home, desktop: Monitor, documents: FileText, projects: Folder, workspace: Boxes, code: FolderGit2 };

/** A computer on an older Ensemble answers the picker's calls with "Update Ensemble on …". */
export const tooOldForPicker = (error: unknown) => error instanceof Error && /^Update Ensemble on /.test(error.message);

/** The path from the place that holds `path` down to it, as steps to click. */
export function crumbs(path: string, places: Pick<CodeBrowsePlace, "name" | "path">[]): Array<{ name: string; path: string }> {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const within = places.filter((place) => path === place.path || path.startsWith(place.path.endsWith(sep) ? place.path : `${place.path}${sep}`));
  const base = within.sort((a, b) => b.path.length - a.path.length)[0];
  if (!base) return [{ name: path, path }];
  const rest = path.slice(base.path.length).split(sep).filter(Boolean);
  const steps = [{ name: base.name, path: base.path }];
  let at = base.path;
  for (const part of rest) {
    at = `${at.endsWith(sep) ? at : `${at}${sep}`}${part}`;
    steps.push({ name: part, path: at });
  }
  return steps;
}

export type PickedFolder = { path: string; name: string };

export function FolderPicker({
  open,
  onClose,
  target,
  computerName,
  title = "Open a folder",
  action = "Open",
  onPick,
  fallback,
}: {
  open: boolean;
  onClose: () => void;
  /** The computer whose folders are browsed. */
  target: CodeTarget;
  computerName: string;
  title?: string;
  action?: string;
  onPick: (folder: PickedFolder) => void;
  /** What to offer when the computer is on an older Ensemble: its known repositories. */
  fallback?: Array<{ path: string; name: string }>;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={760} className="folder-picker-dialog" bodyClassName="p-0">
      {open ? <PickerBody target={target} computerName={computerName} action={action} onPick={onPick} onClose={onClose} fallback={fallback ?? []} /> : null}
    </Dialog>
  );
}

function PickerBody({ target, computerName, action, onPick, onClose, fallback }: { target: CodeTarget; computerName: string; action: string; onPick: (folder: PickedFolder) => void; onClose: () => void; fallback: Array<{ path: string; name: string }> }) {
  const client = useQueryClient();
  const code = useMemo(() => codeApiFor(target), [target]);
  const key = target.kind === "local" ? "local" : target.deviceId;
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [making, setMaking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [startRepo, setStartRepo] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const browse = useQuery({ queryKey: ["code-browse", key, path], queryFn: () => code.browse(path), retry: false, staleTime: 5_000, placeholderData: (previous) => previous });
  const data: CodeBrowse | undefined = browse.data;
  const folder = data?.folder ?? null;
  const entries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (folder?.entries ?? []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
  }, [folder, filter]);
  const chosen = selected ? folder?.entries.find((entry) => entry.path === selected) ?? null : null;
  const target_ = chosen ? { path: chosen.path, name: chosen.name, repo: chosen.repo } : folder ? { path: folder.path, name: folder.name, repo: folder.repo } : null;
  const trusted = chosen ? chosen.trusted : Boolean(folder?.trusted);
  const tooBroad = !chosen && folder?.why ? folder.why : null;
  useEffect(() => {
    setSelected(null);
    setFilter("");
    setConfirm(false);
    list.current?.scrollTo?.({ top: 0 });
  }, [path]);
  useEffect(() => setConfirm(false), [selected]);

  const use = useMutation({
    mutationFn: async () => {
      if (!target_) throw new Error("Pick a folder.");
      // Trusting adds it to the folders Code can use there; a folder that is not a repository becomes one.
      if (!trusted || (!target_.repo && startRepo)) return (await code.trustFolder(target_.path, !target_.repo && startRepo)).path;
      return target_.path;
    },
    onSuccess: (resolved) => {
      void client.invalidateQueries({ queryKey: ["code-repos"] });
      onPick({ path: resolved, name: target_?.name ?? resolved });
    },
  });
  const make = useMutation({
    mutationFn: (input: { name: string; repo: boolean }) => code.makeFolder(folder!.path, input.name, input.repo),
    onSuccess: async (made) => {
      setMaking(false);
      await client.invalidateQueries({ queryKey: ["code-browse", key, folder?.path ?? null] });
      await browse.refetch();
      setSelected(made.path);
    },
  });

  const go = (next: string) => setPath(next);
  const open = (entry: { path: string }) => go(entry.path);
  const proceed = () => {
    if (!target_ || tooBroad) return;
    if (!trusted && !confirm) return setConfirm(true);
    use.mutate();
  };

  if (browse.error && tooOldForPicker(browse.error)) {
    return (
      <div className="p-4 text-[13px]">
        <p className="text-muted">{(browse.error as Error).message}</p>
        {fallback.length ? (
          <div className="mt-3 max-h-[50dvh] overflow-y-auto rounded-lg border border-line">
            {fallback.map((row) => (
              <button key={row.path} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover" onClick={() => onPick({ path: row.path, name: row.name })}>
                <FolderGit2 size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <span className="max-w-[45%] truncate font-mono text-[11px] text-faint">{row.path}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const steps = folder && data ? crumbs(folder.path, data.places) : [];
  const placeOn = (place: CodeBrowsePlace) => folder && (folder.path === place.path || steps[0]?.path === place.path);
  const error = (use.error ?? make.error ?? (browse.error && !tooOldForPicker(browse.error) ? browse.error : null)) as Error | null;

  return (
    <div className="folder-picker" data-testid="folder-picker">
      <nav className="folder-picker-places" aria-label="Places">
        <div className="folder-picker-computer" title={`Folders on ${computerName}`}>
          <Laptop size={13} aria-hidden /> <span className="truncate">{computerName}</span>
        </div>
        {(data?.places ?? []).map((place) => {
          const Icon = PLACE_ICON[place.kind];
          return (
            <button key={place.path} type="button" className={cx("folder-picker-place", placeOn(place) && "is-on")} onClick={() => go(place.path)} title={place.path}>
              <Icon size={14} aria-hidden /> <span className="truncate">{place.name}</span>
            </button>
          );
        })}
        {!data && browse.isLoading ? <div className="px-3 py-2"><Spinner size={12} /></div> : null}
      </nav>
      <div className="folder-picker-main">
        <div className="folder-picker-bar">
          <button type="button" className="icon-btn h-7 w-7 shrink-0" disabled={!folder?.parent} onClick={() => folder?.parent && go(folder.parent)} aria-label="Up one folder" title="Up one folder">
            <ArrowLeft size={14} />
          </button>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[12.5px]" aria-label="Path">
            {steps.map((step, index) => (
              <span key={step.path} className="flex shrink-0 items-center gap-0.5">
                {index ? <ChevronRight size={11} className="text-faint" aria-hidden /> : null}
                <button type="button" className={cx("rounded px-1 py-0.5 hover:bg-hover", index === steps.length - 1 ? "font-medium text-ink" : "text-muted")} onClick={() => go(step.path)}>
                  {step.name}
                </button>
              </span>
            ))}
          </nav>
          <label className="compound-field flex h-7 w-36 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 max-sm:hidden">
            <Search size={12} className="shrink-0 text-faint" aria-hidden />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" aria-label="Filter folders" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
          </label>
        </div>
        <div ref={list} className="folder-picker-list" role="listbox" aria-label={folder ? `Folders in ${folder.name}` : "Folders"} data-testid="folder-picker-list">
          {making && folder ? <NewFolderRow pending={make.isPending} onCancel={() => setMaking(false)} onMake={(name, repo) => make.mutate({ name, repo })} /> : null}
          {browse.isLoading && !folder ? <div className="flex justify-center py-10"><Spinner size={14} /></div> : null}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={selected === entry.path}
              className={cx("folder-picker-row", selected === entry.path && "is-selected")}
              onClick={() => setSelected(entry.path)}
              onDoubleClick={() => open(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.metaKey || event.ctrlKey) proceed();
                  else open(entry);
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const at = entries.findIndex((row) => row.path === entry.path) + (event.key === "ArrowDown" ? 1 : -1);
                  const next = entries[Math.max(0, Math.min(entries.length - 1, at))];
                  if (next) {
                    setSelected(next.path);
                    (event.currentTarget.parentElement?.querySelector(`[data-path="${CSS.escape(next.path)}"]`) as HTMLElement | null)?.focus();
                  }
                } else if (event.key === "Backspace" && folder?.parent) {
                  event.preventDefault();
                  go(folder.parent);
                }
              }}
              data-path={entry.path}
            >
              {entry.repo ? <FolderGit2 size={15} className="shrink-0 text-accent" aria-hidden /> : <Folder size={15} className="shrink-0 text-muted" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.repo ? <span className="shrink-0 text-[11px] text-faint">repository</span> : null}
              <ChevronRight size={13} className="shrink-0 text-faint" aria-hidden />
            </button>
          ))}
          {folder && !entries.length && !making ? <p className="px-4 py-8 text-center text-[12.5px] text-muted">{filter ? "No folder matches." : "No folders here."}</p> : null}
          {folder?.more ? <p className="px-4 py-2 text-[11.5px] text-faint">{folder.more} more not listed. Filter to find one.</p> : null}
        </div>
        {confirm && target_ ? (
          <div className="folder-picker-trust" role="alertdialog" aria-label="Trust this folder" data-testid="folder-picker-trust">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink">Trust {target_.name}?</div>
              <div className="text-[12.5px] text-muted">It is outside the Ensemble workspace. Code and agents can then read and change files in it on {computerName}.</div>
            </div>
          </div>
        ) : null}
        <div className="folder-picker-foot">
          {folder && !making ? (
            <button type="button" className="btn h-8" onClick={() => setMaking(true)}>
              <FolderPlus size={13} aria-hidden /> <span className="max-sm:hidden">New folder</span>
            </button>
          ) : null}
          <div className="min-w-0 flex-1 truncate text-[12px] text-muted" title={target_?.path}>
            {error ? <span className="text-danger">{error.message}</span> : tooBroad ? tooBroad : target_ && !target_.repo ? (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={startRepo} onChange={(event) => setStartRepo(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
                Start a git repository in it
              </label>
            ) : target_ ? <span className="font-mono text-[11.5px]">{target_.path}</span> : null}
          </div>
          <button type="button" className="btn-ghost h-8" onClick={confirm ? () => setConfirm(false) : onClose}>
            {confirm ? "Back" : "Cancel"}
          </button>
          <button type="button" className="btn-primary h-8" disabled={!target_ || Boolean(tooBroad) || use.isPending} onClick={proceed} data-testid="folder-picker-use">
            {use.isPending ? <Spinner size={12} /> : null} {confirm ? `Trust and ${action.toLowerCase()}` : action}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewFolderRow({ pending, onMake, onCancel }: { pending: boolean; onMake: (name: string, repo: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState(true);
  return (
    <div className="folder-picker-row is-new" data-testid="folder-picker-new">
      <FolderPlus size={15} className="shrink-0 text-accent" aria-hidden />
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim()) onMake(name.trim(), repo);
          else if (event.key === "Escape") onCancel();
        }}
        placeholder="Folder name"
        aria-label="New folder name"
        maxLength={100}
        className="field h-7 min-w-0 flex-1 px-2 text-[12.5px]"
      />
      <label className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted" title="Code and agents work in git repositories">
        <input type="checkbox" checked={repo} onChange={(event) => setRepo(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" /> Git
      </label>
      <button type="button" className="btn-primary h-7 px-2 text-[12px]" disabled={!name.trim() || pending} onClick={() => onMake(name.trim(), repo)}>
        {pending ? <Spinner size={11} /> : "Make"}
      </button>
    </div>
  );
}
