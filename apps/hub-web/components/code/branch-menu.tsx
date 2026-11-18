"use client";

/**
 * The branch of a repository Code or an agent works in (docs/16 §4), as a menu: the branch checked
 * out, the others to switch to (newest first, found by name), and a new branch made from where the
 * repository is now. Branches are the computer's own (`GET /api/code/branches`). Switching is git's
 * own `switch`, so changes it would overwrite stop it with git's words.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Plus, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Popover, Spinner, cx } from "@/components/ui";
import { codeApiFor, type CodeTarget } from "@/lib/code-target";
import { relative } from "@/lib/format";

export function BranchMenu({
  target,
  repo,
  branch,
  disabled = null,
  trigger,
  align = "left",
}: {
  target: CodeTarget;
  repo: string;
  /** The branch as last known, until the computer answers. */
  branch: string | null;
  /** Why switching is not offered now (an agent is working in the folder), or null. */
  disabled?: string | null;
  trigger: (open: boolean, toggle: () => void, current: string | null) => ReactNode;
  align?: "left" | "right";
}) {
  const client = useQueryClient();
  const code = useMemo(() => codeApiFor(target), [target]);
  const key = target.kind === "local" ? "local" : target.deviceId;
  const [opened, setOpened] = useState(false);
  const branches = useQuery({ queryKey: ["code-branches", key, repo], queryFn: () => code.branches(repo), enabled: opened, retry: false, staleTime: 5_000 });
  const current = branches.data?.current ?? branch;
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const done = () => {
    for (const query of [["code-branches", key, repo], ["scm"], ["code-repos"], ["code-source"], ["code-versions"], ["code-progress"]]) void client.invalidateQueries({ queryKey: query });
  };
  const switchTo = useMutation({ mutationFn: (to: string) => code.switchBranch(repo, to), onSuccess: done });
  const create = useMutation({
    mutationFn: (to: string) => code.createBranch(repo, to),
    onSuccess: () => {
      setNaming(false);
      setName("");
      done();
    },
  });
  const needle = query.trim().toLowerCase();
  const rows = (branches.data?.branches ?? []).filter((row) => !needle || row.name.toLowerCase().includes(needle)).slice(0, 80);
  const error = (switchTo.error ?? create.error ?? branches.error) as Error | null;
  return (
    <Popover
      width={300}
      maxHeight={420}
      align={align}
      trigger={(open, toggle) =>
        trigger(open, () => {
          if (!open) {
            setOpened(true);
            void branches.refetch();
          }
          toggle();
        }, current)
      }
    >
      {(close) => (
        <div className="flex flex-col py-1" data-testid="branch-menu">
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-0.5 text-[11.5px] text-faint">
            <GitBranch size={12} aria-hidden />
            <span className="min-w-0 flex-1 truncate">On {current ?? "a detached commit"}</span>
            {branches.isFetching || switchTo.isPending || create.isPending ? <Spinner size={11} /> : null}
          </div>
          {error ? <p className="px-3 pb-1.5 text-[12px] text-danger [overflow-wrap:anywhere]">{error.message}</p> : null}
          {disabled ? <p className="px-3 pb-1.5 text-[12px] text-muted">{disabled}</p> : null}
          {(branches.data?.branches.length ?? 0) > 8 ? (
            <label className="compound-field mx-1.5 mb-1 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
              <Search size={13} className="shrink-0 text-faint" aria-hidden />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a branch" aria-label="Find a branch" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
            </label>
          ) : null}
          <div className="max-h-[260px] overflow-y-auto" role="listbox" aria-label="Branches">
            {branches.isLoading ? <div className="flex justify-center py-3"><Spinner size={12} /></div> : null}
            {rows.map((row) => (
              <button
                key={row.name}
                type="button"
                role="option"
                aria-selected={row.current}
                disabled={Boolean(disabled) || row.current || switchTo.isPending}
                className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:cursor-default", row.current && "font-medium")}
                onClick={() => switchTo.mutate(row.name, { onSuccess: close })}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.name}</span>
                {row.at ? <span className="shrink-0 text-[11px] text-faint">{relative(row.at)}</span> : null}
                {row.current ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            ))}
            {branches.data && !rows.length ? <p className="px-3 py-1.5 text-[12px] text-muted">No branch matches.</p> : null}
          </div>
          {disabled ? null : (
            <div className="mt-1 border-t border-line pt-1">
              {naming ? (
                <div className="flex items-center gap-1.5 px-1.5 py-1">
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && name.trim()) create.mutate(name.trim(), { onSuccess: close });
                      else if (event.key === "Escape") setNaming(false);
                    }}
                    placeholder="New branch name"
                    aria-label="New branch name"
                    className="field h-8 min-w-0 flex-1 px-2 font-mono text-[12px]"
                  />
                  <button type="button" className="btn-primary h-8 px-2.5 text-[12px]" disabled={!name.trim() || create.isPending} onClick={() => create.mutate(name.trim(), { onSuccess: close })}>
                    Make
                  </button>
                </div>
              ) : (
                <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-ink" onClick={() => setNaming(true)}>
                  <Plus size={13} aria-hidden /> New branch from {current ?? "here"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}
