"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, Code2, FileText, FolderOpen, GitBranch, GitPullRequest, Lock, Monitor, Pencil, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CODE_ENGINES, ENGINE_LABELS, INCLUDED_LABEL, INCLUDED_PROVIDER, type CodeEngine, type ContextTier, type ReasoningEffort, type RunProfile } from "@ensemble/shared-types";
import { api, type AssignInput, type Complexity, type EarlierRun, type HandoffApp } from "@/lib/api";
import { tierModelName } from "@/lib/included";
import { useSpaceAccess } from "@/lib/access";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { desktopShell } from "@/lib/desktop-param";
import { computerName, folderPlace, freshCloneHint } from "@/lib/device-copy";
import { claudeFallback, computerAgent, computerRuns, contextChoice, effortName, engineAssign, engineModel, engineSandboxes, fitEngineChoice, modelFacts } from "@/lib/engine-models";
import { usePersistentState } from "@/lib/prefs";
import { setFeature } from "@/lib/features";
import { useHostCode, useModuleState } from "@/lib/use-module";
import { useQuickAssign } from "./use-quick-assign";
import { canAddProfile, defaultProfile, differs, newProfileId, profileChoices, profileSummary, quickProfile, removeProfile, upsertProfile, type ProfileFields } from "@/lib/run-profiles";
import { MERGE_CHOICES, pullRequestNotices, pullRequestProblem, sharedFolderKinds, type PullRequestMerge } from "@/lib/pull-request";
import { useToast } from "../toast";
import { Dialog, InfoTip, Spinner, Toggle, cx } from "../ui";
import { ThinkingPicker, effortFor } from "../settings/model-picker";
import { PickGitHubRepo } from "../app-items/github-repo-picker";

type Kind = "research" | "code";
type Place = "fresh" | "continue" | "folder";
type Mode = "ask" | "review" | "unattended";
/** "default" or a level the chosen model takes (shared-types model-efforts). */
type Effort = ReasoningEffort;

const PROVIDER_LABEL: Record<string, string> = {
  google: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
  mistral: "Mistral",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  copilot: "GitHub Copilot",
  ollama: "Ollama",
  [INCLUDED_PROVIDER]: INCLUDED_LABEL,
};

const SANDBOX_NAME: Record<string, string> = {
  seatbelt: "macOS sandbox",
  bubblewrap: "Linux sandbox (bubblewrap)",
  landlock: "Linux sandbox (Landlock)",
  windows: "Windows sandbox",
};

const TIER_LABEL: Record<Complexity, string> = { easy: "Low", medium: "Medium", high: "High", max: "Max" };

/** The API's ranges, so the form never offers a value the server refuses. */
const LIMITS = {
  maxMinutes: { label: "Max minutes", min: 1, max: 480 },
  maxToolCalls: { label: "Max tool calls", min: 5, max: 500 },
  maxTurns: { label: "Max model turns", min: 3, max: 200 },
} as const;

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cx(
            "rounded px-2.5 py-1 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
            value === option.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Label({ children, tip }: { children: React.ReactNode; tip?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-ink/90">
      {children}
      {tip ? <InfoTip text={tip} /> : null}
    </div>
  );
}

/** Text with `command` spans shown as code. */
function WithCode({ text }: { text: string }) {
  return <>{text.split("`").map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>;
}

const MODE_HELP: Record<Mode, string> = {
  ask: "Asks before commands and file changes unless the folder is trusted. Outside the folder, a sandboxed run follows “Outside the work folder” below; anything more asks. Decision questions come to Needs me.",
  review: "Runs commands and edits inside the folder without asking. Asks only real decisions (an unclear requirement, a choice between approaches), with its recommended option marked. Outside the folder, a sandboxed run follows “Outside the work folder” below and anything more is refused.",
  unattended: "Nobody needs to be there. Runs inside the folder without asking, picks its recommended option at each decision, and lists every decision it made in the summary. Outside the folder, a sandboxed run follows “Outside the work folder” below and anything more is refused.",
};

const ENGINE_OPTION: Record<CodeEngine, string> = {
  "claude-code": "Claude Code (your sign-in)",
  codex: "Codex (your sign-in, CLI or ChatGPT app)",
  "cursor-agent": "Cursor agent (your sign-in)",
  "copilot-cli": "GitHub Copilot (your sign-in)",
  "grok-cli": "Grok Build (your sign-in)",
  opencode: "OpenCode (your sign-in)",
  "gemini-cli": "Gemini CLI (your Google sign-in)",
  antigravity: "Antigravity (your Google sign-in)",
};

/** What each agent is called where it is signed in, and the command that signs it in. */
const ENGINE_SIGN_IN: Record<CodeEngine, { program: string; login: string; short: string }> = {
  "claude-code": { program: "Claude Code", login: "claude auth login", short: "Claude Code" },
  codex: { program: "Codex", login: "codex login", short: "Codex" },
  "cursor-agent": { program: "Cursor's agent", login: "cursor-agent login", short: "Cursor" },
  "copilot-cli": { program: "Copilot CLI", login: "copilot login", short: "Copilot" },
  "grok-cli": { program: "Grok Build", login: "grok login", short: "Grok" },
  opencode: { program: "OpenCode", login: "opencode auth login", short: "OpenCode" },
  "gemini-cli": { program: "Gemini CLI", login: "gemini", short: "Gemini" },
  antigravity: { program: "Antigravity", login: "Sign in under Settings → Models", short: "Antigravity" },
};

const OUTSIDE_HELP = "What a sandboxed run may do in your other folders. Read only: it can read them (never keys or browser data) and asks before writing; with nobody to answer, a write is refused and the run carries on. Read and write: it can change them too. No access: it stays in the work folder. The default comes from Settings.";

/** Outside the work folder, for this sandboxed run. */
function OutsideFolder({ value, onChange }: { value: "none" | "read" | "read-write"; onChange: (value: "none" | "read" | "read-write") => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 pl-[22px] font-medium">
        Outside the work folder <InfoTip text={OUTSIDE_HELP} />
      </span>
      <Segmented
        value={value}
        onChange={onChange}
        options={[
          { id: "read", label: "Read only" },
          { id: "read-write", label: "Read and write" },
          { id: "none", label: "No access" },
        ]}
      />
    </div>
  );
}

/** The saved profiles as chips, with save, update, rename, default and delete. Max three. */
export function ProfileBar({
  profiles,
  saved,
  activeId,
  defaultId,
  modified,
  onPick,
  onSave,
  onRemove,
  onDefault,
  busy,
}: {
  profiles: RunProfile[];
  saved: RunProfile[];
  activeId: string;
  defaultId: string;
  modified: boolean;
  onPick: (profile: RunProfile) => void;
  onSave: (input: { id?: string; name: string }) => void;
  onRemove: (id: string) => void;
  onDefault: (id: string) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Keyed on which profile is open, not on the draft: selecting on every keystroke would replace each typed letter.
  const editingKey = editing ? (editing.id ?? "new") : null;
  useLayoutEffect(() => {
    if (!editingKey) return;
    input.current?.focus();
    input.current?.select();
  }, [editingKey]);
  const active = profiles.find((row) => row.id === activeId);
  const isSaved = saved.some((row) => row.id === activeId);
  return (
    <div className="space-y-1.5" data-testid="run-profiles">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[12px] font-medium text-muted">Profile</span>
        {profiles.map((profile) => {
          const isDefault = profile.id === defaultId;
          const canStar = saved.some((row) => row.id === profile.id);
          return (
            <span
              key={profile.id}
              className={cx(
                "group flex items-center rounded-full border text-[12.5px] transition-colors",
                profile.id === activeId ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:text-ink",
              )}
            >
              <button type="button" onClick={() => onPick(profile)} title={profileSummary(profile)} className={cx("flex items-center gap-1 rounded-l-full py-0.5 pl-2.5", canStar ? "pr-1" : "rounded-r-full pr-2.5")}>
                {!canStar && isDefault ? <Star size={11} className="fill-current text-accent" aria-label="Default" /> : null}
                {profile.name}
                {profile.id === activeId && modified ? <span className="text-faint">· modified</span> : null}
              </button>
              {canStar ? (
                <button
                  type="button"
                  className="grid h-full place-items-center rounded-r-full py-0.5 pl-0.5 pr-2 disabled:cursor-default"
                  aria-pressed={isDefault}
                  aria-label={isDefault ? `“${profile.name}” is the default profile` : `Make “${profile.name}” the default profile`}
                  title={isDefault ? "Default: Quick assign and the assistant use this profile" : "Make this the default"}
                  disabled={busy || isDefault}
                  onClick={() => onDefault(profile.id)}
                >
                  <Star size={11} className={isDefault ? "fill-current text-accent" : "text-faint opacity-50 transition-opacity group-hover:opacity-100"} />
                </button>
              ) : null}
            </span>
          );
        })}
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editing.name.trim()) return;
              onSave({ id: editing.id, name: editing.name.trim().slice(0, 40) });
              setEditing(null);
            }}
          >
            <input
              ref={input}
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), setEditing(null))}
              maxLength={40}
              placeholder="Profile name"
              aria-label="Profile name"
              className="field h-7 w-36 py-0 text-[12.5px]"
            />
            <button type="submit" className="btn h-7 px-2 text-[12px]" disabled={busy || !editing.name.trim()}>
              Save
            </button>
            <button type="button" className="btn-ghost h-7 px-1.5" onClick={() => setEditing(null)} aria-label="Cancel">
              <X size={13} />
            </button>
          </form>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            {isSaved && modified && active ? (
              <button type="button" className="btn-ghost h-7 px-2 text-[12px]" disabled={busy} onClick={() => onSave({ id: active.id, name: active.name })}>
                Update “{active.name}”
              </button>
            ) : null}
            {canAddProfile(saved) ? (
              <button type="button" className="btn-ghost h-7 px-2 text-[12px]" disabled={busy} onClick={() => setEditing({ name: "" })}>
                Save as profile
              </button>
            ) : null}
            {isSaved && active ? (
              <>
                <button type="button" className="btn-ghost h-7 px-1.5" title="Rename" aria-label="Rename profile" disabled={busy} onClick={() => setEditing({ id: active.id, name: active.name })}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="btn-ghost h-7 px-1.5" title="Delete profile" aria-label="Delete profile" disabled={busy} onClick={() => onRemove(active.id)}>
                  <Trash2 size={12} />
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
      {!canAddProfile(saved) && !editing ? <div className="text-[11.5px] text-faint">Three profiles saved. Update or rename one to change it.</div> : null}
    </div>
  );
}

type Blocker = { text: string; field: "task" | "run-on" | "place" | "branch" | "mode" | "pull-request" };

function folderProblem(folder: string, check: { ok: boolean; text: string } | null): string {
  if (check && !check.ok) return check.text;
  return folder.trim() ? "Checking the folder…" : "Choose the folder it works in.";
}

const EARLIER_STATUS: Record<string, string> = { succeeded: "done", failed: "failed", interrupted: "interrupted", cancelled: "stopped", blocked: "blocked" };

/** One earlier run in the Continue list: which task, how it ended (or that the new run waits for it), its branch and folder. */
export function earlierRunLabel(row: EarlierRun, taskId: string): string {
  const waiting = ["queued", "claimed", "running", "waiting_approval", "stopping"].includes(row.status);
  const where = row.folder ? row.folder.split(/[\\/]/).filter(Boolean).pop() ?? row.folder : "";
  return [
    row.taskId && row.taskId === taskId ? `${row.title} (this task)` : row.title,
    waiting ? "not finished yet, waits for it" : EARLIER_STATUS[row.status] ?? row.status,
    row.branch,
    where,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The first thing that keeps Assign from going ahead, in words, and the field to fix. Null when it can go. */
export function assignBlocker(form: {
  taskId: string;
  kind: Kind;
  serverRunner: boolean;
  device: { name: string; folders: number } | null;
  devices: number;
  place: Place;
  continueFrom: string;
  folder: string;
  folderCheck: { ok: boolean; text: string } | null;
  folderLabel: string;
  branchMode: "as-is" | "existing" | "new";
  branch: string;
  needsTrust: boolean;
  mode: Mode;
  unattendedNoSandbox: boolean;
  /** What keeps the run's pull request from going ahead (lib/pull-request), when it ends in one. */
  pullRequest?: Blocker | null;
}): Blocker | null {
  if (!form.taskId) return { text: "Choose a task first.", field: "task" };
  if (form.kind !== "code") return null;
  if (!form.serverRunner && !form.device) {
    return form.devices
      ? { text: "Choose the computer it runs on.", field: "run-on" }
      : { text: "Code runs on one of your computers. Pair one in Settings → Devices first.", field: "run-on" };
  }
  if (form.place === "continue" && !form.continueFrom) return { text: "Choose the earlier task to continue.", field: "place" };
  if (form.place === "folder" && form.device && !form.folderLabel) {
    return form.device.folders
      ? { text: `Choose a folder ${form.device.name} has shared.`, field: "place" }
      : { text: `${form.device.name} has not shared a folder yet. Pick “Its own checkout”, or share one there first.`, field: "place" };
  }
  if (form.place === "folder" && !form.device && !form.folderCheck?.ok) return { text: folderProblem(form.folder, form.folderCheck), field: "place" };
  if (form.pullRequest) return form.pullRequest;
  if (form.branchMode !== "as-is" && !form.branch.trim()) return { text: form.branchMode === "new" ? "Name the new branch." : "Name the branch to use.", field: "branch" };
  if (form.needsTrust) return { text: `${form.mode === "unattended" ? "Run unattended" : "Review only"} needs a folder you trust. Trust this folder, or choose Ask.`, field: "mode" };
  if (form.unattendedNoSandbox) return { text: "Run unattended needs an OS sandbox, and this computer has none yet. Choose Ask or Review only.", field: "mode" };
  return null;
}

export function AssignDialog({
  open,
  onClose,
  taskId: fixedTaskId,
  defaultKind,
}: {
  open: boolean;
  onClose: () => void;
  taskId?: string;
  defaultKind?: Kind;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const agentsState = useModuleState("workspace");
  const enabling = useMutation({
    mutationFn: async () => {
      await setFeature(client, "workspace", true);
      // Review of a code run lives in the code space.
      await setFeature(client, "code", true);
    },
    onSuccess: () => toast("Agents are on for this space.", { tone: "ok" }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const [taskId, setTaskId] = useState(fixedTaskId ?? "");
  const quickAssignment = useQuickAssign(() => undefined, onClose);
  const [kind, setKind] = usePersistentState<Kind>("ensemble.assign.kind", defaultKind ?? "research");
  const [modelChoice, setModelChoice] = usePersistentState("ensemble.assign.model", "");
  const [engine, setEngine] = usePersistentState<"ensemble" | CodeEngine>("ensemble.assign.engine", "ensemble");
  const [claudeModel, setClaudeModel] = useState("");
  // GitHub Copilot's context window; unset is the model's standard one.
  const [context, setContext] = useState<ContextTier | undefined>(undefined);
  // Opened in the agent's own app on this computer instead of run by Ensemble.
  const [inApp, setInApp] = useState(false);
  const [appTarget, setAppTarget] = usePersistentState<HandoffApp>("ensemble.assign.app", "claude");
  const [effort, setEffort] = useState<Effort>("default");
  const [instructions, setInstructions] = useState("");
  const [place, setPlace] = useState<Place>("fresh");
  const [repo, setRepo] = useState("");
  const [continueFrom, setContinueFrom] = useState("");
  const [folder, setFolder] = useState("");
  const [folderCheck, setFolderCheck] = useState<{ ok: boolean; text: string; git?: boolean } | null>(null);
  const [branchMode, setBranchMode] = useState<"as-is" | "existing" | "new">("as-is");
  const [branch, setBranch] = useState("");
  // "push" is No limits; "local" and "commit" are limits the person picks.
  const [delivery, setDelivery] = usePersistentState<"local" | "commit" | "push">("ensemble.assign.git", "push");
  // A code run that ends in a pull request Ensemble opens: its base (empty: the default branch) and what happens once it is open. Null: the git choice above.
  const [pullRequest, setPullRequest] = useState<{ base: string; merge: PullRequestMerge } | null>(null);
  const [prBranch, setPrBranch] = useState("");
  const [askFirst, setAskFirst] = useState(true);
  const [credentials, setCredentials] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [fast, setFast] = useState(false);
  const [network, setNetwork] = useState(true);
  // null follows Settings; a choice here is for this run only.
  const [outside, setOutside] = useState<"none" | "read" | "read-write" | null>(null);
  const [mode, setMode] = useState<Mode>("ask");
  const [trustChoice, setTrustChoice] = useState<"always" | "task" | "none">("none");
  const [markDone, setMarkDone] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [maxMinutes, setMaxMinutes] = useState<number | "">("");
  const [maxToolCalls, setMaxToolCalls] = useState<number | "">("");
  const [maxTurns, setMaxTurns] = useState<number | "">("");
  const [runOn, setRunOn] = useState("server");
  const [folderLabel, setFolderLabel] = useState("");
  const [profileId, setProfileId] = useState("");

  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: open && !fixedTaskId });
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId), enabled: open && Boolean(taskId) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const catalog = useQuery({ queryKey: ["model-catalog"], queryFn: api.models, enabled: open, staleTime: 5 * 60_000 });
  // This server's folders: refused on Ensemble on the web to anyone but its operator.
  const hostCode = useHostCode() === true;
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: open && kind === "code" && hostCode });
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, enabled: open });
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: open, refetchInterval: open ? 15_000 : false });
  const selectedDevice = (computers.data?.devices ?? []).find((device) => device.id === runOn) ?? null;
  // Earlier runs to continue: on the chosen computer (its folders are there), or on this server.
  const checkouts = useQuery({
    queryKey: ["checkouts", selectedDevice?.id ?? "server", taskId],
    queryFn: () => (selectedDevice ? api.earlierRuns(selectedDevice.id, taskId || undefined) : api.checkouts(taskId || undefined)),
    enabled: open && kind === "code" && place === "continue" && (selectedDevice !== null || hostCode),
  });
  const agentApps = useQuery({ queryKey: ["agent-apps"], queryFn: api.agentApps, enabled: open, staleTime: 60_000 });
  const apps = agentApps.data?.targets ?? [];
  const appMode = inApp && kind === "code" && !selectedDevice && apps.length > 0;
  const deviceAcceptsWeb = (selectedDevice?.capabilities as { acceptWebApprovals?: unknown } | null)?.acceptWebApprovals !== false;
  // In a space shared with you, the agent runs on your own computers only (they are the only ones listed).
  const access = useSpaceAccess();
  const serverRunner = !access.guest && (computers.data?.serverRunner ?? board.data?.serverRunner) !== false;
  useEffect(() => {
    if (!open || !computers.data) return;
    if ((!computers.data.serverRunner || access.guest) && runOn === "server") setRunOn(computers.data.devices[0]?.id ?? "server");
  }, [open, computers.data, runOn, access.guest]);
  // The chosen earlier run stays one of the listed ones (the list follows the computer); with none
  // chosen, this task's own latest run is, as carrying it on is the usual reason to continue.
  const earlier = checkouts.data?.checkouts;
  useEffect(() => {
    if (!earlier || place !== "continue") return;
    if (continueFrom && earlier.some((row) => row.jobId === continueFrom)) return;
    const own = taskId ? earlier.find((row) => row.taskId === taskId) : undefined;
    setContinueFrom(own?.jobId ?? "");
  }, [earlier, place, continueFrom, taskId]);
  // The coding agent's models, each with its own thinking levels and context windows, as the chosen computer listed them.
  const codeEngine: CodeEngine | null = open && kind === "code" && engine !== "ensemble" && !appMode ? engine : null;
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, enabled: codeEngine !== null, staleTime: 30_000 });
  const reportedAgent = codeEngine ? computerAgent(codeEngine, subscriptions.data, selectedDevice?.id ?? null, selectedDevice?.capabilities) : null;
  // Before a computer reports Claude Code, Ensemble's own table of its models stands in.
  const engineAgent = reportedAgent ?? (codeEngine === "claude-code" ? claudeFallback() : null);
  const agentModel = engineModel(engineAgent, claudeModel);
  const agentDefault = engineAgent?.models.find((row) => row.isDefault) ?? null;
  const agentWhere = selectedDevice ? computerName(selectedDevice.name) : desktopShell() ? "this computer" : "this server";
  const branchSource = place === "folder" && folderCheck?.ok && folderCheck.git ? folder : place === "fresh" && repo.startsWith("/") ? repo : "";
  const branches = useQuery({ queryKey: ["branches", branchSource], queryFn: () => api.branches(branchSource), enabled: open && Boolean(branchSource) });
  const folderKinds = selectedDevice ? sharedFolderKinds(selectedDevice.capabilities) : {};
  const prOn = kind === "code" && pullRequest !== null;
  const prNotices = prOn
    ? pullRequestNotices({
        computer: selectedDevice ? selectedDevice.name : null,
        capabilities: selectedDevice?.capabilities,
        place,
        repo,
        base: pullRequest.base,
        branch: prBranch,
      })
    : null;

  const orchestration = settings.data?.settings.orchestration;
  const savedProfiles = settings.data?.settings.runProfiles ?? [];
  const quick = useMemo(() => quickProfile(orchestration), [orchestration]);
  const profiles = profileChoices(savedProfiles, quick);
  const defaultChoice = defaultProfile(savedProfiles, settings.data?.settings.defaultRunProfileId, quick);
  const trustedFolders = useQuery({ queryKey: ["workspace-trust"], queryFn: api.trustedFolders, enabled: open && kind === "code" && hostCode });

  const fields: ProfileFields = {
    kind,
    deviceId: runOn === "server" ? null : runOn,
    engine: kind === "code" ? engine : "ensemble",
    model: kind === "code" && engine !== "ensemble" ? claudeModel : modelChoice,
    effort,
    context: kind === "code" && engine !== "ensemble" ? context : undefined,
    fast: kind === "code" && engine !== "ensemble" && fast ? true : undefined,
    branchMode: branchMode === "new" ? "new" : "as-is",
    delivery: prOn ? "commit" : delivery,
    askBeforePublish: askFirst,
    mode,
    sandbox,
    useCredentials: credentials,
    network: prOn ? true : network,
    markDone,
    maxMinutes: maxMinutes === "" ? null : maxMinutes,
    maxToolCalls: maxToolCalls === "" ? null : maxToolCalls,
    maxTurns: maxTurns === "" ? null : maxTurns,
    instructions,
    pullRequest: prOn ? { base: pullRequest.base.trim(), merge: pullRequest.merge } : null,
  };

  const applyProfile = (profile: RunProfile) => {
    setProfileId(profile.id);
    setKind(defaultKind && profile.id === defaultChoice.id ? defaultKind : profile.kind);
    if (profile.deviceId && (computers.data?.devices ?? []).some((device) => device.id === profile.deviceId)) setRunOn(profile.deviceId);
    setEngine(profile.engine ?? "ensemble");
    if (profile.engine && profile.engine !== "ensemble") setClaudeModel(profile.model);
    else setModelChoice(profile.model);
    setEffort(profile.effort);
    setContext(profile.engine && profile.engine !== "ensemble" && profile.context === "long_context" ? "long_context" : undefined);
    setBranchMode(profile.branchMode);
    setDelivery(profile.delivery);
    setAskFirst(profile.askBeforePublish);
    setMode(profile.mode);
    setSandbox(profile.sandbox);
    setFast(profile.fast === true);
    setCredentials(profile.useCredentials);
    setNetwork(profile.network);
    setOutside(null);
    setMarkDone(profile.markDone);
    setMaxMinutes(profile.maxMinutes ?? "");
    setMaxToolCalls(profile.maxToolCalls ?? "");
    setMaxTurns(profile.maxTurns ?? "");
    setInstructions(profile.instructions);
    setPullRequest(profile.kind === "code" && profile.pullRequest ? { base: profile.pullRequest.base, merge: profile.pullRequest.merge } : null);
    setPrBranch("");
  };

  // Each time the dialog opens: the task, then the default profile once settings are in.
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      appliedFor.current = null;
      return;
    }
    setTaskId(fixedTaskId ?? "");
    setFolderCheck(null);
    setTrustChoice("none");
  }, [open, fixedTaskId]);
  useEffect(() => {
    if (!open || !settings.data || appliedFor.current === "applied") return;
    appliedFor.current = "applied";
    applyProfile(defaultChoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.data]);

  const activeProfile = profiles.find((row) => row.id === profileId);
  const modified = activeProfile ? differs(activeProfile, fields) : false;

  const saveProfiles = useMutation({
    mutationFn: (patch: { runProfiles?: RunProfile[]; defaultRunProfileId?: string | null }) => api.saveSettings(patch),
    onSuccess: (result) => client.setQueryData(["settings"], result),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const saveProfile = ({ id, name }: { id?: string; name: string }) => {
    try {
      const profile: RunProfile = { ...fields, id: id ?? newProfileId(), name };
      const list = upsertProfile(savedProfiles, profile);
      saveProfiles.mutate(
        { runProfiles: list, ...(savedProfiles.length === 0 ? { defaultRunProfileId: profile.id } : {}) },
        { onSuccess: () => (setProfileId(profile.id), toast(id ? `Saved “${name}”.` : `Saved the profile “${name}”.`, { tone: "ok" })) },
      );
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };

  const complexity = (task.data?.task.complexity ?? "medium") as Complexity;
  const tier = settings.data?.settings.models[complexity];
  const chatProviders = (catalog.data?.providers ?? []).filter((row) => row.chat && row.available && row.models.length);
  const [provider, model] = modelChoice.includes("::") ? (modelChoice.split("::") as [string, string]) : ["", ""];

  const guard = useQuery({ queryKey: ["workspace-guard"], queryFn: api.workspaceGuard, enabled: open && kind === "code", staleTime: 5 * 60_000 });
  const strength = guard.data?.sandbox.strength ?? "strong";
  const osSandbox = guard.data?.sandbox.osSandbox ?? true;
  const askOnly = strength === "ask";
  const setupSandbox = useMutation({
    mutationFn: api.setupSandbox,
    onSuccess: (result) => {
      toast(result.message, { tone: result.ok ? "ok" : "error" });
      void client.invalidateQueries({ queryKey: ["workspace-guard"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  // What the chosen computer reported about its own sandbox (never a path).
  const deviceSandbox = (selectedDevice?.capabilities as { sandboxInfo?: { mechanism?: string; osSandbox?: boolean; setupNeeded?: boolean; reason?: string } } | null)?.sandboxInfo ?? null;

  const pick = useMutation({
    mutationFn: async () => {
      const native = await pickFolderNative("Choose the folder the agent may work in");
      if (native === undefined) return api.pickFolder();
      if (native === null) return undefined;
      const resolved = await api.resolveFolder(native);
      return { path: resolved.path, git: resolved.git };
    },
    onSuccess: (result) => {
      if (!result) return;
      setFolder(result.path);
      setFolderCheck({ ok: true, git: result.git, text: result.git ? "Git repository" : "Not a git repository, changes will not be reviewable in Code" });
    },
    onError: (error) => setFolderCheck({ ok: false, text: (error as Error).message }),
  });

  const checkFolder = async (value: string) => {
    if (!value.trim()) return setFolderCheck(null);
    try {
      const result = await api.resolveFolder(value);
      setFolder(result.path);
      setFolderCheck({ ok: true, git: result.git, text: result.git ? `Git repository${result.branch ? ` · on ${result.branch}` : ""}` : "Not a git repository, changes will not be reviewable in Code" });
    } catch (error) {
      setFolderCheck({ ok: false, text: (error as Error).message });
    }
  };
  // A typed path is checked once typing pauses, so Assign does not wait for the field to lose focus.
  const typedFolder = useRef("");
  useEffect(() => {
    if (!open || place !== "folder" || selectedDevice || !folder.trim() || folderCheck || typedFolder.current !== folder) return;
    const timer = window.setTimeout(() => void checkFolder(folder), 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place, selectedDevice, folder, folderCheck]);

  const ahead = (board.data?.queued.length ?? 0) + (board.data?.running.length ?? 0);
  const slots = board.data?.maxConcurrent ?? settings.data?.settings.orchestration.maxConcurrentJobs ?? 3;
  const startsNow = (board.data?.running.length ?? 0) < slots && !board.data?.paused;

  // The Ensemble workspace is always trusted. A folder outside it is trusted by a saved rule or the choice below.
  const root = board.data?.root ?? "";
  const underRoot = (path: string) => Boolean(root) && (path === root || path.startsWith(`${root}/`));
  const savedTrust = (path: string) => (trustedFolders.data?.folders ?? []).some((row) => path === row.path || path.startsWith(`${row.path}/`));
  const continueFolder = (earlier ?? []).find((row) => row.jobId === continueFrom)?.folder ?? "";
  const folderTrusted =
    selectedDevice !== null ||
    place === "fresh" ||
    (place === "continue" && (!continueFolder || underRoot(continueFolder) || savedTrust(continueFolder))) ||
    (place === "folder" && (trustChoice !== "none" || (Boolean(folderCheck?.ok) && savedTrust(folder))));
  const needsTrust = kind === "code" && mode !== "ask" && !folderTrusted;
  const outsideAccess = outside ?? orchestration?.outsideAccess ?? "read";
  const unattendedNoSandbox = kind === "code" && mode === "unattended" && askOnly && !selectedDevice;
  const blocker = assignBlocker({
    taskId,
    kind,
    serverRunner,
    device: selectedDevice ? { name: computerName(selectedDevice.name), folders: selectedDevice.folders.length } : null,
    devices: computers.data?.devices.length ?? 0,
    place,
    continueFrom,
    folder,
    folderCheck,
    folderLabel,
    // The pull request's branch name is optional (pullRequestNotices checks it).
    branchMode: prOn ? "as-is" : branchMode,
    branch,
    needsTrust,
    mode,
    unattendedNoSandbox,
    pullRequest: prNotices ? pullRequestProblem(prNotices) : null,
  });
  const invalid = Boolean(blocker);

  const limitValue = (value: number | "", key: keyof typeof LIMITS) => (value === "" ? undefined : Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, value)));

  const assign = useMutation({
    mutationFn: () => {
      const claude = kind === "code" && engine !== "ensemble";
      const input: AssignInput = {
        taskId,
        kind,
        instructions,
        ...(claude ? engineAssign(engine, { model: claudeModel, effort, context, fast }, reportedAgent ? agentModel : undefined) : model ? { provider, model } : {}),
        ...(effort !== "default" && !claude ? { reasoningEffort: effort } : {}),
        markDone,
        maxMinutes: limitValue(maxMinutes, "maxMinutes"),
        maxToolCalls: limitValue(maxToolCalls, "maxToolCalls"),
        maxTurns: limitValue(maxTurns, "maxTurns"),
        network,
      };
      if (kind === "code") {
        Object.assign(input, {
          mode,
          // A computer without a sandbox would refuse a sandboxed run; say so here instead (below), and run it directly.
          sandbox: selectedDevice ? sandbox && deviceSandbox?.osSandbox !== false : sandbox && osSandbox,
          delivery: prOn ? "commit" : delivery,
          askBeforePublish: mode === "unattended" ? false : askFirst,
          // A pull request's branch is new, made from its base; empty: Ensemble names it.
          branchMode: prOn ? (prBranch.trim() ? "new" : "as-is") : branchMode,
          branch: prOn ? prBranch.trim() || undefined : branchMode === "as-is" ? undefined : branch.trim(),
          ...(prOn ? { pullRequest: { base: pullRequest.base.trim(), merge: pullRequest.merge }, network: true } : {}),
          ...(place === "fresh" && repo.trim() ? { repoUrl: repo.trim() } : {}),
          ...(place === "continue" ? { continueFromJobId: continueFrom } : {}),
          ...(outside ? { outsideAccess: outside } : {}),
        });
        if (selectedDevice) {
          Object.assign(input, { useCredentials: false, ...(place === "folder" ? { folderLabel } : {}) });
        } else {
          Object.assign(input, { useCredentials: credentials, ...(place === "folder" ? { folder, trust: trustChoice } : {}) });
        }
      }
      if (selectedDevice) input.deviceId = selectedDevice.id;
      return api.assign(input);
    },
    onSuccess: () => {
      toast(
        selectedDevice
          ? `Queued for ${selectedDevice.name}. If it is asleep or Ensemble is not running there, it starts when it is back.`
          : startsNow
            ? "The agent started. Follow it in the top bar or Workspace."
            : "Queued. It starts when a slot frees up.",
        { tone: "ok" },
      );
      void client.invalidateQueries();
      onClose();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const chosenApp: HandoffApp = apps.some((target) => target.id === appTarget) ? appTarget : apps[0]?.id ?? "claude";
  const chosen = apps.find((target) => target.id === chosenApp);
  // An app works on a folder: a folder here, or an earlier task's. Ensemble does not clone for it.
  const handoffBlocker: Blocker | null = !taskId
    ? { text: "Choose a task first.", field: "task" }
    : place === "folder" && !folderCheck?.ok
      ? { text: folderProblem(folder, folderCheck), field: "place" }
      : place === "continue" && !continueFrom
        ? { text: "Choose the earlier task to continue.", field: "place" }
        : place === "fresh" && repo.trim()
          ? { text: "An app does not clone. Clear the repository, or choose its folder.", field: "place" }
          : null;
  const handoff = useMutation({
    mutationFn: () =>
      api.handoff({
        taskId,
        app: chosenApp,
        instructions,
        ...(place === "folder" ? { folder } : place === "continue" ? { continueFromJobId: continueFrom } : {}),
      }),
    onSuccess: (result) => {
      toast(
        result.opened
          ? chosen?.terminal
            ? `Started ${chosen.name}. Its prompts also come to Needs me.`
            : `Opened ${chosen?.name ?? "the app"} with the task. Press Send there; its prompts also come to Needs me.`
          : `Could not open ${chosen?.name ?? "the app"}. Open it on ${result.folder} and paste the task (copied).`,
        { tone: result.opened ? "ok" : "error" },
      );
      if (!result.opened) void navigator.clipboard?.writeText(result.prompt).catch(() => undefined);
      void client.invalidateQueries();
      onClose();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const body = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState<string | null>(null);
  useEffect(() => {
    if (!attention) return;
    const timer = window.setTimeout(() => setAttention(null), 1600);
    return () => window.clearTimeout(timer);
  }, [attention]);
  /** Assign pressed while something is missing: bring that field into view and focus it. */
  const reveal = (reason: Blocker) => {
    const field = body.current?.querySelector<HTMLElement>(`[data-assign-field="${reason.field}"]`);
    field?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    field?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea, button:not([disabled])")?.focus({ preventScroll: true });
    setAttention(reason.field);
  };
  const attentionProps = (field: string) => ({ "data-assign-field": field, "data-attention": attention === field ? "true" : undefined });

  const summary = useMemo(() => {
    if (kind === "research") return "Reads the web and papers, writes into the task page. Nothing runs on your computer.";
    const where = place === "folder" ? (selectedDevice ? `${folderLabel || "a folder"} on ${selectedDevice.name}` : "your folder") : place === "continue" ? "the earlier task's folder" : "its own checkout";
    const git = prOn ? `may commit, then a pull request into ${pullRequest.base.trim() || "the default branch"}` : delivery === "local" ? "no commit or push" : delivery === "commit" ? "may commit, no push" : "no git limits";
    const asks = (prOn || delivery !== "local") && askFirst && mode !== "unattended" ? " (asks before each commit)" : "";
    const modeLabel = mode === "review" ? " · Review only" : mode === "unattended" ? " · Run unattended" : "";
    const box = selectedDevice
      ? `On ${selectedDevice.name}${deviceSandbox?.osSandbox === false ? ", no sandbox" : sandbox ? ", sandboxed" : ", unsandboxed"}`
      : !osSandbox
        ? "No sandbox here"
        : sandbox
          ? "Sandboxed"
          : "Unsandboxed";
    const who = engine === "ensemble" ? "" : `${ENGINE_LABELS[engine]} · `;
    return `${who}${box} · works in ${where}${modeLabel} · ${git}${asks}${credentials && !selectedDevice ? " · git sign-in stays in the app" : ""}`;
  }, [kind, place, delivery, sandbox, askFirst, credentials, mode, osSandbox, selectedDevice, folderLabel, engine, deviceSandbox, prOn, pullRequest]);

  const candidates = (tasks.data?.tasks ?? []).filter((row) => !["done", "dropped"].includes(row.status));
  const trustTip = selectedDevice ? undefined : "Trust this folder first. Review only and Run unattended run commands without asking.";

  // A space whose template leaves agents out: say so, and turn them on here, instead of a refused request.
  if (open && agentsState === false) {
    return (
      <Dialog open={open} onClose={onClose} title="Turn on agents for this space?" width={520}>
        <div className="space-y-3 text-[13.5px]">
          <p>
            This space was set up from a template without agents. Turning them on adds <span className="font-medium">Workspace</span> (agent runs, their questions and
            logs) and <span className="font-medium">Code review</span> to this space. Your tasks and pages stay as they are, and you can turn them off again in Settings → Account → Features.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Not now
            </button>
            <button type="button" className="btn-primary" disabled={enabling.isPending} onClick={() => enabling.mutate()}>
              {enabling.isPending ? <Spinner size={12} /> : null} Turn on agents
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Assign to agent" width={640}>
      <div ref={body} className="space-y-5 text-[13px]">
        {fixedTaskId ? (
          <div className="-mt-1 truncate text-[14px] font-semibold">{task.data?.task.title ?? "…"}</div>
        ) : (
          <select {...attentionProps("task")} aria-label="Task" value={taskId} onChange={(event) => setTaskId(event.target.value)} className="field w-full">
            <option value="">Choose a task…</option>
            {candidates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        )}

        <ProfileBar
          profiles={profiles}
          saved={savedProfiles}
          activeId={profileId}
          defaultId={defaultChoice.id}
          modified={modified}
          busy={saveProfiles.isPending}
          onPick={applyProfile}
          onSave={saveProfile}
          onRemove={(id) => {
            const list = removeProfile(savedProfiles, id);
            saveProfiles.mutate({ runProfiles: list, ...(settings.data?.settings.defaultRunProfileId === id ? { defaultRunProfileId: list[0]?.id ?? null } : {}) });
            setProfileId("");
          }}
          onDefault={(id) => saveProfiles.mutate({ defaultRunProfileId: id }, { onSuccess: () => toast("This is your default profile now: Quick assign and the assistant use it.", { tone: "ok" }) })}
        />

        <div className="grid grid-cols-2 gap-2">
          {([
            { id: "research", icon: FileText, title: "Research & writing", text: "Searches papers and the web. Writes the result into the task page." },
            { id: "code", icon: Code2, title: "Code on your computer", text: "Works in a folder: clone, run, fix, test, and commit if you allow it." },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setKind(option.id)}
              className={cx(
                "rounded-lg border p-3 text-left transition-colors",
                kind === option.id ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong",
              )}
            >
              <div className="flex items-center gap-2 font-semibold">
                <option.icon size={15} className={kind === option.id ? "text-accent" : "text-muted"} />
                {option.title}
              </div>
              <div className="mt-1 text-[12px] leading-4 text-muted">{option.text}</div>
            </button>
          ))}
        </div>

        <div {...attentionProps("run-on")}>
          <Label tip="A task for a computer waits until Ensemble is running there. It does not run on the server instead.">Run on</Label>
          <div className="space-y-1.5">
            {serverRunner ? (
              <button type="button" onClick={() => setRunOn("server")} className={cx("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", runOn === "server" ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong")}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="font-medium">{desktopShell() ? "This computer" : "This server"}</span>
              </button>
            ) : null}
            {(computers.data?.devices ?? []).map((device) => (
              <button key={device.id} type="button" onClick={() => { setRunOn(device.id); setFolderLabel(""); }} className={cx("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", runOn === device.id ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong")}>
                <Monitor size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium">{device.name}</span>
                <span className="shrink-0 text-[12px] text-muted">{device.lastSeenAt ? `last contact ${new Date(device.lastSeenAt).toLocaleString()}` : "Not seen yet"}</span>
              </button>
            ))}
            {!serverRunner && !(computers.data?.devices.length) ? <div className="text-[12.5px] text-muted">Add a computer with the Ensemble CLI in Settings → Devices, or pair the desktop app. Code tasks run there.</div> : null}
          </div>
          {access.guest ? (
            <p className="mt-2 rounded-md bg-panel px-2.5 py-2 text-[12px] leading-[18px] text-muted">
              This is {access.owner ?? "someone"}'s space, so the agent runs on one of your computers. They see that it runs on your computer, never which one,
              and they can follow its log. Only you can answer its questions or stop it.
            </p>
          ) : null}
        </div>

        {kind === "code" ? (
          <div>
            <Label tip="Ensemble's agent calls a model with your key. Claude Code, Codex, Cursor and GitHub Copilot run your own copy on the computer, signed in with your own account (Codex from the CLI or the ChatGPT app, Cursor from its `cursor-agent`, GitHub Copilot from its `copilot` CLI); Ensemble never sees that sign-in. Either way the same mode, trust, sandbox and git rules apply, and their questions come to Needs me. In its own app opens the task in the Claude app, Codex, Cursor or VS Code for you to send.">
              Who does the work
            </Label>
            <select
              aria-label="Who does the work"
              className="field w-full"
              value={appMode ? "app" : engine}
              onChange={(event) => {
                const value = event.target.value as typeof engine | "app";
                setInApp(value === "app");
                if (value === "app") return;
                // Model names, thinking levels and context windows are each engine's own.
                if (value !== engine) {
                  setClaudeModel("");
                  setEffort("default");
                  setContext(undefined);
                  setFast(false);
                }
                setEngine(value);
              }}
            >
              <option value="ensemble">Ensemble agent (a model with your key)</option>
              {CODE_ENGINES.map((id) => (
                <option key={id} value={id}>
                  {ENGINE_OPTION[id]}
                </option>
              ))}
              {!selectedDevice && apps.length ? <option value="app">In its own app or a terminal</option> : null}
            </select>
            {appMode ? (
              <div className="mt-2 space-y-1.5" data-testid="assign-in-app">
                <select aria-label="Open it in" className="field w-full" value={chosenApp} onChange={(event) => setAppTarget(event.target.value as HandoffApp)}>
                  {apps.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
                </select>
                <div className="text-[12px] text-muted">
                  {chosen?.terminal
                    ? `Ensemble opens a terminal on the folder below and starts ${chosen.name.replace(/ in a terminal$/, "")} with this task; it begins at once.`
                    : `Ensemble opens ${chosen?.name ?? "the app"} on the folder below with this task written in; press Send there.`}{" "}
                  Its permission prompts and questions also come to Needs me, and you can answer in either place. It works with its own settings and sign-in: the mode, sandbox and git choices here do not apply.
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {appMode ? null : codeEngine ? (
          <div className="space-y-3" data-testid="assign-engine-model">
            <div>
              <Label tip={`${ENGINE_LABELS[codeEngine]}'s models on ${agentWhere}, as it lists them, each with its own thinking levels and context windows. ${ENGINE_SIGN_IN[codeEngine].short} default uses the model set in ${ENGINE_LABELS[codeEngine]} (for Claude, your plan's).`}>Model</Label>
              {engineAgent?.models.some((row) => row.id !== "default") ? (
                <select
                  aria-label={`${ENGINE_SIGN_IN[codeEngine].short} model`}
                  value={claudeModel}
                  onChange={(event) => {
                    const next = event.target.value;
                    setClaudeModel(next);
                    const nextModel = engineModel(engineAgent, next);
                    const fitted = fitEngineChoice(nextModel, effort, context);
                    setEffort(fitted.effort);
                    setContext(fitted.context);
                    if (!nextModel.fast) setFast(false);
                  }}
                  className="field w-full"
                >
                  <option value="">
                    {ENGINE_SIGN_IN[codeEngine].short} default{agentDefault && agentDefault.id !== "default" ? ` (${agentDefault.label})` : ""}
                  </option>
                  {engineAgent.models
                    .filter((row) => row.id !== "default")
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.label}
                      </option>
                    ))}
                  {claudeModel && !engineAgent.models.some((row) => row.id === claudeModel || row.aliases?.includes(claudeModel)) ? <option value={claudeModel}>{claudeModel}</option> : null}
                </select>
              ) : (
                <input aria-label={`${ENGINE_SIGN_IN[codeEngine].short} model`} value={claudeModel} onChange={(event) => setClaudeModel(event.target.value)} placeholder={`${ENGINE_LABELS[codeEngine]} default`} className="field w-full font-mono text-[12.5px]" />
              )}
              {modelFacts(agentModel.model) ? <div className="mt-1 text-[12px] text-muted" data-testid="engine-model-facts">{modelFacts(agentModel.model)}</div> : null}
            </div>
            {agentModel.efforts.length || agentModel.contexts.length ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {agentModel.efforts.length ? (
                  <div>
                    <Label tip={`The thinking levels ${ENGINE_LABELS[codeEngine]} lists for this model. Default uses the model's own level.`}>Thinking</Label>
                    <select aria-label={`${ENGINE_SIGN_IN[codeEngine].short} thinking`} value={(agentModel.efforts as string[]).includes(effort) ? effort : "default"} onChange={(event) => setEffort(event.target.value as Effort)} className="field w-full">
                      <option value="default">Default{agentModel.defaultEffort ? ` (${effortName(agentModel.defaultEffort)})` : ""}</option>
                      {agentModel.efforts.map((level) => (
                        <option key={level} value={level}>
                          {effortName(level)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {agentModel.contexts.length ? (
                  <div>
                    <Label tip="How much of the work the model can hold at once. Standard is the model's usual size.">Context window</Label>
                    <select aria-label="Context window" value={context ?? "default"} onChange={(event) => setContext(event.target.value === "long_context" ? "long_context" : undefined)} className="field w-full">
                      {agentModel.contexts.map((row) => (
                        <option key={row.id} value={row.id}>
                          {contextChoice(row)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            ) : null}
            {agentModel.fast ? (
              <div className="flex items-center justify-between gap-3" data-testid="engine-fast">
                <Label tip="Faster output from the same model. It uses more of your plan's usage.">Fast mode</Label>
                <Toggle checked={fast} onChange={setFast} label="Fast mode" />
              </div>
            ) : null}
            {sandbox && !engineSandboxes(codeEngine, selectedDevice?.platform ?? (typeof navigator === "undefined" ? null : navigator.platform)) ? (
              <p className="rounded-md bg-panel px-2.5 py-2 text-[12px] leading-[18px] text-warn" role="status" data-testid="engine-no-sandbox">
                {ENGINE_LABELS[codeEngine]} has no OS sandbox Ensemble can turn on there, so a sandboxed run stops. Turn Sandbox off below to run it: Ensemble still judges every command, edit, outside read and fetch it asks to make.
              </p>
            ) : null}
            {selectedDevice && !computerRuns(codeEngine, selectedDevice.capabilities) ? (
              <p className="rounded-md bg-panel px-2.5 py-2 text-[12px] leading-[18px] text-warn" role="status">
                Ensemble on {agentWhere} is too old to run {ENGINE_LABELS[codeEngine]}. Update it there (<code>ensemble update</code>, or the desktop app&apos;s update), then assign.
              </p>
            ) : reportedAgent?.signedIn === false ? (
              <p className="rounded-md bg-panel px-2.5 py-2 text-[12px] leading-[18px] text-warn" role="status" data-testid="engine-signed-out">
                {ENGINE_SIGN_IN[codeEngine].program} is not signed in on {agentWhere}: run <code>{ENGINE_SIGN_IN[codeEngine].login}</code> there or press Sign in under Settings → Models.
              </p>
            ) : reportedAgent?.problem ? (
              <p className="text-[12px] leading-[18px] text-muted" role="status" data-testid="engine-problem">
                {reportedAgent.problem}
              </p>
            ) : null}
          </div>
        ) : (
        <div className="space-y-3">
          <div>
            <Label tip="By default the task's complexity picks the model from Settings → Models. Pick another here for this attempt only.">Model</Label>
            <select
              value={modelChoice}
              onChange={(event) => {
                const next = event.target.value;
                setModelChoice(next);
                const [nextProvider, nextModel] = next.includes("::") ? (next.split("::") as [string, string]) : [tier?.provider ?? "", tier?.model ?? ""];
                const meta = (catalog.data?.providers ?? []).find((row) => row.provider === nextProvider)?.meta?.[nextModel];
                setEffort((current) => effortFor(nextProvider, nextModel, meta, current) as Effort);
              }}
              className="field w-full"
            >
              <option value="">
                Task tier: {TIER_LABEL[complexity]} · {tier ? `${PROVIDER_LABEL[tier.provider] ?? tier.provider} ${tierModelName(tier.provider, tier.model)}` : "…"}
              </option>
              {chatProviders.map((row) => (
                <optgroup key={row.provider} label={PROVIDER_LABEL[row.provider] ?? row.provider}>
                  {row.cheapest && row.models.includes(row.cheapest) ? (
                    <option value={`${row.provider}::${row.cheapest}`}>{tierModelName(row.provider, row.cheapest)} · cheapest</option>
                  ) : null}
                  {row.models
                    .filter((name) => name !== row.cheapest)
                    .slice(0, 40)
                    .map((name) => (
                      <option key={name} value={`${row.provider}::${name}`}>
                        {tierModelName(row.provider, name)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <Label tip="The levels this model takes, as its provider lists or documents them. Default uses the tier's level in Settings → Models, or the model's own default for a model picked here.">Thinking</Label>
            <ThinkingPicker
              label="Thinking"
              provider={model ? provider : (tier?.provider ?? "")}
              providerLabel={PROVIDER_LABEL[model ? provider : (tier?.provider ?? "")] ?? (model ? provider : (tier?.provider ?? ""))}
              model={model || (tier?.model ?? "")}
              meta={(catalog.data?.providers ?? []).find((row) => row.provider === (model ? provider : tier?.provider))?.meta?.[model || (tier?.model ?? "")] ?? null}
              value={effort}
              onChange={(value) => setEffort(value as Effort)}
            />
          </div>
        </div>
        )}

        {kind === "code" ? (
          <>
            <div {...attentionProps("place")}>
              <Label>Where it works</Label>
              <Segmented
                value={place}
                onChange={setPlace}
                options={[
                  { id: "fresh", label: "Its own checkout" },
                  { id: "continue", label: "Continue an earlier task" },
                  { id: "folder", label: folderPlace(selectedDevice?.name) },
                ]}
              />
              {appMode && place === "fresh" ? (
                <div className="mt-1 text-[12px] text-muted">A new empty folder in your Ensemble workspace. For a repository, pick its folder or an earlier task: Ensemble does not clone for an app.</div>
              ) : null}
              <div className="mt-2">
                {place === "fresh" ? (
                  <>
                    <div className="flex gap-2">
                      <input
                        list="assign-repos"
                        aria-label="Repository"
                        value={repo}
                        onChange={(event) => setRepo(event.target.value)}
                        placeholder="https://github.com/owner/repo, owner/repo, or leave empty for an empty folder"
                        className="field min-w-0 flex-1"
                      />
                      <PickGitHubRepo onPick={setRepo} />
                    </div>
                    <datalist id="assign-repos">
                      {(repos.data?.repos ?? []).map((path) => (
                        <option key={path} value={path} />
                      ))}
                    </datalist>
                    <div className="mt-1 text-[12px] text-muted">{freshCloneHint(selectedDevice?.name, board.data?.root)}</div>
                  </>
                ) : place === "continue" ? (
                  <>
                    <select
                      aria-label="Earlier task"
                      value={continueFrom}
                      onChange={(event) => setContinueFrom(event.target.value)}
                      className="field w-full"
                      disabled={!earlier?.length}
                    >
                      <option value="">
                        {checkouts.isLoading
                          ? "Loading earlier tasks…"
                          : checkouts.isError
                            ? "Could not load earlier tasks"
                            : earlier?.length
                              ? "Choose an earlier task…"
                              : `No earlier code task ${selectedDevice ? `on ${computerName(selectedDevice.name)}` : "here"} to continue`}
                      </option>
                      {(earlier ?? []).map((row) => (
                        <option key={row.jobId} value={row.jobId}>
                          {earlierRunLabel(row, taskId)}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[12px] text-muted">
                      {checkouts.isError
                        ? (checkouts.error as Error).message
                        : selectedDevice
                          ? `Same folder on ${computerName(selectedDevice.name)}, uncommitted work included. Chain steps like change → analyse → commit; each waits for the one before. Only tasks that ran there are listed.`
                          : "Same folder, uncommitted work included. Chain steps like change → analyse → commit; each waits for the one before."}
                    </div>
                  </>
                ) : selectedDevice ? (
                  <>
                    <select aria-label="Shared folder" value={folderLabel} onChange={(event) => setFolderLabel(event.target.value)} className="field w-full" disabled={!selectedDevice.folders.length}>
                      <option value="">{selectedDevice.folders.length ? `Choose a folder ${computerName(selectedDevice?.name)} has shared…` : `${computerName(selectedDevice?.name)} has not shared a folder yet`}</option>
                      {selectedDevice.folders.map((label) => (
                        <option key={label} value={label}>{label}{folderKinds[label] === "repo" ? " · repository" : ""}</option>
                      ))}
                    </select>
                    <div className="mt-1 text-[12px] text-muted">
                      {selectedDevice.folders.length
                        ? `Only names ${computerName(selectedDevice?.name)} already shared (\`ensemble folders add\`). A path typed here is refused.`
                        : `To work in a folder there, share it on ${computerName(selectedDevice?.name)} with \`ensemble folders add <path>\`. Or pick “Its own checkout” above.`}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <input
                        value={folder}
                        onChange={(event) => {
                          typedFolder.current = event.target.value;
                          setFolder(event.target.value);
                          setFolderCheck(null);
                        }}
                        onBlur={(event) => void checkFolder(event.target.value)}
                        placeholder="/Users/you/projects/my-app"
                        className="field min-w-0 flex-1 font-mono text-[12.5px]"
                      />
                      <button type="button" className="btn" onClick={() => pick.mutate()} disabled={pick.isPending}>
                        {pick.isPending ? <Spinner size={12} /> : <FolderOpen size={13} />} Choose…
                      </button>
                    </div>
                    {folderCheck ? (
                      <div className={cx("mt-1 flex items-center gap-1 text-[12px]", folderCheck.ok ? "text-ok" : "text-danger")}>
                        {folderCheck.ok ? <Check size={12} /> : <X size={12} />} {folderCheck.text}
                      </div>
                    ) : (
                      <div className="mt-1 text-[12px] text-muted">Worked in place, nothing cloned. The agent cannot leave this folder. System folders, your home folder and Ensemble itself are refused.</div>
                    )}
                  </>
                )}
              </div>
            </div>

            {appMode ? null : (
            <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div {...attentionProps("branch")}>
                {prOn ? (
                  <>
                    <Label tip="The branch Ensemble pushes and opens the pull request from, used exactly as named. Leave it empty and Ensemble names one.">
                      <GitBranch size={13} /> Branch name
                    </Label>
                    <input aria-label="Branch name" value={prBranch} onChange={(event) => setPrBranch(event.target.value)} placeholder="Ensemble names it" className="field w-full font-mono text-[12.5px]" />
                    {prNotices?.branch ? (
                      <div className="mt-1 text-[12px] text-danger" role="alert" data-testid="pull-request-branch-notice">{prNotices.branch}</div>
                    ) : (
                      <div className="mt-1 text-[12px] text-muted">A new branch, made from the branch it goes into.</div>
                    )}
                  </>
                ) : (
                  <>
                    <Label tip="As is: the branch checked out now. Existing: a branch that already exists. New: a branch created first.">
                      <GitBranch size={13} /> Branch
                    </Label>
                    <Segmented
                      value={branchMode}
                      onChange={setBranchMode}
                      options={[
                        { id: "as-is", label: "As is" },
                        { id: "existing", label: "Existing" },
                        { id: "new", label: "New" },
                      ]}
                    />
                    {branchMode !== "as-is" ? (
                      <>
                        <input list="assign-branches" aria-label="Branch name" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={branchMode === "new" ? "ensemble/fix-tests" : "feature/x"} className="field mt-2 w-full font-mono text-[12.5px]" />
                        <datalist id="assign-branches">
                          {(branches.data?.branches ?? []).map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </>
                    ) : null}
                  </>
                )}
              </div>
              <div>
                <Label tip="Local only and Commit are limits you choose. No limits: the agent commits, pushes any branch and opens or merges pull requests as the task asks, with this computer's git and GitHub sign-in; in Ask mode these wait for you unless the folder is trusted. Pull request: when the run ends, Ensemble pushes its branch, opens the pull request into the branch you name (empty: the default branch) and merges it as you choose.">Git permissions</Label>
                <Segmented
                  value={prOn ? "pr" : delivery}
                  onChange={(value) => {
                    if (value === "pr") {
                      setPullRequest((current) => current ?? { base: "", merge: "ask" });
                      return;
                    }
                    setPullRequest(null);
                    setDelivery(value);
                  }}
                  options={[{ id: "local", label: "Local only" }, { id: "commit", label: "Commit" }, { id: "push", label: "No limits" }, { id: "pr", label: "Pull request" }]}
                />
                {prOn || delivery !== "local" ? (
                  <label className={cx("mt-2 flex items-center gap-2 text-[12.5px]", mode === "unattended" ? "text-faint" : "text-muted")} title={mode === "unattended" ? "Nobody approves in an unattended run." : undefined}>
                    <input type="checkbox" checked={askFirst && mode !== "unattended"} disabled={mode === "unattended"} onChange={(event) => setAskFirst(event.target.checked)} />
                    Ask me on Needs me before each commit
                  </label>
                ) : null}
              </div>
            </div>

            {prOn ? (
              <div className="space-y-2 rounded-lg border border-line bg-raised p-3" data-testid="assign-pull-request" {...attentionProps("pull-request")}>
                <div className="flex items-center gap-1.5 font-medium">
                  <GitPullRequest size={14} className="text-muted" /> Pull request
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label tip="The branch the pull request goes into: any branch. Leave it empty for the repository's default branch.">Into branch</Label>
                    <input aria-label="Into branch" value={pullRequest.base} onChange={(event) => setPullRequest({ ...pullRequest, base: event.target.value })} placeholder="default branch" className="field w-full font-mono text-[12.5px]" />
                  </div>
                  <div>
                    <Label tip="Ask me before merging: Ensemble opens it, then asks on Needs me, and merges once its checks pass. Merge when checks pass: no question. Leave it open: you merge it on GitHub.">After opening</Label>
                    <select aria-label="After opening" value={pullRequest.merge} onChange={(event) => setPullRequest({ ...pullRequest, merge: event.target.value as PullRequestMerge })} className="field w-full">
                      {MERGE_CHOICES.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="text-[12px] text-muted">The agent may commit. When the run ends, Ensemble pushes its branch, opens the pull request and merges it as you choose.</div>
                {[prNotices?.tooOld, prNotices?.place, prNotices?.base].filter((text): text is string => Boolean(text)).map((text) => (
                  <div key={text} className="flex items-start gap-1.5 text-[12px] text-warn" role="status" data-pull-request-notice>
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <WithCode text={text} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="space-y-2 rounded-lg border border-line bg-raised p-3" {...attentionProps("mode")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Mode</span>
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: "ask", label: "Ask" },
                    { id: "review", label: "Review only", disabled: !folderTrusted, title: !folderTrusted ? trustTip : undefined },
                    { id: "unattended", label: "Run unattended", disabled: !folderTrusted || (askOnly && !selectedDevice), title: !folderTrusted ? trustTip : askOnly && !selectedDevice ? "Run unattended needs an OS sandbox." : undefined },
                  ]}
                />
              </div>
              <div className="text-[12px] text-muted" data-testid="assign-mode-help">
                {MODE_HELP[mode]}
                {selectedDevice && mode !== "ask" ? ` ${selectedDevice.name} has to trust the folder; if it does not, the run asks you to trust it first.` : ""}
              </div>
              {selectedDevice ? (
                <>
                  {!deviceAcceptsWeb ? (
                    <div className="flex items-start gap-1.5 text-[12px] text-warn">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      {selectedDevice.name} accepts only narrowing settings from here: it asks before each commit, uses its own internet setting, and runs in Ask mode. Change that on {selectedDevice.name}.
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <ShieldCheck size={14} className={deviceSandbox?.osSandbox === false ? "text-warn" : sandbox ? "text-ok" : "text-warn"} />
                      <span className="font-medium">Sandbox</span>
                      <span className="truncate text-[12px] text-muted">
                        {deviceSandbox?.osSandbox === false
                          ? deviceSandbox.setupNeeded
                            ? `Not set up on ${selectedDevice.name}: run \`ensemble sandbox setup\` there once`
                            : `None on ${selectedDevice.name}`
                          : deviceSandbox?.mechanism
                            ? SANDBOX_NAME[deviceSandbox.mechanism] ?? deviceSandbox.mechanism
                            : ""}
                      </span>
                    </div>
                    {deviceSandbox?.osSandbox === false ? (
                      <span className="text-[12px] text-muted">Runs directly</span>
                    ) : deviceAcceptsWeb ? (
                      <Toggle checked={sandbox} onChange={setSandbox} label="Sandbox" />
                    ) : (
                      <span className="text-[12px] text-muted">On ({selectedDevice.name} decides)</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Lock size={14} className="text-muted" />
                      <span className="font-medium">Use my git sign-in</span>
                    </div>
                    <span className="text-[12px] text-muted">Not yet for tasks on a computer</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="pl-[22px] font-medium">Internet access</span>
                    <Toggle checked={prOn || network} onChange={setNetwork} disabled={prOn} label="Internet access" />
                  </div>
                  {sandbox && deviceSandbox?.osSandbox !== false && deviceAcceptsWeb ? <OutsideFolder value={outsideAccess} onChange={setOutside} /> : null}
                </>
              ) : (
                <>
                  {osSandbox ? (
                    <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                      <div className="flex items-center gap-2">
                        <ShieldCheck size={14} className={sandbox ? "text-ok" : "text-warn"} />
                        <span className="font-medium">Sandbox</span>
                        <InfoTip text={`${guard.data?.sandbox.reason ?? "An OS sandbox around every command."} No Docker or VM is involved.${guard.data?.sandbox.limits?.length ? ` Not enforced on this computer: ${guard.data.sandbox.limits.join("; ")}.` : ""}`} />
                      </div>
                      <Toggle checked={sandbox} onChange={setSandbox} label="Sandbox" />
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 border-t border-line pt-2 text-[12px] text-warn" data-testid="not-sandboxed">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">
                        <span className="font-medium">No sandbox on this computer yet.</span> {guard.data?.sandbox.reason ?? ""}{" "}
                        This run works directly on the computer, with Ensemble&apos;s allow-list and folder checks.
                        {guard.data?.sandbox.setup?.needed ? (
                          <button type="button" className="btn ml-1 mt-1 h-7" disabled={setupSandbox.isPending} onClick={() => setupSandbox.mutate()}>
                            {setupSandbox.isPending ? "Waiting for Windows…" : "Set up the sandbox"}
                          </button>
                        ) : null}
                      </span>
                    </div>
                  )}
                  {osSandbox && !sandbox ? (
                    <div className="flex items-start gap-1.5 text-[12px] text-warn">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> Commands will run as you, unconfined. The file tools still stay in the folder, but a script it runs could reach the rest of your computer.
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Lock size={14} className={credentials ? "text-warn" : "text-muted"} />
                      <span className="font-medium">Use my git sign-in</span>
                      <InfoTip text="Ensemble uses your GitHub sign-in to clone and fetch private repositories. The token stays in the app; the agent never sees it. Pushes and pull requests use this computer's own git and GitHub sign-in." />
                    </div>
                    <Toggle checked={credentials} onChange={setCredentials} label="Use my git sign-in" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="pl-[22px] font-medium">Internet access</span>
                    <Toggle checked={prOn || network} onChange={setNetwork} disabled={prOn} label="Internet access" />
                  </div>
                  {sandbox && osSandbox ? <OutsideFolder value={outsideAccess} onChange={setOutside} /> : null}
                  {place === "folder" ? (
                    <div className="space-y-2 border-t border-line pt-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">Trust this folder</span>
                        <Segmented
                          value={trustChoice}
                          onChange={setTrustChoice}
                          options={[
                            { id: "none", label: "No" },
                            { id: "task", label: "This task" },
                            { id: "always", label: "Always" },
                          ]}
                        />
                      </div>
                    </div>
                  ) : null}
                </>
              )}
              {needsTrust ? (
                <div className="flex items-start gap-1.5 text-[12px] text-danger" role="alert">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {mode === "unattended" ? "Run unattended" : "Review only"} needs a folder you trust. Trust this folder above, or choose Ask.
                </div>
              ) : null}
              {unattendedNoSandbox ? (
                <div className="flex items-start gap-1.5 text-[12px] text-danger" role="alert">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  Run unattended needs an OS sandbox, and this computer runs agents in Ask mode. Choose Ask or Review only.
                </div>
              ) : null}
            </div>
            </>
            )}
          </>
        ) : null}

        <div>
          <Label>Instructions for this attempt</Label>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            placeholder={kind === "research" ? "e.g. Focus on 2022–2026 papers, compare evaluation metrics in a table." : "e.g. Run the test suite, fix what fails, write a short report of the output."}
            className="field w-full"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={markDone} onChange={(event) => setMarkDone(event.target.checked)} />
            Move the task to Done when it finishes
          </label>
          <button type="button" onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
            <ChevronRight size={13} className={cx("transition-transform", advanced && "rotate-90")} /> Limits
          </button>
        </div>
        {advanced ? (
          <div className="grid grid-cols-3 gap-3">
            {([
              ["maxMinutes", maxMinutes, setMaxMinutes, settings.data?.settings.orchestration.maxMinutes ?? 60],
              ["maxToolCalls", maxToolCalls, setMaxToolCalls, 80],
              ["maxTurns", maxTurns, setMaxTurns, settings.data?.settings.orchestration.maxTurns ?? 40],
            ] as const).map(([key, value, set, fallback]) => (
              <label key={key} className="block">
                <span className="text-[12px] text-muted">{LIMITS[key].label}</span>
                <input
                  type="number"
                  min={LIMITS[key].min}
                  max={LIMITS[key].max}
                  value={value}
                  placeholder={String(fallback)}
                  onChange={(event) => (set as (value: number | "") => void)(event.target.value ? Number(event.target.value) : "")}
                  className="field mt-1 w-full"
                />
              </label>
            ))}
            <div className="col-span-3 text-[11.5px] text-faint">Minutes count working time; time waiting for you on Needs me does not use them up.</div>
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t border-line pt-3">
          <div className="min-w-0 flex-1 text-[12px] leading-4 text-muted">
            <div className="truncate">{summary}</div>
            {(appMode ? handoffBlocker : blocker) ? (
              <div className="mt-0.5 flex items-start gap-1 text-warn" role="status" data-assign-blocker>
                <AlertTriangle size={12} className="mt-[2px] shrink-0" aria-hidden />
                <span><WithCode text={(appMode ? handoffBlocker : blocker)!.text} /></span>
              </div>
            ) : (
              <div>
                {selectedDevice
                  ? `Runs on ${selectedDevice.name}, not on the server. It waits there until Ensemble is running.`
                  : board.data?.paused
                    ? "The agent is paused. It will queue until you resume."
                    : startsNow
                      ? `Starts now · up to ${slots} run at once`
                      : `Queued behind ${ahead} · up to ${slots} run at once`}
              </div>
            )}
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {taskId && !appMode ? <button type="button" className="btn-ghost" title="Use the saved default profile" disabled={quickAssignment.isPending || assign.isPending} onClick={() => quickAssignment.mutate(taskId)}>{quickAssignment.isPending ? <Spinner size={12} /> : null} Quick assign</button> : null}
          {appMode ? (
            <button
              type="button"
              className={cx("btn-primary", handoffBlocker && "opacity-60")}
              aria-disabled={handoffBlocker ? true : undefined}
              disabled={handoff.isPending}
              title={handoffBlocker?.text}
              onClick={() => (handoffBlocker ? reveal(handoffBlocker) : handoff.mutate())}
            >
              {handoff.isPending ? <Spinner size={12} /> : null} {chosen?.terminal ? "Start in a terminal" : `Open in ${chosen?.name ?? "the app"}`}
            </button>
          ) : (
            <button
              type="button"
              className={cx("btn-primary", invalid && "opacity-60")}
              aria-disabled={invalid || undefined}
              disabled={assign.isPending}
              title={blocker?.text}
              onClick={() => (blocker ? reveal(blocker) : assign.mutate())}
            >
              {assign.isPending ? <Spinner size={12} /> : null} Assign
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
