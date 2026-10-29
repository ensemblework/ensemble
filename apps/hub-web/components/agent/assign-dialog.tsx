"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Check, ChevronRight, Cloud, Eye, FolderOpen, GitBranch, GitPullRequest, Hand, Lock, Monitor, Pencil, Plus, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ENGINE_LABELS, isCodeEngine, type CodeEngine, type RunProfile } from "@ensemble/shared-types";
import { api, type AssignInput, type Complexity, type EarlierRun, type HandoffApp } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { desktopShell } from "@/lib/desktop-param";
import { computerName, folderPlace } from "@/lib/device-copy";
import { computerRuns, engineAssign, engineSandboxes } from "@/lib/engine-models";
import { setFeature } from "@/lib/features";
import { useHostCode, useModuleState } from "@/lib/use-module";
import { useQuickAssign } from "./use-quick-assign";
import { agentFields, canAddProfile, defaultProfile, differs, newProfileId, profileAgent, profileChoices, profileSummary, quickProfile, removeProfile, upsertProfile, type ProfileFields } from "@/lib/run-profiles";
import { MERGE_CHOICES, pullRequestNotices, pullRequestProblem, sharedFolderKinds, type PullRequestMerge } from "@/lib/pull-request";
import { useToast } from "../toast";
import { Dialog, InfoTip, Spinner, Toggle, cx } from "../ui";
import { activeComputer } from "../settings/subscriptions";
import { AgentPicker, TuningPicker, agentOptions, choiceLabel, modelOf, type AgentChoice } from "./agent-picker";

type Place = "fresh" | "continue" | "folder";
type Mode = "ask" | "review" | "unattended";
type Delivery = "local" | "commit" | "push";

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
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md border border-line bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
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
      {tip ? <InfoTip text={tip} label={typeof children === "string" ? `About ${children}` : "More information"} /> : null}
    </div>
  );
}

/** Text with `command` spans shown as code. */
function WithCode({ text }: { text: string }) {
  return <>{text.split("`").map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>;
}

/** The three ways a run treats the person, as tiles. Nothing a mode covers is refused; Ensemble's floor (keys, system files, its own code) always holds. */
const MODES: Array<{ id: Mode; title: string; text: string; icon: typeof Hand }> = [
  { id: "ask", title: "Ask", text: "Asks before commands and edits. Reading goes ahead.", icon: Hand },
  { id: "review", title: "Review only", text: "Works freely in its folder. Asks you decisions, and once before working in another folder.", icon: Eye },
  { id: "unattended", title: "Run unattended", text: "Never waits for you. Works across your workspace and folders; keys, system files and Ensemble's code stay off limits.", icon: Bot },
];

/** What each agent is called where it is signed in, and the command that signs it in. */
const ENGINE_SIGN_IN: Record<CodeEngine, { program: string; login: string }> = {
  "claude-code": { program: "Claude Code", login: "claude auth login" },
  codex: { program: "Codex", login: "codex login" },
  "cursor-agent": { program: "Cursor's agent", login: "cursor-agent login" },
  "copilot-cli": { program: "Copilot CLI", login: "copilot login" },
  "grok-cli": { program: "Grok Build", login: "grok login" },
  opencode: { program: "OpenCode", login: "opencode auth login" },
  "gemini-cli": { program: "Gemini CLI", login: "gemini" },
  antigravity: { program: "Antigravity", login: "Sign in under Settings → Models" },
};

const OUTSIDE_HELP =
  "Beyond your Ensemble workspace. Read only: reads go ahead, changing a folder asks once. Read and write: both go ahead. No access: reading asks too. Keys and browser data stay private in every case.";

/** Beyond the workspace, for this sandboxed run. */
function OutsideFolder({ value, onChange }: { value: "none" | "read" | "read-write"; onChange: (value: "none" | "read" | "read-write") => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 font-medium">
        Outside the workspace <InfoTip text={OUTSIDE_HELP} />
      </span>
      <Segmented
        value={value}
        onChange={onChange}
        label="Outside the workspace"
        options={[
          { id: "read", label: "Read only" },
          { id: "read-write", label: "Read and write" },
          { id: "none", label: "No access" },
        ]}
      />
    </div>
  );
}

/** The saved profiles as chips, with a new one, save changes, rename, default and delete. Max three. */
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
                {profile.id === activeId && modified ? <span className="text-faint">· changed</span> : null}
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
              placeholder={editing.id ? "Profile name" : "Name the new profile"}
              aria-label="Profile name"
              className="field h-7 w-40 py-0 text-[12.5px]"
            />
            <button type="submit" className="btn h-7 px-2 text-[12px]" disabled={busy || !editing.name.trim()}>
              Save
            </button>
            <button type="button" className="btn-ghost h-7 px-1.5" onClick={() => setEditing(null)} aria-label="Cancel">
              <X size={13} />
            </button>
          </form>
        ) : (
          <>
            {canAddProfile(saved) ? (
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 py-0.5 text-[12.5px] text-muted transition-colors hover:border-accent hover:text-ink"
                disabled={busy}
                title="Save these settings as a new profile"
                onClick={() => setEditing({ name: "" })}
              >
                <Plus size={12} /> New profile
              </button>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {isSaved && modified && active ? (
                <button type="button" className="btn-ghost h-7 px-2 text-[12px]" disabled={busy} onClick={() => onSave({ id: active.id, name: active.name })}>
                  Save to “{active.name}”
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
          </>
        )}
      </div>
      {!canAddProfile(saved) && !editing ? <div className="text-[11.5px] text-faint">Three profiles saved. Save changes to one, or delete one to make another.</div> : null}
    </div>
  );
}

type Blocker = { text: string; field: "task" | "run-on" | "place" | "branch" | "mode" | "pull-request" | "agent" };

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
  kind: "research" | "code";
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
  mode: Mode;
  /** The person's own coding agent doing the work, if one is. */
  engine?: CodeEngine | null;
  /** This is the desktop app, which runs coding agents on its own computer. */
  local?: boolean;
  /** What keeps the run's pull request from going ahead (lib/pull-request), when it ends in one. */
  pullRequest?: Blocker | null;
}): Blocker | null {
  if (!form.taskId) return { text: "Choose a task first.", field: "task" };
  if (form.engine && !form.device && !form.local) {
    return form.devices
      ? { text: `${ENGINE_LABELS[form.engine]} runs on one of your computers. Choose it under Runs on.`, field: "run-on" }
      : { text: `${ENGINE_LABELS[form.engine]} runs on one of your computers with your own sign-in. Pair one in Settings → Devices first.`, field: "run-on" };
  }
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
  return null;
}

export function AssignDialog({ open, onClose, taskId: fixedTaskId }: { open: boolean; onClose: () => void; taskId?: string }) {
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
  // Null: the task's complexity tier picks (Settings → Models).
  const [agent, setAgent] = useState<AgentChoice | null>(null);
  // Opened in the agent's own app on this computer instead of run by Ensemble.
  const [inApp, setInApp] = useState(false);
  const [appTarget, setAppTarget] = useState<HandoffApp>("claude");
  const [instructions, setInstructions] = useState("");
  const [place, setPlace] = useState<Place>("fresh");
  const [repo, setRepo] = useState("");
  const [continueFrom, setContinueFrom] = useState("");
  const [folder, setFolder] = useState("");
  const [folderCheck, setFolderCheck] = useState<{ ok: boolean; text: string; git?: boolean } | null>(null);
  const [branchMode, setBranchMode] = useState<"as-is" | "existing" | "new">("as-is");
  const [branch, setBranch] = useState("");
  // "push" is No limits; "local" and "commit" are limits the person picks.
  const [delivery, setDelivery] = useState<Delivery>("push");
  // A run that ends in a pull request Ensemble opens: its base (empty: the default branch) and what happens once it is open. Null: the git choice above.
  const [pullRequest, setPullRequest] = useState<{ base: string; merge: PullRequestMerge } | null>(null);
  const [prBranch, setPrBranch] = useState("");
  const [askFirst, setAskFirst] = useState(false);
  const [credentials, setCredentials] = useState(false);
  // The saved secrets the chosen profile names: a run on a computer gets only those (docs/35 §8.7).
  const [profileSecrets, setProfileSecrets] = useState<string[]>([]);
  const [sandbox, setSandbox] = useState(true);
  const [network, setNetwork] = useState(true);
  // null follows Settings; a choice here is for this run only.
  const [outside, setOutside] = useState<"none" | "read" | "read-write" | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [markDone, setMarkDone] = useState(true);
  const [more, setMore] = useState(false);
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
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, enabled: open, staleTime: 30_000 });
  // This server's folders: refused on Ensemble on the web to anyone but its operator.
  const hostCode = useHostCode() === true;
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, enabled: open });
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: open, refetchInterval: open ? 15_000 : false });
  const devices = computers.data?.devices ?? [];
  const selectedDevice = devices.find((device) => device.id === runOn) ?? null;
  // In a space shared with you, the agent runs on your own computers only (they are the only ones listed).
  const access = useSpaceAccess();
  const serverRunner = !access.guest && (computers.data?.serverRunner ?? board.data?.serverRunner) !== false;
  // Without a code runner, Ensemble's own agent can still research and write on the server.
  const cloud = !access.guest && !serverRunner;

  // Who does the work: the choice here, else the task's tier (Settings → Models).
  const complexity = (task.data?.task.complexity ?? "medium") as Complexity;
  const tier = settings.data?.settings.models[complexity];
  const tierChoice: AgentChoice | null = tier ? { provider: tier.provider, model: tier.model, effort: tier.effort, ...(tier.context === "long_context" ? { context: "long_context" as const } : {}) } : null;
  const effective = agent ?? tierChoice;
  const codeEngine: CodeEngine | null = effective && isCodeEngine(effective.provider) ? effective.provider : null;

  // A coding agent runs on a computer: from Ensemble's server, it goes to one that has it signed in.
  const computerFor = (engine: CodeEngine | null): string | null => {
    const rows = devices.filter((device) => !engine || computerRuns(engine, device.capabilities));
    const signedIn = engine ? subscriptions.data?.computers.find((row) => row.online && row.agents.some((item) => item.id === engine && item.signedIn !== false) && rows.some((device) => device.id === row.id)) : undefined;
    return signedIn?.id ?? rows.find((device) => device.online)?.id ?? rows[0]?.id ?? devices.find((device) => device.online)?.id ?? devices[0]?.id ?? null;
  };
  const serverAllowed = serverRunner || (cloud && !codeEngine);
  // Where a run goes first: this server when it runs code, else a paired computer; Ensemble alone (research and writing) when there is none.
  const placed = useRef(false);
  useEffect(() => {
    if (!open) {
      placed.current = false;
      return;
    }
    if (!computers.data || placed.current) return;
    placed.current = true;
    if (runOn === "server" && !serverRunner && devices.length) setRunOn(computerFor(codeEngine) ?? "server");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, computers.data]);
  useEffect(() => {
    if (!open || !computers.data) return;
    if (runOn === "server" && !serverAllowed) setRunOn(computerFor(codeEngine) ?? "server");
    else if (runOn !== "server" && !devices.some((device) => device.id === runOn)) setRunOn(serverRunner ? "server" : computerFor(codeEngine) ?? "server");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, computers.data, runOn, serverAllowed, codeEngine]);

  // A run that can work in a folder (a coding agent, a paired computer, or this server) is a code run; otherwise research and writing on the server.
  const codeRun = Boolean(codeEngine) || selectedDevice !== null || serverRunner;
  const kind: "research" | "code" = codeRun ? "code" : "research";

  // Earlier runs to continue: on the chosen computer (its folders are there), or on this server.
  const checkouts = useQuery({
    queryKey: ["checkouts", selectedDevice?.id ?? "server", taskId],
    queryFn: () => (selectedDevice ? api.earlierRuns(selectedDevice.id, taskId || undefined) : api.checkouts(taskId || undefined)),
    enabled: open && codeRun && place === "continue" && (selectedDevice !== null || hostCode),
  });
  const agentApps = useQuery({ queryKey: ["agent-apps"], queryFn: api.agentApps, enabled: open, staleTime: 60_000 });
  const apps = agentApps.data?.targets ?? [];
  const appMode = inApp && codeRun && !selectedDevice && apps.length > 0;
  const deviceAcceptsWeb = (selectedDevice?.capabilities as { acceptWebApprovals?: unknown } | null)?.acceptWebApprovals !== false;
  // The chosen earlier run stays one of the listed ones (the list follows the computer); with none
  // chosen, this task's own latest run is, as carrying it on is the usual reason to continue.
  const earlier = checkouts.data?.checkouts;
  useEffect(() => {
    if (!earlier || place !== "continue") return;
    if (continueFrom && earlier.some((row) => row.jobId === continueFrom)) return;
    const own = taskId ? earlier.find((row) => row.taskId === taskId) : undefined;
    setContinueFrom(own?.jobId ?? "");
  }, [earlier, place, continueFrom, taskId]);

  // The agents and models the picker offers: the AI plans as the run's computer reported them.
  const planComputer = useMemo(() => {
    const rows = subscriptions.data?.computers ?? [];
    return (selectedDevice ? rows.find((row) => row.id === selectedDevice.id) : rows.find((row) => row.local)) ?? (selectedDevice ? null : activeComputer(subscriptions.data));
  }, [subscriptions.data, selectedDevice]);
  const agents = useMemo(
    () => agentOptions({ catalog: catalog.data, computer: planComputer, capabilities: selectedDevice?.capabilities }),
    [catalog.data, planComputer, selectedDevice?.capabilities],
  );
  const chosenModel = modelOf(agents, effective);
  const reportedAgent = codeEngine ? (planComputer?.agents.find((row) => row.id === codeEngine) ?? null) : null;
  const agentWhere = selectedDevice ? computerName(selectedDevice.name) : desktopShell() ? "this computer" : "this server";
  const branchSource = place === "folder" && folderCheck?.ok && folderCheck.git ? folder : place === "fresh" && repo.startsWith("/") ? repo : "";
  const branches = useQuery({ queryKey: ["branches", branchSource], queryFn: () => api.branches(branchSource), enabled: open && Boolean(branchSource) });
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: open && codeRun && hostCode && pullRequest !== null });
  const folderKinds = selectedDevice ? sharedFolderKinds(selectedDevice.capabilities) : {};
  const prOn = codeRun && pullRequest !== null;
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

  const fields: ProfileFields = {
    kind: "code",
    deviceId: runOn === "server" ? null : runOn,
    ...agentFields(agent),
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
    ...(profileSecrets.length ? { secrets: profileSecrets } : {}),
  };

  const applyProfile = (profile: RunProfile) => {
    setProfileId(profile.id);
    if (profile.deviceId && devices.some((device) => device.id === profile.deviceId)) setRunOn(profile.deviceId);
    setAgent(profileAgent(profile));
    setInApp(false);
    setBranchMode(profile.branchMode);
    setDelivery(profile.delivery);
    setAskFirst(profile.askBeforePublish);
    setMode(profile.mode);
    setSandbox(profile.sandbox);
    setCredentials(profile.useCredentials);
    setNetwork(profile.network);
    setOutside(null);
    setMarkDone(profile.markDone);
    setMaxMinutes(profile.maxMinutes ?? "");
    setMaxToolCalls(profile.maxToolCalls ?? "");
    setMaxTurns(profile.maxTurns ?? "");
    setInstructions(profile.instructions);
    setPullRequest(profile.pullRequest ? { base: profile.pullRequest.base, merge: profile.pullRequest.merge } : null);
    setPrBranch("");
    setProfileSecrets(profile.secrets ?? []);
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
    setMore(false);
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

  const guard = useQuery({ queryKey: ["workspace-guard"], queryFn: api.workspaceGuard, enabled: open && codeRun, staleTime: 5 * 60_000 });
  const osSandbox = guard.data?.sandbox.osSandbox ?? true;
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
  // A coding agent with no OS sandbox Ensemble can turn on there runs directly; Ensemble still judges every call it makes.
  const engineUnsandboxed = Boolean(codeEngine && !engineSandboxes(codeEngine, selectedDevice?.platform ?? (typeof navigator === "undefined" ? null : navigator.platform)));
  const runSandboxed = sandbox && !engineUnsandboxed && (selectedDevice ? deviceSandbox?.osSandbox !== false : osSandbox);

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
  const outsideAccess = outside ?? orchestration?.outsideAccess ?? "read";
  const blocker = assignBlocker({
    taskId,
    kind,
    serverRunner,
    device: selectedDevice ? { name: computerName(selectedDevice.name), folders: selectedDevice.folders.length } : null,
    devices: devices.length,
    place,
    continueFrom,
    folder,
    folderCheck,
    folderLabel,
    // The pull request's branch name is optional (pullRequestNotices checks it).
    branchMode: prOn ? "as-is" : branchMode,
    branch,
    mode,
    engine: codeEngine,
    local: desktopShell() && serverRunner,
    pullRequest: prNotices ? pullRequestProblem(prNotices) : null,
  });
  const invalid = Boolean(blocker);

  const limitValue = (value: number | "", key: keyof typeof LIMITS) => (value === "" ? undefined : Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, value)));

  const assign = useMutation({
    mutationFn: () => {
      // Auto: nothing is named, so the server uses the task's tier (its agent, model and thinking level).
      const named = agent;
      const engineRun = named && isCodeEngine(named.provider);
      const input: AssignInput = {
        taskId,
        kind,
        instructions,
        ...(named
          ? engineRun
            ? engineAssign(named.provider as CodeEngine, { model: named.model, effort: named.effort, context: named.context, fast: named.fast }, chosenModel ? { model: null, efforts: chosenModel.levels, defaultEffort: chosenModel.defaultEffort, contexts: chosenModel.contexts, fast: chosenModel.fast } : undefined)
            : { engine: "ensemble" as const, provider: named.provider, model: named.model, ...(named.effort !== "default" ? { reasoningEffort: named.effort } : {}) }
          : { engine: "ensemble" as const }),
        markDone,
        maxMinutes: limitValue(maxMinutes, "maxMinutes"),
        maxToolCalls: limitValue(maxToolCalls, "maxToolCalls"),
        maxTurns: limitValue(maxTurns, "maxTurns"),
        network,
      };
      if (kind === "code") {
        Object.assign(input, {
          mode,
          // A computer or agent without a sandbox would refuse a sandboxed run; it runs directly, with Ensemble judging each call.
          sandbox: runSandboxed,
          delivery: prOn ? "commit" : delivery,
          askBeforePublish: mode === "unattended" ? false : askFirst,
          // A pull request's branch is new, made from its base; empty: Ensemble names it.
          branchMode: prOn ? (prBranch.trim() ? "new" : "as-is") : branchMode,
          branch: prOn ? prBranch.trim() || undefined : branchMode === "as-is" ? undefined : branch.trim(),
          ...(prOn ? { pullRequest: { base: pullRequest.base.trim(), merge: pullRequest.merge }, network: true } : {}),
          ...(prOn && place === "fresh" && repo.trim() ? { repoUrl: repo.trim() } : {}),
          ...(place === "continue" ? { continueFromJobId: continueFrom } : {}),
          ...(outside ? { outsideAccess: outside } : {}),
        });
        if (selectedDevice) {
          Object.assign(input, { useCredentials: false, ...(place === "folder" ? { folderLabel } : {}), ...(profileSecrets.length ? { secrets: profileSecrets } : {}) });
        } else {
          Object.assign(input, { useCredentials: credentials, ...(place === "folder" ? { folder } : {}) });
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
            ? "The agent started. Follow it in the top bar or Runs."
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
  // An app works on a folder: a folder here, an earlier task's, or a new empty one. Ensemble does not clone for it.
  const handoffBlocker: Blocker | null = !taskId
    ? { text: "Choose a task first.", field: "task" }
    : place === "folder" && !folderCheck?.ok
      ? { text: folderProblem(folder, folderCheck), field: "place" }
      : place === "continue" && !continueFrom
        ? { text: "Choose the earlier task to continue.", field: "place" }
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
    if (["branch", "pull-request"].includes(reason.field)) setMore(true);
    window.setTimeout(() => {
      const field = body.current?.querySelector<HTMLElement>(`[data-assign-field="${reason.field}"]`);
      field?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      field?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea, button:not([disabled])")?.focus({ preventScroll: true });
    }, 0);
    setAttention(reason.field);
  };
  const attentionProps = (field: string) => ({ "data-assign-field": field, "data-attention": attention === field ? "true" : undefined });

  const candidates = (tasks.data?.tasks ?? []).filter((row) => !["done", "dropped"].includes(row.status));
  const autoText = tier ? `${TIER_LABEL[complexity]} task → ${choiceLabel(agents, { provider: tier.provider, model: tier.model })}` : "the task's complexity tier";
  const runOnOptions: Array<{ id: string; label: string; detail?: string; online?: boolean; icon: "computer" | "cloud" }> = [
    ...(serverRunner ? [{ id: "server", label: desktopShell() ? "This computer" : "This server", icon: "computer" as const, online: true }] : []),
    ...(cloud && !codeEngine ? [{ id: "server", label: "Ensemble", detail: "research and writing, no folder", icon: "cloud" as const, online: true }] : []),
    ...devices.map((device) => ({ id: device.id, label: device.name, icon: "computer" as const, online: device.online, detail: device.online ? "online" : "offline: starts when it is back" })),
  ];
  const moreSummary = [
    instructions.trim() ? "instructions" : null,
    prOn ? "pull request" : delivery === "local" ? "git: local only" : delivery === "commit" ? "git: no push" : null,
    !prOn && branchMode !== "as-is" ? `branch: ${branch.trim() || branchMode}` : null,
    codeRun && !runSandboxed ? "no sandbox" : null,
    !network && !prOn ? "internet off" : null,
    outside ? `outside: ${outside}` : null,
    appMode ? `opens in ${chosen?.name ?? "its app"}` : null,
  ].filter(Boolean);

  // A space whose template leaves agents out: say so, and turn them on here, instead of a refused request.
  if (open && agentsState === false) {
    return (
      <Dialog open={open} onClose={onClose} title="Turn on agents for this space?" width={520}>
        <div className="space-y-3 text-[13.5px]">
          <p>
            Turn on the agent queue in <span className="font-medium">Runs</span> and <span className="font-medium">Code review</span>.
            Your tasks and pages stay as they are. Turn these off in Settings → Account → Features.
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

        <div {...attentionProps("agent")} data-testid="assign-agent">
          <Label tip="Ensemble's included models, your own AI plans (Claude, ChatGPT, GitHub Copilot…) signed in on your computer, or an API key. Auto follows Settings → Models for the task's complexity.">Agent</Label>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <AgentPicker
                label="Agent and model"
                agents={agents}
                value={agent}
                auto={{ text: autoText, choice: tierChoice }}
                onChange={(next) => {
                  setAgent(next);
                  setInApp(false);
                  const engine = next ? (isCodeEngine(next.provider) ? next.provider : null) : tierChoice && isCodeEngine(tierChoice.provider) ? tierChoice.provider : null;
                  if (engine && runOn === "server" && !serverRunner) setRunOn(computerFor(engine) ?? "server");
                }}
              />
            </div>
            {agent ? <TuningPicker label="Thinking and context" value={agent} model={chosenModel} onChange={setAgent} /> : null}
          </div>
          {codeEngine && selectedDevice && !computerRuns(codeEngine, selectedDevice.capabilities) ? (
            <p className="mt-1.5 text-[12px] leading-[18px] text-warn" role="status">
              Ensemble on {agentWhere} is too old to run {ENGINE_LABELS[codeEngine]}. Update it there (<code>ensemble update</code>, or the desktop app&apos;s update), then assign.
            </p>
          ) : codeEngine && reportedAgent?.signedIn === false ? (
            <p className="mt-1.5 text-[12px] leading-[18px] text-warn" role="status" data-testid="engine-signed-out">
              {ENGINE_SIGN_IN[codeEngine].program} is not signed in on {agentWhere}: run <code>{ENGINE_SIGN_IN[codeEngine].login}</code> there or press Sign in under Settings → Models.
            </p>
          ) : codeEngine && reportedAgent?.problem ? (
            <p className="mt-1.5 text-[12px] leading-[18px] text-muted" role="status" data-testid="engine-problem">
              {reportedAgent.problem}
            </p>
          ) : null}
          {engineUnsandboxed && codeEngine && sandbox ? (
            <p className="mt-1.5 text-[12px] leading-[18px] text-muted" role="status" data-testid="engine-no-sandbox">
              {ENGINE_LABELS[codeEngine]} has no OS sandbox Ensemble can turn on there, so it runs directly. Ensemble still judges every command, edit and fetch it makes.
            </p>
          ) : null}
        </div>

        {runOnOptions.length > 1 || !serverRunner ? (
          <div {...attentionProps("run-on")}>
            <Label tip="A run for a computer waits until Ensemble is running there. Ensemble alone researches and writes, without a folder.">Runs on</Label>
            <div className="flex flex-wrap gap-1.5">
              {runOnOptions.map((option) => (
                <button
                  key={`${option.id}-${option.icon}`}
                  type="button"
                  onClick={() => {
                    setRunOn(option.id);
                    setFolderLabel("");
                  }}
                  title={option.detail}
                  className={cx(
                    "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    runOn === option.id ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong",
                  )}
                >
                  {option.icon === "cloud" ? <Cloud size={13} className="shrink-0 text-muted" /> : <Monitor size={13} className="shrink-0 text-muted" />}
                  <span className="font-medium">{option.label}</span>
                  {option.icon === "cloud" ? <span className="text-[11.5px] text-faint">research and writing</span> : <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", option.online ? "bg-ok" : "bg-line-strong")} aria-label={option.online ? "Online" : "Offline"} />}
                </button>
              ))}
            </div>
            {!runOnOptions.length ? <div className="text-[12.5px] text-muted">Add a computer with the Ensemble CLI in Settings → Devices, or pair the desktop app. Code runs there.</div> : null}
            {access.guest ? (
              <p className="mt-2 rounded-md bg-panel px-2.5 py-2 text-[12px] leading-[18px] text-muted">
                This is {access.owner ?? "someone"}'s space, so the agent runs on one of your computers. They see that it runs on your computer, never which one,
                and they can follow its log. Only you can answer its questions or stop it.
              </p>
            ) : null}
          </div>
        ) : null}

        {codeRun ? (
          <div {...attentionProps("place")}>
            <Label tip="Its own checkout: a new folder in your Ensemble workspace; the agent clones or creates what the task needs. Continue an earlier task: that folder, and the same agent picks up its own conversation from it.">Where it works</Label>
            <Segmented
              value={place}
              onChange={setPlace}
              label="Where it works"
              options={[
                { id: "fresh", label: "Its own checkout" },
                { id: "continue", label: "Continue an earlier task" },
                { id: "folder", label: folderPlace(selectedDevice?.name) },
              ]}
            />
            {place === "continue" ? (
              <div className="mt-2">
                <select aria-label="Earlier task" value={continueFrom} onChange={(event) => setContinueFrom(event.target.value)} className="field w-full" disabled={!earlier?.length}>
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
                {checkouts.isError ? <p role="alert" className="mt-1 text-[12px] text-danger">{checkouts.error.message}</p> : null}
              </div>
            ) : place === "folder" ? (
              <div className="mt-2">
                {selectedDevice ? (
                  <>
                    <select aria-label="Shared folder" value={folderLabel} onChange={(event) => setFolderLabel(event.target.value)} className="field w-full" disabled={!selectedDevice.folders.length}>
                      <option value="">{selectedDevice.folders.length ? `Choose a folder ${computerName(selectedDevice?.name)} has shared…` : `${computerName(selectedDevice?.name)} has not shared a folder yet`}</option>
                      {selectedDevice.folders.map((label) => (
                        <option key={label} value={label}>{label}{folderKinds[label] === "repo" ? " · repository" : ""}</option>
                      ))}
                    </select>
                    {!selectedDevice.folders.length ? <p className="mt-1 text-[12px] text-muted">Share a folder with <code>ensemble folders add &lt;path&gt;</code>, or let it work in its own checkout.</p> : null}
                  </>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <input
                        aria-label="Folder"
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
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {codeRun && !appMode ? (
          <div {...attentionProps("mode")}>
            <Label tip="Choosing a mode is your trust: nothing it covers is refused. Keys, system files and Ensemble's own code are always off limits.">Mode</Label>
            <div role="radiogroup" aria-label="Mode" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.id}
                  onClick={() => setMode(option.id)}
                  className={cx(
                    "rounded-lg border p-2.5 text-left transition-colors",
                    mode === option.id ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong",
                  )}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <option.icon size={14} className={mode === option.id ? "text-accent" : "text-muted"} />
                    {option.title}
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[15px] text-muted">{option.text}</div>
                </button>
              ))}
            </div>
            {selectedDevice && !deviceAcceptsWeb ? (
              <div className="mt-2 flex items-start gap-1.5 text-[12px] text-warn">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {selectedDevice.name} accepts only narrowing settings from here: it asks before each commit, uses its own internet setting, and runs in Ask mode. Change that on {selectedDevice.name}.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-lg border border-line">
          <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-medium text-muted hover:text-ink">
            <ChevronRight size={13} className={cx("transition-transform", more && "rotate-90")} /> More options
            {moreSummary.length && !more ? <span className="ml-1 truncate font-normal text-faint">· {moreSummary.join(" · ")}</span> : null}
          </button>
          {more ? (
            <div className="space-y-4 border-t border-line px-3 pb-3 pt-3" data-testid="assign-more">
              <div>
                <Label>Instructions for this attempt</Label>
                <textarea
                  aria-label="Instructions for this attempt"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  rows={3}
                  placeholder="Optional. The task's page already goes to the agent. e.g. Run the tests, fix what fails, and write a short report."
                  className="field w-full"
                />
              </div>

              {codeRun && !appMode ? (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                    <div>
                      <Label tip="No limits: commit, push and manage pull requests as the task says. Commit: no push. Local only: no commits. Pull request: Ensemble opens one when the run ends.">Git</Label>
                      <Segmented
                        value={prOn ? "pr" : delivery}
                        label="Git"
                        onChange={(value) => {
                          if (value === "pr") {
                            setPullRequest((current) => current ?? { base: "", merge: "ask" });
                            return;
                          }
                          setPullRequest(null);
                          setDelivery(value);
                        }}
                        options={[{ id: "push", label: "No limits" }, { id: "commit", label: "Commit" }, { id: "local", label: "Local only" }, { id: "pr", label: "Pull request" }]}
                      />
                      {prOn || delivery !== "local" ? (
                        <label className={cx("mt-2 flex items-center gap-2 text-[12.5px]", mode === "unattended" ? "text-faint" : "text-muted")} title={mode === "unattended" ? "Nobody approves in an unattended run." : undefined}>
                          <input type="checkbox" checked={askFirst && mode !== "unattended"} disabled={mode === "unattended"} onChange={(event) => setAskFirst(event.target.checked)} />
                          Ask me before each commit
                        </label>
                      ) : null}
                    </div>
                    <div {...attentionProps("branch")}>
                      {prOn ? (
                        <>
                          <Label tip="The branch Ensemble pushes and opens the pull request from, used exactly as named. Leave it empty and Ensemble names one.">
                            <GitBranch size={13} /> Branch name
                          </Label>
                          <input aria-label="Branch name" value={prBranch} onChange={(event) => setPrBranch(event.target.value)} placeholder="Ensemble names it" className="field w-full font-mono text-[12.5px]" />
                          {prNotices?.branch ? (
                            <div className="mt-1 text-[12px] text-danger" role="alert" data-testid="pull-request-branch-notice">{prNotices.branch}</div>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <Label tip="As is: the agent decides from the task, starting on the branch checked out now. Existing or New: a branch you name.">
                            <GitBranch size={13} /> Branch
                          </Label>
                          <Segmented
                            value={branchMode}
                            onChange={setBranchMode}
                            label="Branch"
                            options={[
                              { id: "as-is", label: "Agent decides" },
                              { id: "existing", label: "Existing" },
                              { id: "new", label: "New" },
                            ]}
                          />
                          {branchMode !== "as-is" ? (
                            <>
                              <input list="assign-branches" aria-label="Branch to use" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={branchMode === "new" ? "ensemble/fix-tests" : "feature/x"} className="field mt-2 w-full font-mono text-[12.5px]" />
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
                  </div>

                  {prOn ? (
                    <div className="space-y-2 rounded-lg border border-line bg-raised p-3" data-testid="assign-pull-request" {...attentionProps("pull-request")}>
                      <div className="flex items-center gap-1.5 font-medium">
                        <GitPullRequest size={14} className="text-muted" /> Pull request
                      </div>
                      {place === "fresh" ? (
                        <div>
                          <Label tip="Its own checkout starts from this repository so the pull request has somewhere to go. A folder or an earlier task needs none.">Repository</Label>
                          <input list="assign-repos" aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="https://github.com/owner/repo or owner/repo" className="field w-full" />
                          <datalist id="assign-repos">
                            {(repos.data?.repos ?? []).map((path) => (
                              <option key={path} value={path} />
                            ))}
                          </datalist>
                        </div>
                      ) : null}
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

                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <ShieldCheck size={14} className={runSandboxed ? "text-ok" : "text-warn"} />
                        <span className="font-medium">Sandbox</span>
                        <span className="truncate text-[12px] text-muted">
                          {selectedDevice
                            ? deviceSandbox?.osSandbox === false
                              ? deviceSandbox.setupNeeded
                                ? `Not set up on ${selectedDevice.name}: run \`ensemble sandbox setup\` there once`
                                : `None on ${selectedDevice.name}: runs directly`
                              : deviceSandbox?.mechanism
                                ? SANDBOX_NAME[deviceSandbox.mechanism] ?? deviceSandbox.mechanism
                                : ""
                            : osSandbox
                              ? ""
                              : "None on this computer yet: runs directly"}
                        </span>
                        {!selectedDevice && osSandbox ? <InfoTip text={`${guard.data?.sandbox.reason ?? "An OS sandbox around every command."} No Docker or VM is involved.${guard.data?.sandbox.limits?.length ? ` Not enforced on this computer: ${guard.data.sandbox.limits.join("; ")}.` : ""}`} /> : null}
                      </div>
                      {(selectedDevice ? deviceSandbox?.osSandbox !== false && deviceAcceptsWeb : osSandbox) ? (
                        <Toggle checked={sandbox} onChange={setSandbox} label="Sandbox" />
                      ) : selectedDevice && !deviceAcceptsWeb ? (
                        <span className="text-[12px] text-muted">On ({selectedDevice.name} decides)</span>
                      ) : !selectedDevice && guard.data?.sandbox.setup?.needed ? (
                        <button type="button" className="btn h-7" disabled={setupSandbox.isPending} onClick={() => setupSandbox.mutate()}>
                          {setupSandbox.isPending ? "Waiting for Windows…" : "Set up the sandbox"}
                        </button>
                      ) : null}
                    </div>
                    {!runSandboxed ? <p className="pl-[22px] text-[11.5px] text-faint">Commands run as you. Ensemble still checks every path and command, and keys, system files and its own code stay off limits.</p> : null}
                    <div className="flex items-center justify-between gap-3">
                      <span className="pl-[22px] font-medium">Internet access</span>
                      <Toggle checked={prOn || network} onChange={setNetwork} disabled={prOn} label="Internet access" />
                    </div>
                    {runSandboxed && (!selectedDevice || deviceAcceptsWeb) ? <div className="pl-[22px]"><OutsideFolder value={outsideAccess} onChange={setOutside} /></div> : null}
                    {!selectedDevice ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Lock size={14} className={credentials ? "text-warn" : "text-muted"} />
                          <span className="font-medium">Use my git sign-in</span>
                          <InfoTip text="Ensemble uses your GitHub sign-in to clone and fetch private repositories. The token stays in the app; the agent never sees it. Pushes and pull requests use this computer's own git and GitHub sign-in." />
                        </div>
                        <Toggle checked={credentials} onChange={setCredentials} label="Use my git sign-in" />
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {codeRun && !selectedDevice && apps.length ? (
                <div className="space-y-1.5" data-testid="assign-in-app">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">Open in the agent&apos;s own app instead</span>
                    <Toggle checked={inApp} onChange={setInApp} label="Open in the agent's own app" />
                  </div>
                  {inApp ? (
                    <>
                      <select aria-label="Open it in" className="field w-full" value={chosenApp} onChange={(event) => setAppTarget(event.target.value as HandoffApp)}>
                        {apps.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.name}
                          </option>
                        ))}
                      </select>
                      <div className="text-[12px] text-muted">
                        {chosen?.terminal
                          ? `Ensemble opens a terminal on the folder and starts ${chosen.name.replace(/ in a terminal$/, "")} with this task.`
                          : `Ensemble opens ${chosen?.name ?? "the app"} on the folder with this task written in; press Send there.`}{" "}
                        Its prompts also come to Needs me. It uses its own settings and sign-in.
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}

              <div>
                <Label>Limits</Label>
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
                </div>
                <div className="mt-1 text-[11.5px] text-faint">Minutes count working time; time waiting for you on Needs me does not use them up.</div>
              </div>

              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={markDone} onChange={(event) => setMarkDone(event.target.checked)} />
                Move the task to Done when it finishes
              </label>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 border-t border-line pt-3">
          <div className="min-w-0 flex-1 text-[12px] leading-4 text-muted">
            {(appMode ? handoffBlocker : blocker) ? (
              <div className="mt-0.5 flex items-start gap-1 text-warn" role="status" data-assign-blocker>
                <AlertTriangle size={12} className="mt-[2px] shrink-0" aria-hidden />
                <span><WithCode text={(appMode ? handoffBlocker : blocker)!.text} /></span>
              </div>
            ) : (
              <div>
                {selectedDevice
                  ? null
                  : board.data?.paused
                    ? "The agent is paused. It will queue until you resume."
                    : startsNow
                      ? "Starts now"
                      : `Queued behind ${ahead}`}
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
