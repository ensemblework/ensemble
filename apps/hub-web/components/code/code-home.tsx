"use client";

/**
 * Code's home (`/code`, docs/16): the same window as the editor (`ide.tsx`) opened on a Welcome tab
 * about agent work: what to start with, changes to review, recent repositories and recent code runs.
 * On this computer it reads this Ensemble; on Ensemble on the web, each paired computer
 * (`lib/code-home.ts`). `/code?job=<id>&file=<path>` opens a run's files read-only in a second tab.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Code2,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitPullRequestArrow,
  House,
  Laptop,
  ListTree,
  Lock,
  Maximize2,
  Minimize2,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { jobTone } from "@/components/agent/job-card";
import { Fold, InlineError, Lines, RepoList, ReviewItem } from "@/components/code/code-lists";
import { ComputersCode, matchRepos } from "@/components/code/computers-code";
import { ActivityBar, BottomPanel, FontSizeControl, OnlineDot, PanelHeader, SidePanel, StatusBar, StatusItem, useIdeKeys, useIdeLayout } from "@/components/code/ide-chrome";
import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import { RunCode } from "@/components/code/run-code";
import { Terminal } from "@/components/code/terminal";
import { ShareButton } from "@/components/sharing/share-dialog";
import { InfoTip, MenuItem, Popover, Segmented, SkeletonRows, Spinner, cx } from "@/components/ui";
import { useSpaceAccess } from "@/lib/access";
import { api, type AgentJob } from "@/lib/api";
import { repoHref, useCodeHome, type CodeHome as Home, type CodePlace, type HomeRepo, type HomeReview } from "@/lib/code-home";
import { remoteLabel, repoName, repoSecond, repoView, usedWithin, viewFor } from "@/lib/code-repos";
import { relative } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";

type HomePanel = "repos" | "search" | "scm";
type Filter = "needs" | "reviewed" | "all";

const REVIEWS_SHOWN = 6;
const REPOS_SHOWN = 8;
const RUNS_SHOWN = 5;

const TONE_DOT: Record<string, string> = { green: "bg-ok", red: "bg-danger", yellow: "bg-warn", orange: "bg-warn", blue: "bg-accent", gray: "bg-faint" };

export function CodeHome({ jobId, file, onCloseRun }: { jobId: string | null; file: string | null; onCloseRun: () => void }) {
  const access = useSpaceAccess();
  const viewOnly = access.guest;
  const home = useCodeHome();
  const layout = useIdeLayout();
  useIdeKeys(layout);
  const { sideOpen, setSideOpen, showSide, terminal, setTerminal, fontSize, setFontSize } = layout;
  const [panel, setPanel] = usePersistentState<HomePanel>("ensemble.code.homePanel", "repos");
  const [computerId, setComputerId] = usePersistentState<string | null>("ensemble.code.computer", null);
  const [tab, setTab] = useState<"welcome" | "run">(jobId ? "run" : "welcome");
  const [full, setFull] = useState(false);
  const [filter, setFilter] = useState("");
  const filterField = useRef<HTMLInputElement>(null);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });

  useEffect(() => setTab(jobId ? "run" : "welcome"), [jobId]);

  const openPanel = (id: HomePanel) => {
    setPanel(id);
    showSide();
  };
  const openRepos = () => {
    openPanel("repos");
    window.setTimeout(() => filterField.current?.focus(), 30);
  };

  // Search and jump's destinations (`/code#local-repositories`, `/code#reviews`).
  useEffect(() => {
    const section = window.location.hash.slice(1);
    if (section === "local-repositories") openPanel("repos");
    else if (section === "reviews") openPanel("scm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest?.(".cm-editor")) setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const places = home.states.map((state) => state.place);
  const selected = places.find((place) => place.target.kind === "device" && place.target.deviceId === computerId) ?? places.find((place) => place.usable) ?? places[0] ?? null;
  const canTerminal = !viewOnly && Boolean(selected?.terminal);
  const needs = home.reviews.filter((review) => !review.completedAt);
  const running = home.runs.filter((job) => job.status === "running" || job.status === "claimed").length;
  const noComputer = home.mode === "computers" && home.devices.isSuccess && places.length === 0;

  const openTerminal = (place: CodePlace | null = selected) => {
    if (place?.target.kind === "device") setComputerId(place.target.deviceId);
    setTerminal(true);
  };

  const job = useQuery({ queryKey: ["job", jobId], queryFn: () => api.job(jobId!), enabled: Boolean(jobId) });

  return (
    <IdeSpace className={cx("flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg", full ? "fixed inset-0 z-[70]" : "relative h-full")} root>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ActivityBar
          items={[
            { id: "home", icon: House, label: "Welcome", onClick: () => setTab("welcome") },
            ...(
              [
                ["repos", FolderGit2, "Explorer (Ctrl+B)", 0],
                ["search", Search, "Search", 0],
                ["scm", GitPullRequestArrow, "Changes to review", needs.length],
              ] as const
            ).map(([id, icon, label, badge]) => ({
              id,
              icon,
              label,
              badge,
              active: sideOpen && panel === id,
              onClick: () => {
                if (sideOpen && panel === id) setSideOpen(false);
                else openPanel(id);
              },
            })),
          ]}
          bottom={viewOnly ? [] : [{ id: "terminal", icon: TerminalSquare, label: canTerminal ? "Terminal (Ctrl+`)" : "Terminal (needs a computer that allows it)", active: terminal && canTerminal, onClick: () => (canTerminal ? setTerminal(!terminal) : undefined) }]}
        />

        <SidePanel layout={layout}>
          {panel === "repos" ? (
            <ExplorerPanel home={home} filter={filter} setFilter={setFilter} field={filterField} selected={selected} onTerminal={(place) => openTerminal(place)} noComputer={noComputer} />
          ) : panel === "search" ? (
            <SearchPanel onOpenRepos={openRepos} />
          ) : (
            <ReviewsPanel home={home} />
          )}
        </SidePanel>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-sidebar text-[12.5px]" role="tablist" aria-label="Open editors">
            <button type="button" className="icon-btn my-auto ml-1 h-7 w-7 shrink-0" title="Show or hide the side panel (Ctrl+B)" aria-label="Show or hide the side panel" onClick={() => setSideOpen(!sideOpen)}>
              <PanelLeft size={14} />
            </button>
            <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
              <EditorTab icon={Code2} label="Welcome" active={tab === "welcome"} onSelect={() => setTab("welcome")} />
              {jobId ? (
                <EditorTab icon={FileCode2} label={job.data?.job.title ?? "Run"} active={tab === "run"} onSelect={() => setTab("run")} onClose={onCloseRun} />
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 px-1.5">
              {viewOnly ? (
                <span className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px] text-muted" title={`Changes and the terminal stay with ${access.owner ?? "the owner"}.`}>
                  <Lock size={12} /> View only
                </span>
              ) : home.mode === "local" && shell.data?.space ? (
                <span className="max-sm:hidden">
                  <ShareButton target={{ kind: "code", resourceId: shell.data.space.id, title: "Code" }} />
                </span>
              ) : null}
              <span className="flex items-center gap-1.5 max-sm:hidden">
                <ThemeControl />
              </span>
              <button type="button" className="icon-btn h-7 w-7" title={full ? "Leave full screen (Esc)" : "Full screen"} aria-label={full ? "Leave full screen" : "Full screen"} onClick={() => setFull(!full)}>
                {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </div>

          {tab === "run" && jobId ? (
            job.isLoading ? (
              <div className="p-8"><Spinner /></div>
            ) : job.error || !job.data ? (
              <InlineError error={job.error ?? new Error("That run was not found.")} retry={() => void job.refetch()} />
            ) : (
              <RunCode key={job.data.job.id} job={job.data.job} initialPath={file} embedded onClose={onCloseRun} />
            )
          ) : (
            <Welcome
              home={home}
              needs={needs}
              noComputer={noComputer}
              viewOnly={viewOnly}
              canTerminal={canTerminal}
              onOpenRepos={openRepos}
              onReviews={() => openPanel("scm")}
              onTerminal={() => openTerminal()}
            />
          )}

          {terminal && canTerminal && selected ? (
            <BottomPanel layout={layout}>
              <Terminal key={selected.key} target={selected.target} fontSize={fontSize} onClose={() => setTerminal(false)} />
            </BottomPanel>
          ) : null}
        </div>
      </div>

      <StatusBar>
        {home.mode === "computers" && places.length > 1 ? (
          <Popover
            align="left"
            width={260}
            trigger={(open, toggle) => (
              <button type="button" onClick={toggle} aria-expanded={open} title="Which computer the terminal and this bar are about" className="flex h-full items-center gap-1 rounded-sm px-1.5 hover:bg-hover hover:text-ink">
                <PlaceLabel place={selected} />
                <ChevronDown size={10} />
              </button>
            )}
          >
            {(close) =>
              places.map((place) => (
                <MenuItem
                  key={place.key}
                  active={place.key === selected?.key}
                  hint={place.online ? "online" : "offline"}
                  onClick={() => {
                    if (place.target.kind === "device") setComputerId(place.target.deviceId);
                    close();
                  }}
                >
                  {place.name}
                </MenuItem>
              ))
            }
          </Popover>
        ) : selected ? (
          <StatusItem title={selected.online ? "Online" : "Offline"}>
            <PlaceLabel place={selected} />
          </StatusItem>
        ) : null}
        {selected?.version ? <StatusItem className="max-sm:hidden" title={selected.target.kind === "local" ? "Ensemble's version" : "Ensemble's version on this computer"}>v{selected.version}</StatusItem> : null}
        {home.mode !== "loading" && !noComputer ? (
          <StatusItem icon={GitPullRequestArrow} title="Agent changes to review" onClick={() => openPanel("scm")}>
            {needs.length} to review
          </StatusItem>
        ) : null}
        {running ? (
          <StatusItem icon={RefreshCw} href="/runs" title="Code runs working now" className="max-sm:hidden">
            {running} running
          </StatusItem>
        ) : null}
        <div className="flex-1" />
        <FontSizeControl fontSize={fontSize} setFontSize={setFontSize} />
      </StatusBar>
    </IdeSpace>
  );
}

function PlaceLabel({ place }: { place: CodePlace | null }) {
  if (!place) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Laptop size={11} className="shrink-0" />
      <span className="max-w-[16rem] truncate">{place.name}</span>
      <OnlineDot online={place.online} />
    </span>
  );
}

function EditorTab({ icon: Icon, label, active, onSelect, onClose }: { icon: ComponentType<{ size?: number; className?: string }>; label: string; active: boolean; onSelect: () => void; onClose?: () => void }) {
  return (
    <div role="tab" aria-selected={active} className={cx("group relative flex max-w-[260px] shrink-0 items-center gap-1.5 border-r border-line px-3", active ? "bg-bg text-ink" : "text-muted hover:text-ink")}>
      {active ? <span className="absolute inset-x-0 top-0 h-px bg-accent" aria-hidden /> : null}
      <button type="button" className="flex min-w-0 items-center gap-1.5" onClick={onSelect} title={label}>
        <Icon size={13} className={cx("shrink-0", active ? "text-accent" : undefined)} />
        <span className="truncate">{label}</span>
      </button>
      {onClose ? (
        <button type="button" className="icon-btn h-4 w-4 shrink-0" title="Close" aria-label={`Close ${label}`} onClick={onClose}>
          <X size={11} className="opacity-60 group-hover:opacity-100" />
        </button>
      ) : null}
    </div>
  );
}

function ExplorerPanel({
  home,
  filter,
  setFilter,
  field,
  selected,
  onTerminal,
  noComputer,
}: {
  home: Home;
  filter: string;
  setFilter: (value: string) => void;
  field: React.RefObject<HTMLInputElement | null>;
  selected: CodePlace | null;
  onTerminal: (place: CodePlace) => void;
  noComputer: boolean;
}) {
  const local = home.mode === "local" ? home.states[0] : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title={home.mode === "computers" ? "Your computers" : "Explorer"}>
        <button
          type="button"
          className="icon-btn h-6 w-6"
          title="Look again"
          aria-label="Refresh repositories"
          onClick={() => {
            for (const state of home.states) {
              void state.repos.refetch();
              void state.reviews.refetch();
            }
            if (home.mode === "computers") void home.devices.refetch();
          }}
        >
          <RefreshCw size={12} />
        </button>
      </PanelHeader>
      {noComputer ? null : (
        <div className="px-2 pb-2">
          <div className="tile flex items-center gap-1.5 rounded-md bg-panel px-2 py-1">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              ref={field}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const first = (event.currentTarget.closest("aside")?.querySelector("[data-repo-list] a[href]") as HTMLAnchorElement | null) ?? null;
                first?.click();
              }}
              placeholder="Find a repository"
              aria-label="Find a repository"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-repo-list>
        {home.mode === "loading" ? (
          <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-3" />
        ) : home.mode === "computers" ? (
          <ComputersCode selected={selected?.target.kind === "device" ? selected.target.deviceId : null} filter={filter} onTerminal={(id) => onTerminal(home.states.find((state) => state.place.key === `device:${id}`)?.place ?? selected!)} />
        ) : local ? (
          <Fold title="Repositories" count={local.views.filter((view) => view.kind !== "run").length}>
            {local.repos.isLoading ? (
              <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-3" />
            ) : local.repos.error ? (
              <InlineError error={local.repos.error} retry={() => void local.repos.refetch()} />
            ) : (
              <RepoList repos={matchRepos(local.views, filter)} hrefOf={(path) => repoHref(local.place, path)} empty={filter.trim() ? "None match." : "No git checkouts in the workspace or your Code folders."} />
            )}
          </Fold>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-line px-3 py-2 text-[12px]">
        {home.mode === "computers" ? (
          <Link href="/settings#devices" className="flex items-center gap-1.5 text-muted hover:text-ink">
            <Laptop size={12} /> {noComputer ? "Pair a computer" : "Computers"}
          </Link>
        ) : (
          <Link href="/settings#terminal" className="flex items-center gap-1.5 text-muted hover:text-ink">
            <Settings2 size={12} /> Folders Code can use
          </Link>
        )}
      </div>
    </div>
  );
}

function SearchPanel({ onOpenRepos }: { onOpenRepos: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title="Search" />
      <div className="px-3 py-1 text-muted">
        <p>Open a repository to find its files and search inside them.</p>
        <button type="button" className="btn mt-3 w-full justify-center text-[12.5px]" onClick={onOpenRepos}>
          <FolderOpen size={13} /> Open a repository…
        </button>
      </div>
    </div>
  );
}

function ReviewsPanel({ home }: { home: Home }) {
  const [filter, setFilter] = useState<Filter>("needs");
  const [expired, setExpired] = useState(false);
  const local = home.mode === "local";
  // Expired reviews come from this computer's server; otherwise the Welcome's list is filtered here.
  const own = useQuery({ queryKey: ["reviews", filter, true], queryFn: () => api.reviews(filter, true), enabled: local && expired });
  const views = home.states[0]?.views ?? [];
  const rows: HomeReview[] =
    local && expired && own.data
      ? own.data.reviews.map((review) => ({ ...review, place: home.states[0]!.place, href: `/code/review?review=${encodeURIComponent(review.id)}`, repo: repoName(viewFor(review.repoPath, views)) }))
      : home.reviews.filter((review) => (filter === "needs" ? !review.completedAt : filter === "reviewed" ? Boolean(review.completedAt) : true));
  const loading = home.mode === "loading" || home.reviewsLoading || (local && expired && own.isLoading);
  const several = home.states.length > 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title="Changes to review" />
      <div className="space-y-2 px-2 pb-2">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          label="Which changes"
          options={[
            { id: "needs", label: "To review" },
            { id: "reviewed", label: "Reviewed" },
            { id: "all", label: "All" },
          ]}
        />
        {local ? (
          <label className="flex items-center gap-2 px-1 text-[12px] text-muted">
            <input type="checkbox" checked={expired} onChange={(event) => setExpired(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
            Show expired (older than {home.ttlDays} days)
          </label>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {loading ? (
          <SkeletonRows count={3} rowClassName="h-9" className="space-y-1.5 px-2" />
        ) : (
          <>
            {(local && expired && own.error ? [{ error: own.error, retry: () => void own.refetch(), where: undefined }] : home.reviewErrors.map((state) => ({ error: state.reviews.error, retry: () => void state.reviews.refetch(), where: several ? state.place.name : undefined }))).map((row, index) => (
              <InlineError key={index} error={row.error} retry={row.retry} where={row.where} />
            ))}
            {rows.length ? (
              <div className="space-y-0.5">
                {rows.map((review) => (
                  <ReviewItem key={`${review.place.key}:${review.id}`} review={review} repo={review.repo} href={review.href} where={several ? review.place.name : null} compact />
                ))}
              </div>
            ) : (
              <div className="px-2 py-1 text-muted">{filter === "reviewed" ? "Nothing reviewed yet." : filter === "needs" ? "Nothing to review." : "No agent changes yet."}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 px-2 text-[13.5px] font-semibold text-ink">
        {title}
        {count ? <span className="rounded bg-raised px-1.5 text-[11px] font-medium tabular-nums text-muted">{count}</span> : null}
        <span className="flex-1" />
        {action}
      </h2>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-[13px] text-muted">{children}</p>;
}

function Welcome({
  home,
  needs,
  noComputer,
  viewOnly,
  canTerminal,
  onOpenRepos,
  onReviews,
  onTerminal,
}: {
  home: Home;
  needs: HomeReview[];
  noComputer: boolean;
  viewOnly: boolean;
  canTerminal: boolean;
  onOpenRepos: () => void;
  onReviews: () => void;
  onTerminal: () => void;
}) {
  const several = home.states.length > 1;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="code-welcome">
      <div className="mx-auto w-full max-w-[1040px] px-4 pb-16 pt-8 sm:px-10 md:pt-14">
        <header className="mb-9 flex min-w-0 items-center gap-3.5 px-2 md:mb-12">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Code2 size={22} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-ink md:text-[28px]">Code</h1>
            <p className="text-[13.5px] text-muted">
              {noComputer ? "Code works on your own computers. Pair one to review what agents change there." : "Review what agents changed, then commit and push."}{" "}
              <InfoTip
                label="About Code"
                text={
                  home.mode === "computers"
                    ? "Agents work in folders on your paired computers, and their changes stay there. Code reads them from each computer when you open them; nothing about your code is kept on Ensemble on the web."
                    : "Repositories are the checkouts in Ensemble's workspace and the folders in Settings › Folders Code can use. An agent's changes stay in their folder until you accept or discard them; open one to review it hunk by hunk."
                }
              />
            </p>
          </div>
        </header>

        {noComputer ? (
          <div className="px-2">
            <Link href="/settings#devices" className="btn-primary">
              <Plus size={14} /> Pair a computer
            </Link>
          </div>
        ) : (
          <div className="grid min-w-0 gap-x-14 gap-y-10 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-10">
              <Section title="Start">
                <div className="space-y-0.5">
                  <StartItem icon={FolderOpen} label="Open a repository…" hint="Ctrl+B" onClick={onOpenRepos} />
                  <StartItem icon={GitPullRequestArrow} label="Review agent changes" hint={needs.length ? String(needs.length) : undefined} onClick={onReviews} />
                  {viewOnly ? null : <StartItem icon={TerminalSquare} label="Open terminal" hint="Ctrl+`" onClick={onTerminal} disabled={!canTerminal} />}
                  {home.mode === "computers" ? (
                    <StartItem icon={Laptop} label="Your computers" href="/settings#devices" />
                  ) : (
                    <StartItem icon={Settings2} label="Folders Code can use" href="/settings#terminal" small />
                  )}
                </div>
              </Section>
              <RecentRepos home={home} several={several} onOpenRepos={onOpenRepos} />
            </div>
            <div className="min-w-0 space-y-10">
              <NeedsReview home={home} needs={needs} several={several} />
              <RecentRuns home={home} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StartItem({ icon: Icon, label, hint, onClick, href, disabled, small }: { icon: ComponentType<{ size?: number; className?: string }>; label: string; hint?: string; onClick?: () => void; href?: string; disabled?: boolean; small?: boolean }) {
  const className = cx("flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:opacity-50", small ? "text-[12.5px] text-muted hover:text-ink" : "text-[13.5px] text-ink");
  const body = (
    <>
      <Icon size={small ? 14 : 16} className={cx("shrink-0", small ? undefined : "text-accent")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className={cx("shrink-0 font-mono text-[11px] text-faint", /^\d+$/.test(hint) ? "tabular-nums" : "max-md:hidden")}>{hint}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled} title={disabled ? "Pick a computer that allows its terminal from the web" : undefined}>
      {body}
    </button>
  );
}

function NeedsReview({ home, needs, several }: { home: Home; needs: HomeReview[]; several: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? needs : needs.slice(0, REVIEWS_SHOWN);
  return (
    <Section
      title="Needs review"
      count={needs.length}
      action={
        needs.length > REVIEWS_SHOWN ? (
          <button type="button" className="text-[12px] font-normal text-muted hover:text-ink" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `View all ${needs.length}`}
          </button>
        ) : null
      }
    >
      {home.reviewErrors.map((state) => (
        <InlineError key={state.place.key} error={state.reviews.error} retry={() => void state.reviews.refetch()} where={several ? state.place.name : undefined} />
      ))}
      {home.mode === "loading" || home.reviewsLoading ? (
        <SkeletonRows count={3} rowClassName="h-10" className="space-y-2 px-2" />
      ) : shown.length ? (
        <div className="space-y-0.5">
          {shown.map((review) => (
            <ReviewItem key={`${review.place.key}:${review.id}`} review={review} repo={review.repo} href={review.href} where={several ? review.place.name : null} />
          ))}
        </div>
      ) : home.reviewErrors.length ? null : (
        <Quiet>
          <Check size={13} className="mr-1.5 inline text-ok" />
          Nothing to review. Agent changes show here when a code run finishes.
        </Quiet>
      )}
    </Section>
  );
}

/** Recent folders and checkouts; run checkouts only while recent and named by their task or origin. */
function RecentRepos({ home, several, onOpenRepos }: { home: Home; several: boolean; onOpenRepos: () => void }) {
  const recent = home.repos
    .filter((repo) => repo.kind !== "run" || (usedWithin(repo, home.ttlDays) && Boolean(repo.taskTitle || repo.remote)))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const shown = recent.slice(0, REPOS_SHOWN);
  const hidden = home.repos.reduce((sum, repo) => sum + 1 + repo.others.length, 0) - shown.length;
  return (
    <Section
      title="Recent repositories"
      action={
        hidden > 0 ? (
          <button type="button" className="text-[12px] font-normal text-muted hover:text-ink" onClick={onOpenRepos}>
            More…
          </button>
        ) : null
      }
    >
      {home.repoErrors.map((state) => (
        <InlineError key={state.place.key} error={state.repos.error} retry={() => void state.repos.refetch()} where={several ? state.place.name : undefined} />
      ))}
      {home.mode === "loading" || home.reposLoading ? (
        <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-2" />
      ) : shown.length ? (
        <div className="space-y-px">
          {shown.map((repo) => (
            <RecentRepo key={`${repo.place.key}:${repo.path}`} repo={repo} where={several ? repo.place.name : null} />
          ))}
        </div>
      ) : home.repoErrors.length ? null : (
        <Quiet>{home.mode === "computers" ? "No repositories on your computers yet." : "No repositories yet."}</Quiet>
      )}
    </Section>
  );
}

function RecentRepo({ repo, where }: { repo: HomeRepo; where: string | null }) {
  return (
    <Link href={repo.href} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-hover focus-visible:bg-hover" title={repo.kind === "run" ? repo.name : repo.path}>
      <FolderGit2 size={14} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-ink">{repo.name}</span>
        {repoSecond(repo, where) ? <span className="ml-2 text-[12px] text-faint">{repoSecond(repo, where)}</span> : null}
      </span>
    </Link>
  );
}

function runRepo(job: AgentJob): string | null {
  if (job.folderLabel) return job.folderLabel;
  const remote = remoteLabel(job.repoUrl);
  if (remote) return remote;
  return job.folder ? repoName(repoView(job.folder)) : null;
}

/** The last few code runs as a slim timeline: state, task, repository, computer, when. */
function RecentRuns({ home }: { home: Home }) {
  const runs = home.runs.slice(0, RUNS_SHOWN);
  return (
    <Section
      title="Recent agent runs"
      action={
        <Link href="/runs" className="text-[12px] font-normal text-muted hover:text-ink">
          All runs
        </Link>
      }
    >
      {home.board.isLoading || home.mode === "loading" ? (
        <SkeletonRows count={3} rowClassName="h-8" className="space-y-2 px-2" />
      ) : home.board.error ? (
        <InlineError error={home.board.error} retry={() => void home.board.refetch()} />
      ) : runs.length ? (
        <ol className="relative ml-[13px] border-l border-line">
          {runs.map((job) => {
            const tone = jobTone(job);
            const busy = job.status === "running" || job.status === "claimed";
            const repo = runRepo(job);
            const lines = (job.files ?? []).reduce((sum, row) => ({ added: sum.added + row.added, removed: sum.removed + row.removed }), { added: 0, removed: 0 });
            const meta = [tone.label, repo, job.deviceId && (home.mode === "local" || home.states.length > 1) ? job.deviceName : null].filter(Boolean).join(" · ");
            return (
              <li key={job.id} className="relative pb-1 pl-3">
                <span className={cx("absolute -left-[4.5px] top-[11px] h-2 w-2 rounded-full ring-[3px] ring-[rgb(var(--bg-rgb))]", TONE_DOT[tone.tone] ?? "bg-faint", busy && "animate-pulse")} aria-hidden />
                <div className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-hover">
                  <Link href={job.runId ? `/runs?run=${encodeURIComponent(job.runId)}` : "/runs"} className="min-w-0 flex-1 px-2 py-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{job.title}</span>
                      {lines.added || lines.removed ? <Lines added={lines.added} removed={lines.removed} /> : null}
                      <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{relative(job.finishedAt ?? job.startedAt ?? job.createdAt)}</span>
                    </span>
                    <span className="block truncate text-[11.5px] text-muted">{meta}</span>
                  </Link>
                  {job.deviceId && job.files?.length ? (
                    <Link href={`/code?job=${encodeURIComponent(job.id)}`} className="icon-btn mr-1 h-6 w-6 shrink-0" title="Open the files it changed" aria-label={`Open the files ${job.title} changed`}>
                      <FileCode2 size={12} />
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <Quiet>
          No code runs yet.{" "}
          <Link href="/runs" className="text-accent hover:underline">
            <ListTree size={12} className="mr-0.5 inline" /> Runs
          </Link>
        </Quiet>
      )}
    </Section>
  );
}
