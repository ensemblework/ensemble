"use client";

/**
 * Code's home (`/code`, docs/16): the same window as the editor (`ide.tsx`) opened on a Welcome tab
 * about agent work: what to start with, changes to review, recent repositories and recent code runs.
 * On this computer it reads this Ensemble; on Ensemble on the web, each paired computer
 * (`lib/code-home.ts`). `/code?job=<id>&file=<path>` opens a run's files read-only in a second tab.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Code2,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitPullRequestArrow,
  Laptop,
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
import { useCallback, useEffect, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { InlineError, RepoList, ReviewItem } from "@/components/code/code-lists";
import { ActivityBar, BottomPanel, FONT_DEFAULT, FONT_MAX, FONT_MIN, FontSizeControl, OnlineDot, useFullscreen, PanelHeader, ScrollTabs, SidePanel, StatusBar, StatusItem, textScale, useIdeKeys, useIdeLayout } from "@/components/code/ide-chrome";
import { IdeSpace, THEME_PICKER_EVENT, ThemeControl } from "@/components/code/ide-theme";
import { QuickOpen, useKeyLabel, useLinkNavigate, type QuickList } from "@/components/code/quick-open";
import { RunCode } from "@/components/code/run-code";
import { Terminal } from "@/components/code/terminal";
import { ShareButton } from "@/components/sharing/share-dialog";
import { InfoTip, Segmented, SkeletonRows, Spinner, cx } from "@/components/ui";
import { useSpaceAccess } from "@/lib/access";
import { api } from "@/lib/api";
import { AgentIcon } from "@/components/agent-icon";
import { AgentSessions, type ThreadPlace } from "@/components/code/agent-sessions";
import { AgentView, type FolderChoice, type PlaceChoice } from "@/components/code/agent-view";
import { agentHref, sessionsMinWidth, type IdeView } from "@/lib/code-agent";
import { MachineSwitcher } from "@/components/code/machine-switcher";
import { FolderPicker } from "@/components/code/folder-picker";
import { ThreadNameField, useCodePresence, useCodeThreads, useThreadTabActions } from "@/components/code/agent-actions";
import { repoHref, useCodeHome, type CodeHome as Home, type CodePlace, type HomeReview } from "@/lib/code-home";
import { matchRepos, repoName, repoSecond, shortBranch, usedWithin, viewFor } from "@/lib/code-repos";
import { parseQuickInput, rankByLabel } from "@/lib/code-quick-open";
import { usePersistentState } from "@/lib/prefs";

type HomePanel = "repos" | "search" | "scm" | "agent";

/** The agent's sessions panel never takes more than this share of the window (docs/16 §9). */
const SESSIONS_MAX_SHARE = 0.3;
type Filter = "needs" | "reviewed" | "all";

const REVIEWS_SHOWN = 3;
const REPOS_SHOWN = 5;
/** The threads Code's home keeps open as tabs at most; the oldest closes first. */
const MAX_THREAD_TABS = 8;
/** The tab of a thread not started yet. */
const NEW_THREAD = "new";


export function CodeHome({
  jobId,
  file,
  onCloseRun,
  initialView = null,
  initialThread = null,
  initialPlace = null,
}: {
  jobId: string | null;
  file: string | null;
  onCloseRun: () => void;
  /** `?view=agent|editor`. */
  initialView?: IdeView | null;
  /** `?thread=<id>`, or "new". */
  initialThread?: string | null;
  /** `?device=&repo=`: where a new thread starts. */
  initialPlace?: ThreadPlace | null;
}) {
  const access = useSpaceAccess();
  const viewOnly = access.guest;
  // Code shows one machine at a time (docs/16 §1): the one picked last, else the first that answers.
  const [computerId, setComputerId] = usePersistentState<string | null>("ensemble.code.computer", null);
  const home = useCodeHome(computerId);
  const layout = useIdeLayout();
  const [quick, setQuick] = useState<{ text: string; nonce: number } | null>(null);
  const openQuick = (text: string) => setQuick({ text, nonce: Date.now() });
  useIdeKeys(layout, openQuick);
  const label = useKeyLabel();
  const navigate = useLinkNavigate();
  const { sideOpen, setSideOpen, showSide, terminal, setTerminal, fontSize, setFontSize } = layout;
  const [panel, setPanel] = usePersistentState<HomePanel>("ensemble.code.homePanel", "repos");
  const [picking, setPicking] = useState(false);
  const [tab, setTab] = useState<"welcome" | "run">(jobId ? "run" : "welcome");
  const [full, setFull] = useFullscreen();
  const [filter, setFilter] = useState("");
  const filterField = useRef<HTMLInputElement>(null);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  // Editor or Agent, as in a repository's window (docs/16 §9). The agent here needs no repository.
  const [view, setViewState] = usePersistentState<IdeView>("ensemble.code.view", "editor");
  const [agentMounted, setAgentMounted] = useState(false);
  const [homeThread, setHomeThread] = usePersistentState<string | null>("ensemble.code.homeThread", null);
  const [visibleSession, setVisibleSession] = useState<string | null>(null);
  // The threads open as tabs beside the Welcome: their ids, "new" for one not started yet.
  const [homeTabs, setHomeTabs] = usePersistentState<string[]>("ensemble.code.homeThreadTabs", []);
  const [homeTabsClosed, setHomeTabsClosed] = useState(false);
  const threadList = useCodeThreads();
  const [draft, setDraft] = usePersistentState<ThreadPlace | null>("ensemble.code.draftPlace", null);
  const setView = useCallback(
    (next: IdeView) => {
      setViewState(next);
      if (next === "agent") setAgentMounted(true);
      setPanel((current) => (next === "agent" ? "agent" : current === "agent" ? "repos" : current));
    },
    [setViewState, setPanel],
  );
  useEffect(() => {
    if (initialView) setView(initialView);
    if (initialThread) setHomeThread(initialThread === "new" ? null : initialThread);
    if (initialPlace) setDraft(initialPlace);
    // The address names them once, when Code opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (view === "agent") {
      setAgentMounted(true);
      setHomeTabsClosed(false);
    }
  }, [view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.code !== "KeyI") return;
      event.preventDefault();
      setView(view === "agent" ? "editor" : "agent");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, setView]);

  useEffect(() => setTab(jobId ? "run" : "welcome"), [jobId]);
  // Ctrl/⌘+O opens a folder, as in an editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      setPicking(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPanel = (id: HomePanel) => {
    setPanel(id);
    showSide();
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
  const selected = home.current?.place ?? null;
  const selectedId = selected?.target.kind === "device" ? selected.target.deviceId : null;
  const pickMachine = (place: CodePlace) => {
    if (place.target.kind === "device") setComputerId(place.target.deviceId);
  };
  // The agent's choices: every computer, and the folders Code can use on the one shown (not run checkouts).
  const agentPlaces: PlaceChoice[] = places.map((place) => ({ deviceId: place.target.kind === "device" ? place.target.deviceId : null, name: place.name, online: place.online }));
  const agentFolders: FolderChoice[] = home.repos
    .filter((repo) => repo.kind !== "run")
    .map((repo) => ({ deviceId: repo.place.target.kind === "device" ? repo.place.target.deviceId : null, path: repo.path, name: repoName(repo), branch: shortBranch(repo.branch) }));
  // A new thread starts on the machine shown; picking another one there shows that one.
  const agentDraft: ThreadPlace = { deviceId: selectedId, folder: draft && (draft.deviceId ?? null) === selectedId ? draft.folder : null };
  const setAgentDraft = (place: ThreadPlace) => {
    setDraft(place);
    if ((place.deviceId ?? null) !== selectedId && place.deviceId) setComputerId(place.deviceId);
  };
  // Threads as tabs: the one in view always has its tab, and keeps it while the Welcome shows.
  const activeKey = homeThread ?? NEW_THREAD;
  const threadTabs = !homeTabs.includes(activeKey) && (view === "agent" || (agentMounted && !homeTabsClosed)) ? [...homeTabs, activeKey] : homeTabs;
  const keepTabs = (next: string[]) => setHomeTabs(next.slice(-MAX_THREAD_TABS));
  const openThread = (id: string | null) => {
    const key = id ?? NEW_THREAD;
    setHomeTabsClosed(false);
    keepTabs(threadTabs.includes(key) ? threadTabs : [...threadTabs, key]);
    setHomeThread(id);
    setView("agent");
  };
  const closeThread = (key: string) => {
    const rest = threadTabs.filter((row) => row !== key);
    keepTabs(rest);
    if (key !== activeKey) return;
    const next = rest[Math.max(0, threadTabs.indexOf(key) - 1)];
    if (next) setHomeThread(next === NEW_THREAD ? null : next);
    else {
      setHomeTabsClosed(true);
      setHomeThread(null);
      setView("editor");
    }
  };
  // A thread's tab carries its menu and rename (agent-actions.tsx).
  const threadTab = useThreadTabActions(closeThread);
  // While Code is in front of the person, a thread's finished turn shows in the list instead of notifying.
  useCodePresence();
  const threadTitles = new Map((threadList.data?.threads ?? []).map((row) => [row.id, row]));
  const sessionsMin = sessionsMinWidth((threadList.data?.threads ?? []).filter((row) => (row.place.deviceId ?? null) === selectedId).map((row) => row.title));
  const canTerminal = !viewOnly && Boolean(selected?.terminal);
  const needs = home.reviews.filter((review) => !review.completedAt);
  const running = home.runs.filter((job) => job.status === "running" || job.status === "claimed").length;
  const noComputer = home.mode === "computers" && home.devices.isSuccess && places.length === 0;


  const job = useQuery({ queryKey: ["job", jobId], queryFn: () => api.job(jobId!), enabled: Boolean(jobId) });

  /** Quick open on the Welcome: repositories by name (Ctrl/⌘+P), or the window's commands (`>`). */
  const resolveQuick = (text: string): QuickList => {
    const input = parseQuickInput(text);
    if (input.mode === "commands") {
      const commands = [
        { id: "open-folder", label: "Open a folder", keys: "mod+o", run: () => setPicking(true) },
        { id: "open-repo", label: "Find a repository", keys: "mod+p", run: () => openQuick("") },
        { id: "agent", label: view === "agent" ? "Show the editor" : "Code with an agent", keys: "ctrl+alt+i", run: () => setView(view === "agent" ? "editor" : "agent") },
        { id: "agent-new", label: "New thread with the agent", run: () => openThread(null) },
        { id: "reviews", label: "Show the changes to review", run: () => openPanel("scm") },
        { id: "explorer", label: "Show the explorer", run: () => openPanel("repos") },
        { id: "side", label: sideOpen ? "Hide the side panel" : "Show the side panel", keys: "mod+b", run: () => setSideOpen(!sideOpen) },
        ...(canTerminal ? [{ id: "terminal", label: terminal ? "Hide the terminal" : "Show the terminal", keys: "ctrl+`", run: () => setTerminal(!terminal) }] : []),
        { id: "theme", label: "Color theme", run: () => window.dispatchEvent(new Event(THEME_PICKER_EVENT)) },
        { id: "bigger", label: "Bigger text", keys: "mod+shift+=", run: () => setFontSize(Math.min(FONT_MAX, fontSize + 1)) },
        { id: "smaller", label: "Smaller text", keys: "mod+shift+-", run: () => setFontSize(Math.max(FONT_MIN, fontSize - 1)) },
        { id: "reset-size", label: "Reset text size", keys: "mod+shift+0", run: () => setFontSize(FONT_DEFAULT) },
        { id: "full", label: full ? "Leave full screen" : "Full screen", run: () => setFull(!full) },
        { id: "runs", label: "Show agent runs", run: () => navigate.go("/runs") },
        home.mode === "computers" ? { id: "computers", label: "Your computers", run: () => navigate.go("/settings#devices") } : { id: "folders", label: "Folders Code can use", run: () => navigate.go("/settings#terminal") },
      ];
      return { placeholder: "Type the name of a command", empty: "No command matches.", items: rankByLabel(input.query, commands).map((row) => ({ id: row.id, label: row.label, keys: row.keys, hits: row.hits, run: row.run })) };
    }
    const several = home.states.length > 1;
    const repos = home.repos.map((repo) => ({ repo, label: repo.name }));
    const query = input.mode === "files" ? input.query : "";
    return {
      placeholder: "Open a repository by name. > for commands",
      empty: home.reposLoading ? "Reading the repositories…" : query ? "No repository matches." : "No repositories yet.",
      items: rankByLabel(query, repos).slice(0, 50).map(({ repo, hits }) => ({
        id: `${repo.place.key}:${repo.path}`,
        label: repo.name,
        hits,
        detail: [repoSecond(repo, several ? repo.place.name : null)].filter(Boolean).join(" · ") || undefined,
        icon: <FolderGit2 size={14} className="text-muted" />,
        group: repo.kind === "run" ? "agent worktree" : undefined,
        run: () => navigate.go(repo.href),
      })),
    };
  };

  return (
    <IdeSpace className={cx("flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg", full ? "fixed inset-0 z-[70]" : "relative h-full")} root>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ActivityBar
          items={[
            {
              id: "agent",
              icon: AgentIcon,
              label: `Agent (${label("ctrl+alt+i")})`,
              active: view === "agent" && sideOpen && panel === "agent",
              onClick: () => {
                if (view !== "agent") {
                  setView("agent");
                  showSide();
                } else if (sideOpen && panel === "agent") setSideOpen(false);
                else openPanel("agent");
              },
            },
            ...(
              [
                ["repos", FolderGit2, "Explorer (Ctrl+B)", 0],
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

        <SidePanel layout={layout} maxShare={panel === "agent" ? SESSIONS_MAX_SHARE : undefined} minWidth={panel === "agent" ? sessionsMin : undefined}>
          {noComputer ? null : (
            <div className="shrink-0 px-2 pb-1 pt-2">
              <MachineSwitcher places={places} current={selected} onPick={pickMachine} />
            </div>
          )}
          {panel === "agent" ? (
            <AgentSessions
              selected={homeThread}
              onVisibleSelected={setVisibleSession}
              viewOnly={viewOnly}
              machine={{ deviceId: selectedId, online: selected?.online }}
              onSelect={(thread) => openThread(thread.id)}
              onNew={(place) => {
                if (place) setAgentDraft(place);
                openThread(null);
              }}
              onOpenFolder={(place) => navigate.go(agentHref(place, { view: "editor" }))}
            />
          ) : panel === "scm" ? (
            <ReviewsPanel home={home} />
          ) : (
            <ExplorerPanel home={home} filter={filter} setFilter={setFilter} field={filterField} noComputer={noComputer} onOpenFolder={() => setPicking(true)} />
          )}
        </SidePanel>

        {/* The text size scales the Welcome and the threads as it scales the repository window's (`textScale`). */}
        <div className="flex min-w-0 flex-1 flex-col" style={textScale(fontSize)}>
          <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-sidebar text-[12.5px]" role="tablist" aria-label="Open editors">
            <button type="button" className="icon-btn my-auto ml-1 h-7 w-7 shrink-0" title="Show or hide the side panel (Ctrl+B)" aria-label="Show or hide the side panel" onClick={() => setSideOpen(!sideOpen)}>
              <PanelLeft size={14} />
            </button>
            <div role="group" aria-label="Editor or agent" className="ide-view-switch my-auto mr-1.5" data-testid="ide-view-switch">
              <button type="button" aria-pressed={view === "editor"} onClick={() => setView("editor")} title={`Editor (${label("ctrl+alt+i")})`}>
                <Code2 size={13} aria-hidden /> Editor
              </button>
              <button type="button" aria-pressed={view === "agent"} onClick={() => setView("agent")} title={`Agent (${label("ctrl+alt+i")})`}>
                <AgentIcon size={13} aria-hidden /> Agent
              </button>
            </div>
            <ScrollTabs label="Open tabs">
              <EditorTab icon={Code2} label="Welcome" active={view === "editor" && tab === "welcome"} onSelect={() => { setTab("welcome"); setView("editor"); }} />
              {jobId ? (
                <EditorTab icon={FileCode2} label={job.data?.job.title ?? "Run"} active={view === "editor" && tab === "run"} onSelect={() => { setTab("run"); setView("editor"); }} onClose={onCloseRun} />
              ) : null}
              {threadTabs.map((key) => {
                const row = key === NEW_THREAD ? null : threadTitles.get(key);
                return (
                  <EditorTab
                    key={key}
                    icon={AgentIcon}
                    iconClass={row?.last?.status === "running" ? "text-accent" : undefined}
                    label={key === NEW_THREAD ? "New thread" : (row?.title ?? "Thread")}
                    active={view === "agent" && key === activeKey}
                    onSelect={() => openThread(key === NEW_THREAD ? null : key)}
                    onClose={() => closeThread(key)}
                    renaming={threadTab.renaming === key}
                    onRename={(title) => threadTab.finishRename(key, title)}
                    onDoubleClick={key === NEW_THREAD || viewOnly ? undefined : () => threadTab.startRename(key)}
                    onMenu={(event) =>
                      openContextMenu(event, () =>
                        threadTab.menu(key, [{ items: [{ id: "close", label: "Close", icon: X, run: () => closeThread(key) }] }], { viewOnly, openFolder: (place) => navigate.go(agentHref(place, { view: "editor" })) }),
                      )
                    }
                  />
                );
              })}
            </ScrollTabs>
            <button type="button" className="icon-btn my-auto ml-0.5 h-7 w-7 shrink-0" title="New thread with the agent" aria-label="New thread with the agent" onClick={() => openThread(null)}>
              <Plus size={14} />
            </button>
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

          {agentMounted
            ? threadTabs.map((key) => {
                const shown = view === "agent" && key === activeKey;
                return (
                  <div key={key} className={cx("flex min-h-0 flex-1 flex-col", !shown && "hidden")}>
                    <AgentView
                      threadId={key === NEW_THREAD ? null : key}
                      onThread={(id) => {
                        if (id && key === NEW_THREAD) {
                          keepTabs(threadTabs.map((row) => (row === key ? id : row)));
                          setHomeThread(id);
                        } else openThread(id);
                      }}
                      draft={agentDraft}
                      onDraft={setAgentDraft}
                      places={agentPlaces}
                      folders={agentFolders}
                      placesLoading={home.mode === "loading" || (home.mode === "computers" && home.devices.isLoading)}
                      viewOnly={viewOnly}
                      visible={shown}
                      sidebarOwnsMotion={visibleSession === key}
                      onOpenFile={(place, path) => navigate.go(agentHref(place, { view: "editor", file: path }))}
                    />
                  </div>
                );
              })
            : null}
          {view === "agent" ? null : tab === "run" && jobId ? (
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
              onOpenFolder={() => setPicking(true)}
              onAgent={() => openThread(null)}
              onRepos={() => openPanel("repos")}
              onReviews={() => openPanel("scm")}
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
        {selected ? (
          <button type="button" className="ide-status-place" data-offline={selected.online ? undefined : ""} title={places.length > 1 ? "Switch the computer in the side panel" : selected.online ? "Online" : "Offline"} onClick={() => openPanel(panel === "agent" ? "agent" : "repos")}>
            <PlaceLabel place={selected} />
          </button>
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
      {quick ? <QuickOpen key={quick.nonce} initial={quick.text} resolve={resolveQuick} onClose={() => setQuick(null)} /> : null}
      {selected ? (
        <FolderPicker
          open={picking}
          onClose={() => setPicking(false)}
          target={selected.target}
          computerName={selected.name}
          fallback={home.repos.filter((repo) => repo.kind !== "run").map((repo) => ({ path: repo.path, name: repo.name }))}
          onPick={(folder) => {
            setPicking(false);
            navigate.go(repoHref(selected, folder.path));
          }}
        />
      ) : null}
      {navigate.link}
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

function EditorTab({
  icon: Icon,
  iconClass,
  label,
  active,
  onSelect,
  onClose,
  onMenu,
  onDoubleClick,
  renaming = false,
  onRename,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  iconClass?: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onMenu?: (event: ReactMouseEvent) => void;
  onDoubleClick?: () => void;
  renaming?: boolean;
  onRename?: (title: string | null) => void;
}) {
  return (
    <div role="tab" aria-selected={active} className={cx("group relative flex max-w-[260px] shrink-0 items-center gap-1.5 border-r border-line px-3", active ? "bg-bg text-ink" : "text-muted hover:text-ink")} onContextMenu={onMenu} onDoubleClick={onDoubleClick}>
      {active ? <span className="absolute inset-x-0 top-0 h-px bg-accent" aria-hidden /> : null}
      {renaming ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon size={13} className={cx("shrink-0", active ? "text-accent" : undefined, iconClass)} />
          <ThreadNameField title={label} onDone={(title) => onRename?.(title)} />
        </span>
      ) : (
        <button type="button" className="flex min-w-0 items-center gap-1.5" onClick={onSelect} title={label}>
          <Icon size={13} className={cx("shrink-0", active ? "text-accent" : undefined, iconClass)} />
          <span className="truncate">{label}</span>
        </button>
      )}
      {onClose ? (
        <button type="button" className="icon-btn h-4 w-4 shrink-0" title="Close" aria-label={`Close ${label}`} onClick={onClose}>
          <X size={11} className="opacity-60 group-hover:opacity-100" />
        </button>
      ) : null}
    </div>
  );
}

/** The machine shown's repositories, found by name; Open a folder browses for one that is not listed. */
function ExplorerPanel({
  home,
  filter,
  setFilter,
  field,
  noComputer,
  onOpenFolder,
}: {
  home: Home;
  filter: string;
  setFilter: (value: string) => void;
  field: React.RefObject<HTMLInputElement | null>;
  noComputer: boolean;
  onOpenFolder: () => void;
}) {
  const state = home.current;
  const place = state?.place ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <PanelHeader title="Repositories">
        {place?.usable ? (
          <button type="button" className="icon-btn h-6 w-6" title="Open a folder" aria-label="Open a folder" onClick={onOpenFolder}>
            <FolderOpen size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn h-6 w-6"
          title="Look again"
          aria-label="Refresh repositories"
          onClick={() => {
            if (state) {
              void state.repos.refetch();
              void state.reviews.refetch();
            }
            if (home.mode === "computers") void home.devices.refetch();
          }}
        >
          <RefreshCw size={12} />
        </button>
      </PanelHeader>
      {noComputer ? (
        <div className="px-3 py-1 text-muted">
          No paired computer yet. <Link href="/settings#devices" className="text-accent hover:underline">Pair a computer</Link>
        </div>
      ) : (
        <div className="px-2 pb-2">
          <div className="compound-field flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2">
            <Search size={12} className="shrink-0 text-faint" aria-hidden />
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
        {home.mode === "loading" || (home.mode === "computers" && home.devices.isLoading) ? (
          <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-3" />
        ) : place?.why ? (
          <p className="px-3 py-1 text-muted [overflow-wrap:anywhere]">{place.why}</p>
        ) : state?.repos.isLoading ? (
          <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-3" />
        ) : state?.repos.error ? (
          <InlineError error={state.repos.error} retry={() => void state.repos.refetch()} />
        ) : state && place ? (
          <RepoList repos={matchRepos(state.views, filter)} hrefOf={(path) => repoHref(place, path)} empty={filter.trim() ? "None match." : "No repositories yet. Open a folder to add one."} />
        ) : null}
      </div>
      {place?.target.kind === "local" ? (
        <div className="shrink-0 border-t border-line px-3 py-2 text-[12px]">
          <Link href="/settings#terminal" className="flex items-center gap-1.5 text-muted hover:text-ink">
            <Settings2 size={12} /> Folders Code can use
          </Link>
        </div>
      ) : null}
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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-1.5 flex items-center gap-2 px-2 text-[12.5px] font-medium text-muted">
        <span className="flex-1">{title}</span>
        {action}
      </h2>
      {children}
    </section>
  );
}

/**
 * Code's Welcome (docs/16 §1): the two ways to start and a short list of where you were. The machine
 * it is about is picked in the side panel; everything longer lives there and in Runs.
 */
function Welcome({
  home,
  needs,
  noComputer,
  viewOnly,
  onOpenFolder,
  onAgent,
  onRepos,
  onReviews,
}: {
  home: Home;
  needs: HomeReview[];
  noComputer: boolean;
  viewOnly: boolean;
  onOpenFolder: () => void;
  onAgent: () => void;
  onRepos: () => void;
  onReviews: () => void;
}) {
  const label = useKeyLabel();
  const place = home.current?.place ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="code-welcome">
      <div className="code-welcome-body mx-auto w-full max-w-[620px] px-5 pb-16 pt-10 md:pt-16">
        <header className="mb-7 px-2">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">Code</h1>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
            {noComputer ? (
              "Code works on your own computers."
            ) : place ? (
              <>
                <OnlineDot online={place.online} /> {place.name}
              </>
            ) : null}
            <InfoTip
              label="About Code"
              text={
                home.mode === "computers"
                  ? "Code works in folders on your paired computers and reads them from each one when you open them; nothing about your code is kept on Ensemble on the web. Pick the computer in the side panel."
                  : "Repositories are the checkouts in Ensemble's workspace and the folders in Settings › Folders Code can use. An agent's changes stay in their folder until you accept or discard them."
              }
            />
          </p>
        </header>

        {noComputer ? (
          <div className="px-2">
            <Link href="/settings#devices" className="btn-primary">
              <Plus size={14} /> Pair a computer
            </Link>
          </div>
        ) : (
          <div className="space-y-9">
            <div className="grid gap-2 sm:grid-cols-2">
              <StartItem icon={FolderOpen} label="Open a folder" hint={label("mod+o")} onClick={onOpenFolder} disabled={!place?.usable} />
              {viewOnly ? null : <StartItem icon={AgentIcon} label="Code with an agent" hint={label("ctrl+alt+i")} onClick={onAgent} />}
            </div>
            {place?.why ? <p className="px-2 text-[13px] text-muted [overflow-wrap:anywhere]">{place.why}</p> : null}
            <RecentRepos home={home} onMore={onRepos} />
            <NeedsReview home={home} needs={needs} onMore={onReviews} />
          </div>
        )}
      </div>
    </div>
  );
}

function StartItem({ icon: Icon, label, hint, onClick, disabled }: { icon: ComponentType<{ size?: number; className?: string }>; label: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="code-start" onClick={onClick} disabled={disabled}>
      <Icon size={17} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {hint ? <kbd className="shrink-0 font-sans text-[11px] text-faint max-md:hidden">{hint}</kbd> : null}
    </button>
  );
}

function NeedsReview({ home, needs, onMore }: { home: Home; needs: HomeReview[]; onMore: () => void }) {
  if (home.mode === "loading" || home.reviewsLoading) return null;
  if (home.reviewErrors.length) {
    return (
      <Section title="To review">
        {home.reviewErrors.map((state) => (
          <InlineError key={state.place.key} error={state.reviews.error} retry={() => void state.reviews.refetch()} />
        ))}
      </Section>
    );
  }
  if (!needs.length) return null;
  return (
    <Section
      title={`To review · ${needs.length}`}
      action={
        needs.length > REVIEWS_SHOWN ? (
          <button type="button" className="text-[12px] font-normal text-muted hover:text-ink" onClick={onMore}>
            All
          </button>
        ) : null
      }
    >
      <div className="space-y-px">
        {needs.slice(0, REVIEWS_SHOWN).map((review) => (
          <Link key={`${review.place.key}:${review.id}`} href={review.href} className="code-recent" title={review.title}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{review.title}</span>
            <span className="max-w-[40%] shrink-0 truncate text-[12px] text-faint">{review.repo}</span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

/** Recent folders and checkouts; run checkouts only while recent and named by their task or origin. */
function RecentRepos({ home, onMore }: { home: Home; onMore: () => void }) {
  const recent = home.repos
    .filter((repo) => repo.kind !== "run" || (usedWithin(repo, home.ttlDays) && Boolean(repo.taskTitle || repo.remote)))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const shown = recent.slice(0, REPOS_SHOWN);
  return (
    <Section
      title="Recent"
      action={
        recent.length > REPOS_SHOWN ? (
          <button type="button" className="text-[12px] font-normal text-muted hover:text-ink" onClick={onMore}>
            All
          </button>
        ) : null
      }
    >
      {home.repoErrors.map((state) => (
        <InlineError key={state.place.key} error={state.repos.error} retry={() => void state.repos.refetch()} />
      ))}
      {home.mode === "loading" || home.reposLoading ? (
        <SkeletonRows count={4} rowClassName="h-6" className="space-y-1.5 px-2" />
      ) : shown.length ? (
        <div className="space-y-px">
          {shown.map((repo) => (
            <Link key={`${repo.place.key}:${repo.path}`} href={repo.href} className="code-recent" title={repo.kind === "run" ? repo.name : repo.path}>
              <FolderGit2 size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-ink">{repo.name}</span>
              {repo.branch ? <span className="max-w-[40%] shrink-0 truncate text-[12px] text-faint">{shortBranch(repo.branch)}</span> : null}
            </Link>
          ))}
        </div>
      ) : home.repoErrors.length ? null : (
        <p className="px-2 py-1 text-[13px] text-muted">No repositories yet.</p>
      )}
    </Section>
  );
}
