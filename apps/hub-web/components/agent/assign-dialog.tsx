"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, Code2, FileText, FolderOpen, GitBranch, Lock, Monitor, Pencil, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunProfile } from "@ensemble/shared-types";
import { api, type AssignInput, type Complexity } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { computerName, folderPlace, freshCloneHint } from "@/lib/device-copy";
import { usePersistentState } from "@/lib/prefs";
import { canAddProfile, defaultProfile, differs, newProfileId, profileChoices, profileSummary, quickProfile, removeProfile, upsertProfile, type ProfileFields } from "@/lib/run-profiles";
import { useToast } from "../toast";
import { Dialog, InfoTip, SettingRow, Spinner, Toggle, cx } from "../ui";
import { RunBranchStatus } from "./run-branch-status";
import { PickGitHubRepo } from "../app-items/github-repo-picker";

type Kind = "research" | "code";
type Place = "fresh" | "continue" | "folder";
type Mode = "ask" | "review" | "unattended";
type Effort = "default" | "low" | "medium" | "high";

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

const MODE_HELP: Record<Mode, string> = {
  ask: "Asks before commands and file changes unless the folder is trusted. A path outside the folder always asks. Decision questions come to Needs me.",
  review: "Runs commands and edits inside the folder without asking. Asks only real decisions (an unclear requirement, a choice between approaches), with its recommended option marked. A path outside the folder is refused.",
  unattended: "Nobody needs to be there. Runs inside the folder without asking, picks its recommended option at each decision, and lists every decision it made in the summary. A path outside the folder is refused.",
};

/** The saved profiles as chips, with save, update, rename, default and delete. Max three. */
function ProfileBar({
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
  useEffect(() => {
    if (editing) window.setTimeout(() => input.current?.select(), 20);
  }, [editing]);
  const active = profiles.find((row) => row.id === activeId);
  const isSaved = saved.some((row) => row.id === activeId);
  return (
    <div className="space-y-1.5" data-testid="run-profiles">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[12px] font-medium text-muted">Profile</span>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            onClick={() => onPick(profile)}
            title={profileSummary(profile)}
            className={cx(
              "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12.5px] transition-colors",
              profile.id === activeId ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:text-ink",
            )}
          >
            {profile.id === defaultId ? <Star size={11} className="fill-current text-accent" aria-label="Default" /> : null}
            {profile.name}
            {profile.id === activeId && modified ? <span className="text-faint">· modified</span> : null}
          </button>
        ))}
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
                {active.id !== defaultId ? (
                  <button type="button" className="btn-ghost h-7 px-1.5" title="Use for Quick assign" aria-label="Make default" disabled={busy} onClick={() => onDefault(active.id)}>
                    <Star size={12} />
                  </button>
                ) : null}
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
  const [taskId, setTaskId] = useState(fixedTaskId ?? "");
  const [kind, setKind] = usePersistentState<Kind>("ensemble.assign.kind", defaultKind ?? "research");
  const [modelChoice, setModelChoice] = usePersistentState("ensemble.assign.model", "");
  const [engine, setEngine] = usePersistentState<"ensemble" | "claude-code">("ensemble.assign.engine", "ensemble");
  const [claudeModel, setClaudeModel] = useState("");
  const [effort, setEffort] = useState<Effort>("default");
  const [instructions, setInstructions] = useState("");
  const [place, setPlace] = useState<Place>("fresh");
  const [repo, setRepo] = useState("");
  const [continueFrom, setContinueFrom] = useState("");
  const [folder, setFolder] = useState("");
  const [folderCheck, setFolderCheck] = useState<{ ok: boolean; text: string; git?: boolean } | null>(null);
  const [branchMode, setBranchMode] = useState<"as-is" | "existing" | "new">("as-is");
  const [branch, setBranch] = useState("");
  const [delivery, setDelivery] = usePersistentState<"local" | "commit" | "push">("ensemble.assign.delivery", "local");
  const [askFirst, setAskFirst] = useState(true);
  const [credentials, setCredentials] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [network, setNetwork] = useState(true);
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
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: open && kind === "code" });
  const checkouts = useQuery({ queryKey: ["checkouts"], queryFn: api.checkouts, enabled: open && kind === "code" });
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, enabled: open });
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: open, refetchInterval: open ? 15_000 : false });
  const selectedDevice = (computers.data?.devices ?? []).find((device) => device.id === runOn) ?? null;
  const deviceAcceptsWeb = (selectedDevice?.capabilities as { acceptWebApprovals?: unknown } | null)?.acceptWebApprovals !== false;
  // In a space shared with you, the agent runs on your own computers only (they are the only ones listed).
  const access = useSpaceAccess();
  const serverRunner = !access.guest && (computers.data?.serverRunner ?? board.data?.serverRunner) !== false;
  useEffect(() => {
    if (!open || !computers.data) return;
    if ((!computers.data.serverRunner || access.guest) && runOn === "server") setRunOn(computers.data.devices[0]?.id ?? "server");
  }, [open, computers.data, runOn, access.guest]);
  const branchSource = place === "folder" && folderCheck?.ok && folderCheck.git ? folder : place === "fresh" && repo.startsWith("/") ? repo : "";
  const branches = useQuery({ queryKey: ["branches", branchSource], queryFn: () => api.branches(branchSource), enabled: open && Boolean(branchSource) });

  const orchestration = settings.data?.settings.orchestration;
  const savedProfiles = settings.data?.settings.runProfiles ?? [];
  const quick = useMemo(() => quickProfile(orchestration), [orchestration]);
  const profiles = profileChoices(savedProfiles, quick);
  const defaultChoice = defaultProfile(savedProfiles, settings.data?.settings.defaultRunProfileId, quick);
  const trustedFolders = useQuery({ queryKey: ["workspace-trust"], queryFn: api.trustedFolders, enabled: open && kind === "code" });

  const fields: ProfileFields = {
    kind,
    deviceId: runOn === "server" ? null : runOn,
    engine: kind === "code" ? engine : "ensemble",
    model: kind === "code" && engine === "claude-code" ? claudeModel : modelChoice,
    effort,
    branchMode: branchMode === "new" ? "new" : "as-is",
    delivery,
    askBeforePublish: askFirst,
    mode,
    sandbox,
    useCredentials: credentials,
    network,
    markDone,
    maxMinutes: maxMinutes === "" ? null : maxMinutes,
    maxToolCalls: maxToolCalls === "" ? null : maxToolCalls,
    maxTurns: maxTurns === "" ? null : maxTurns,
    instructions,
  };

  const applyProfile = (profile: RunProfile) => {
    setProfileId(profile.id);
    setKind(defaultKind && profile.id === defaultChoice.id ? defaultKind : profile.kind);
    if (profile.deviceId && (computers.data?.devices ?? []).some((device) => device.id === profile.deviceId)) setRunOn(profile.deviceId);
    setEngine(profile.engine ?? "ensemble");
    if (profile.engine === "claude-code") setClaudeModel(profile.model);
    else setModelChoice(profile.model);
    setEffort(profile.effort);
    setBranchMode(profile.branchMode);
    setDelivery(profile.delivery);
    setAskFirst(profile.askBeforePublish);
    setMode(profile.mode);
    setSandbox(profile.sandbox);
    setCredentials(profile.useCredentials);
    setNetwork(profile.network);
    setMarkDone(profile.markDone);
    setMaxMinutes(profile.maxMinutes ?? "");
    setMaxToolCalls(profile.maxToolCalls ?? "");
    setMaxTurns(profile.maxTurns ?? "");
    setInstructions(profile.instructions);
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

  const ahead = (board.data?.queued.length ?? 0) + (board.data?.running.length ?? 0);
  const slots = board.data?.maxConcurrent ?? settings.data?.settings.orchestration.maxConcurrentJobs ?? 3;
  const startsNow = (board.data?.running.length ?? 0) < slots && !board.data?.paused;

  // The Ensemble workspace is always trusted. A folder outside it is trusted by a saved rule or the choice below.
  const root = board.data?.root ?? "";
  const underRoot = (path: string) => Boolean(root) && (path === root || path.startsWith(`${root}/`));
  const savedTrust = (path: string) => (trustedFolders.data?.folders ?? []).some((row) => path === row.path || path.startsWith(`${row.path}/`));
  const continueFolder = (checkouts.data?.checkouts ?? []).find((row) => row.jobId === continueFrom)?.folder ?? "";
  const folderTrusted =
    selectedDevice !== null ||
    place === "fresh" ||
    (place === "continue" && (!continueFolder || underRoot(continueFolder) || savedTrust(continueFolder))) ||
    (place === "folder" && (trustChoice !== "none" || (Boolean(folderCheck?.ok) && savedTrust(folder))));
  const needsTrust = kind === "code" && mode !== "ask" && !folderTrusted;
  const unattendedNoSandbox = kind === "code" && mode === "unattended" && askOnly && !selectedDevice;
  const invalid =
    !taskId ||
    needsTrust ||
    unattendedNoSandbox ||
    (kind === "code" && !selectedDevice && place === "folder" && !folderCheck?.ok) ||
    (kind === "code" && selectedDevice && place === "folder" && !folderLabel) ||
    (kind === "code" && selectedDevice && place === "fresh" && !repo.trim()) ||
    (kind === "code" && place === "continue" && !continueFrom) ||
    (kind === "code" && branchMode !== "as-is" && !branch.trim()) ||
    (kind === "code" && !serverRunner && !selectedDevice);

  const limitValue = (value: number | "", key: keyof typeof LIMITS) => (value === "" ? undefined : Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, value)));

  const assign = useMutation({
    mutationFn: () => {
      const claude = kind === "code" && engine === "claude-code";
      const input: AssignInput = {
        taskId,
        kind,
        instructions,
        ...(claude ? { engine: "claude-code" as const, ...(claudeModel ? { model: claudeModel } : {}) } : model ? { provider, model } : {}),
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
          delivery,
          askBeforePublish: mode === "unattended" ? false : askFirst,
          branchMode,
          branch: branchMode === "as-is" ? undefined : branch.trim(),
          ...(place === "fresh" && repo.trim() ? { repoUrl: repo.trim() } : {}),
          ...(place === "continue" ? { continueFromJobId: continueFrom } : {}),
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

  const summary = useMemo(() => {
    if (kind === "research") return "Reads the web and papers, writes into the task page. Nothing runs on your computer.";
    const where = place === "folder" ? (selectedDevice ? `${folderLabel || "a folder"} on ${selectedDevice.name}` : "your folder") : place === "continue" ? "the earlier task's folder" : "its own checkout";
    const git = delivery === "local" ? "no commit or push" : delivery === "commit" ? "may commit" : "may commit and push";
    const asks = delivery !== "local" && askFirst && mode !== "unattended" ? " (asks before each commit)" : "";
    const modeLabel = mode === "review" ? " · Review only" : mode === "unattended" ? " · Run unattended" : "";
    const box = selectedDevice
      ? `On ${selectedDevice.name}${deviceSandbox?.osSandbox === false ? ", no sandbox" : sandbox ? ", sandboxed" : ", unsandboxed"}`
      : !osSandbox
        ? "No sandbox here"
        : sandbox
          ? "Sandboxed"
          : "Unsandboxed";
    const who = engine === "claude-code" ? "Claude Code · " : "";
    return `${who}${box} · works in ${where}${modeLabel} · ${git}${asks}${credentials && !selectedDevice ? " · git sign-in stays in the app" : ""}`;
  }, [kind, place, delivery, sandbox, askFirst, credentials, mode, osSandbox, selectedDevice, folderLabel, engine, deviceSandbox]);

  const candidates = (tasks.data?.tasks ?? []).filter((row) => !["done", "dropped"].includes(row.status));
  const trustTip = selectedDevice ? undefined : "Trust this folder first. Review only and Run unattended run commands without asking.";

  return (
    <Dialog open={open} onClose={onClose} title="Assign to agent" width={640}>
      <div className="space-y-5 text-[13px]">
        {fixedTaskId ? (
          <div className="-mt-1 truncate text-[14px] font-semibold">{task.data?.task.title ?? "…"}</div>
        ) : (
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)} className="field w-full">
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
          onDefault={(id) => saveProfiles.mutate({ defaultRunProfileId: id }, { onSuccess: () => toast("Quick assign uses this profile now.", { tone: "ok" }) })}
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

        <div>
          <Label tip="A task for a computer waits until Ensemble is running there. It does not run on the server instead.">Run on</Label>
          <div className="space-y-1.5">
            {serverRunner ? (
              <button type="button" onClick={() => setRunOn("server")} className={cx("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", runOn === "server" ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong")}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="font-medium">This server</span>
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
              This is {access.owner?.split(" ")[0] ?? "someone"}'s space, so the agent runs on one of your computers. They see that it runs on your computer, never which one,
              and they can follow its log. Only you can answer its questions or stop it.
            </p>
          ) : null}
        </div>

        {kind === "code" ? (
          <div>
            <Label tip="Ensemble's agent calls a model with your key. Claude Code runs your own Claude Code on the computer, signed in with your own Claude account; Ensemble never sees that sign-in. Either way the same mode, trust, sandbox and git rules apply, and its questions come to Needs me.">
              Who does the work
            </Label>
            <Segmented
              value={engine}
              onChange={setEngine}
              options={[
                { id: "ensemble", label: "Ensemble agent" },
                { id: "claude-code", label: "Claude Code (your sign-in)" },
              ]}
            />
          </div>
        ) : null}

        {kind === "code" && engine === "claude-code" ? (
          <div>
            <Label tip="Claude Code's own model names. Its default follows your Claude plan.">Model</Label>
            <select value={claudeModel} onChange={(event) => setClaudeModel(event.target.value)} className="field w-full">
              <option value="">Claude Code default</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
        ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_170px] gap-3">
          <div>
            <Label tip="By default the task's complexity picks the model from Settings → Models. Pick another here for this attempt only.">Model</Label>
            <select value={modelChoice} onChange={(event) => setModelChoice(event.target.value)} className="field w-full">
              <option value="">
                Task tier: {TIER_LABEL[complexity]} · {tier ? `${PROVIDER_LABEL[tier.provider] ?? tier.provider} ${tier.model}` : "…"}
              </option>
              {chatProviders.map((row) => (
                <optgroup key={row.provider} label={PROVIDER_LABEL[row.provider] ?? row.provider}>
                  {row.cheapest && row.models.includes(row.cheapest) ? (
                    <option value={`${row.provider}::${row.cheapest}`}>{row.cheapest} · cheapest</option>
                  ) : null}
                  {row.models
                    .filter((name) => name !== row.cheapest)
                    .slice(0, 40)
                    .map((name) => (
                      <option key={name} value={`${row.provider}::${name}`}>
                        {name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <Label tip="Only some models accept this. Others ignore it.">Thinking</Label>
            <select value={effort} onChange={(event) => setEffort(event.target.value as Effort)} className="field w-full">
              <option value="default">{model ? "Provider default" : `Tier default${tier?.effort ? ` (${tier.effort})` : ""}`}</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
        )}

        {kind === "code" ? (
          <>
            <div>
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
              <div className="mt-2">
                {place === "fresh" ? (
                  <>
                    <div className="flex gap-2">
                      <input
                        list="assign-repos"
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
                    <select value={continueFrom} onChange={(event) => setContinueFrom(event.target.value)} className="field w-full">
                      <option value="">Choose an earlier task…</option>
                      {(checkouts.data?.checkouts ?? []).map((row) => (
                        <option key={row.jobId} value={row.jobId}>
                          {row.title} · {["queued", "running", "waiting_approval"].includes(row.status) ? "not finished yet, waits for it" : row.branch || row.status}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[12px] text-muted">Same folder, uncommitted work included. Chain steps like change → analyse → commit; each waits for the one before.</div>
                  </>
                ) : selectedDevice ? (
                  <>
                    <select value={folderLabel} onChange={(event) => setFolderLabel(event.target.value)} className="field w-full">
                      <option value="">Choose a folder {computerName(selectedDevice?.name)} has shared…</option>
                      {selectedDevice.folders.map((label) => (
                        <option key={label} value={label}>{label}</option>
                      ))}
                    </select>
                    <div className="mt-1 text-[12px] text-muted">Only names {computerName(selectedDevice?.name)} already published (`ensemble folders add`). A path typed here is refused.</div>
                  </>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <input
                        value={folder}
                        onChange={(event) => {
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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label tip="As is: the branch checked out now. Existing: a branch that already exists. New: a branch created first.">
                  <GitBranch size={13} /> Branch
                </Label>
                <Segmented
                  value={branchMode}
                  onChange={setBranchMode}
                  options={[
                    { id: "as-is", label: "As is" },
                    { id: "existing", label: "Existing", disabled: Boolean(selectedDevice), title: selectedDevice ? `A task for ${selectedDevice.name} works on its own run branch for now.` : undefined },
                    { id: "new", label: "New", disabled: Boolean(selectedDevice), title: selectedDevice ? `A task for ${selectedDevice.name} works on its own run branch for now.` : undefined },
                  ]}
                />
                {branchMode !== "as-is" ? (
                  <>
                    <input list="assign-branches" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={branchMode === "new" ? "ensemble/fix-tests" : "feature/x"} className="field mt-2 w-full font-mono text-[12.5px]" />
                    <datalist id="assign-branches">
                      {(branches.data?.branches ?? []).map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </>
                ) : null}
              </div>
              <div>
                <Label tip="Enforced on every git call and on commits any script makes, and stated to the model. A refused git step goes back to the model as an error, so the run continues without it. The agent never force-pushes, deletes branches, or changes git config and remotes.">Git permissions</Label>
                <Segmented value={delivery} onChange={setDelivery} options={[{ id: "local", label: "Local only" }, { id: "commit", label: "Commit" }, { id: "push", label: "Commit + push" }]} />
                {delivery !== "local" ? (
                  <label className={cx("mt-2 flex items-center gap-2 text-[12.5px]", mode === "unattended" ? "text-faint" : "text-muted")} title={mode === "unattended" ? "Nobody approves in an unattended run." : undefined}>
                    <input type="checkbox" checked={askFirst && mode !== "unattended"} disabled={mode === "unattended"} onChange={(event) => setAskFirst(event.target.checked)} />
                    Ask me on Needs me before each commit
                  </label>
                ) : null}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-line bg-raised p-3">
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
                    <Toggle checked={network} onChange={setNetwork} label="Internet access" />
                  </div>
                  <SettingRow title="Push to this task's own branch" description={`Set on ${selectedDevice.name}, for repos that computer trusts.`}>
                    <RunBranchStatus on={selectedDevice.runBranchPush} device={selectedDevice.name} />
                  </SettingRow>
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
                      <InfoTip text="Ensemble uses your GitHub sign-in to clone, fetch, and fast-forward this run's own branch. The token stays in the app. The agent never sees it. Without it the run cannot push to a remote." />
                    </div>
                    <Toggle checked={credentials} onChange={setCredentials} label="Use my git sign-in" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="pl-[22px] font-medium">Internet access</span>
                    <Toggle checked={network} onChange={setNetwork} label="Internet access" />
                  </div>
                  {delivery === "push" && !credentials && place !== "folder" ? (
                    <div className="text-[12px] text-muted">Pushing to a remote needs “Use my git sign-in”.</div>
                  ) : null}
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

        <div className="flex items-center justify-between">
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
            <div>
              {selectedDevice
                ? `Runs on ${selectedDevice.name}, not on the server. It waits there until Ensemble is running.`
                : board.data?.paused
                  ? "The agent is paused. It will queue until you resume."
                  : startsNow
                    ? `Starts now · up to ${slots} run at once`
                    : `Queued behind ${ahead} · up to ${slots} run at once`}
            </div>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={invalid || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending ? <Spinner size={12} /> : null} Assign
          </button>
        </div>
      </div>
    </Dialog>
  );
}
