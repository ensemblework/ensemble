"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, Code2, FileText, FolderOpen, GitBranch, Lock, Monitor, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type AssignInput, type Complexity } from "@/lib/api";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { computerName, folderPlace, freshCloneHint, sandboxStay } from "@/lib/device-copy";
import { usePersistentState } from "@/lib/prefs";
import { useToast } from "../toast";
import { Dialog, InfoTip, SettingRow, Spinner, Toggle, cx } from "../ui";
import { RunBranchStatus } from "./run-branch-status";

type Kind = "research" | "code";
type Place = "fresh" | "continue" | "folder";
type Mode = "ask" | "review" | "unattended";

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

const TIER_LABEL: Record<Complexity, string> = { easy: "Low", medium: "Medium", high: "High", max: "Max" };

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cx("rounded px-2.5 py-1 text-[12.5px] transition-colors", value === option.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}
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
  const [effort, setEffort] = useState("default");
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
  const [accessMode, setAccessMode] = useState<"review" | "read-write">("read-write");
  const [trustChoice, setTrustChoice] = useState<"always" | "task" | "none">("none");
  const [unattended, setUnattended] = useState(false);
  const [markDone, setMarkDone] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [maxMinutes, setMaxMinutes] = useState<number | "">("");
  const [maxToolCalls, setMaxToolCalls] = useState<number | "">("");
  const [maxTurns, setMaxTurns] = useState<number | "">("");
  const [runOn, setRunOn] = useState("server");
  const [folderLabel, setFolderLabel] = useState("");

  useEffect(() => {
    if (open) {
      setTaskId(fixedTaskId ?? "");
      setInstructions("");
      setFolderCheck(null);
      if (defaultKind) setKind(defaultKind);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedTaskId]);

  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: open && !fixedTaskId });
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId), enabled: open && Boolean(taskId) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const catalog = useQuery({ queryKey: ["model-catalog"], queryFn: api.models, enabled: open, staleTime: 5 * 60_000 });
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: open && kind === "code" });
  const checkouts = useQuery({ queryKey: ["checkouts"], queryFn: api.checkouts, enabled: open && kind === "code" });
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, enabled: open });
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: open, refetchInterval: open ? 15_000 : false });
  const selectedDevice = (computers.data?.devices ?? []).find((device) => device.id === runOn) ?? null;
  const serverRunner = (computers.data?.serverRunner ?? board.data?.serverRunner) !== false;
  useEffect(() => {
    if (!open || !computers.data) return;
    if (!computers.data.serverRunner && runOn === "server") setRunOn(computers.data.devices[0]?.id ?? "server");
  }, [open, computers.data, runOn]);
  const branchSource = place === "folder" && folderCheck?.ok && folderCheck.git ? folder : place === "fresh" && repo.startsWith("/") ? repo : "";
  const branches = useQuery({ queryKey: ["branches", branchSource], queryFn: () => api.branches(branchSource), enabled: open && Boolean(branchSource) });

  const orchestration = settings.data?.settings.orchestration;
  const trustedFolders = useQuery({ queryKey: ["workspace-trust"], queryFn: api.trustedFolders, enabled: open && kind === "code" });
  useEffect(() => {
    if (!open || !orchestration) return;
    const outside = place === "folder";
    setSandbox(orchestration.defaultExecution !== "native");
    setNetwork(outside ? false : orchestration.sandboxNetwork);
    setAccessMode(outside ? "review" : "read-write");
    setTrustChoice("none");
    setUnattended(orchestration.defaultDelivery === "unattended" && !outside);
  }, [open, orchestration, place]);

  const complexity = (task.data?.task.complexity ?? "medium") as Complexity;
  const tier = settings.data?.settings.models[complexity];
  const chatProviders = (catalog.data?.providers ?? []).filter((row) => row.chat && row.available && row.models.length);
  const [provider, model] = modelChoice.includes("::") ? (modelChoice.split("::") as [string, string]) : ["", ""];

  const guard = useQuery({ queryKey: ["workspace-guard"], queryFn: api.workspaceGuard, enabled: open && kind === "code", staleTime: 5 * 60_000 });
  const strength = guard.data?.sandbox.strength ?? "strong";
  const osSandbox = strength === "strong";
  const askOnly = strength === "ask";
  const mode: Mode = unattended ? "unattended" : accessMode === "review" ? "review" : "ask";
  const setMode = (next: Mode) => {
    setUnattended(next === "unattended");
    setAccessMode(next === "review" ? "review" : "read-write");
  };

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
      setFolderCheck({ ok: true, git: result.git, text: result.git ? "Git repository" : "Not a git repository — changes will not be reviewable in Code" });
    },
    onError: (error) => setFolderCheck({ ok: false, text: (error as Error).message }),
  });

  const checkFolder = async (value: string) => {
    if (!value.trim()) return setFolderCheck(null);
    try {
      const result = await api.resolveFolder(value);
      setFolder(result.path);
      setFolderCheck({ ok: true, git: result.git, text: result.git ? `Git repository${result.branch ? ` · on ${result.branch}` : ""}` : "Not a git repository — changes will not be reviewable in Code" });
    } catch (error) {
      setFolderCheck({ ok: false, text: (error as Error).message });
    }
  };

  const ahead = (board.data?.queued.length ?? 0) + (board.data?.running.length ?? 0);
  const slots = board.data?.maxConcurrent ?? settings.data?.settings.orchestration.maxConcurrentJobs ?? 3;
  const startsNow = (board.data?.running.length ?? 0) < slots && !board.data?.paused;

  const savedTrust =
    place === "folder" &&
    Boolean(folderCheck?.ok) &&
    (trustedFolders.data?.folders ?? []).some((row) => folder === row.path || folder.startsWith(`${row.path}/`));
  const folderTrusted = place !== "folder" || trustChoice !== "none" || savedTrust;
  const reviewOnly = accessMode === "review";
  const unattendedBlocked = kind === "code" && unattended && (!folderTrusted || askOnly);
  const invalid =
    !taskId ||
    (!selectedDevice && unattendedBlocked) ||
    (kind === "code" && !selectedDevice && place === "folder" && !folderCheck?.ok) ||
    (kind === "code" && selectedDevice && place === "folder" && !folderLabel) ||
    (kind === "code" && selectedDevice && place === "fresh" && !repo.trim()) ||
    (kind === "code" && place === "continue" && !continueFrom) ||
    (kind === "code" && branchMode !== "as-is" && !branch.trim()) ||
    (kind === "code" && !serverRunner && !selectedDevice);

  const assign = useMutation({
    mutationFn: () => {
      const input: AssignInput = {
        taskId,
        kind,
        instructions,
        ...(model ? { provider, model } : {}),
        ...(effort !== "default" ? { reasoningEffort: effort } : {}),
        markDone,
        maxMinutes: maxMinutes || undefined,
        maxToolCalls: maxToolCalls || undefined,
        maxTurns: maxTurns || undefined,
        // Hint only. A paired computer enforces its own network setting.
        network,
      };
      if (kind === "code") {
        if (selectedDevice) {
          Object.assign(input, {
            sandbox,
            delivery,
            askBeforePublish: askFirst,
            useCredentials: false,
            branchMode,
            branch: branchMode === "as-is" ? undefined : branch.trim(),
            ...(place === "fresh" && repo.trim() ? { repoUrl: repo.trim() } : {}),
            ...(place === "continue" ? { continueFromJobId: continueFrom } : {}),
            ...(place === "folder" ? { folderLabel } : {}),
          });
        } else {
          Object.assign(input, {
            sandbox,
            network: reviewOnly ? false : network,
            delivery: reviewOnly ? "local" : delivery,
            askBeforePublish: askFirst,
            useCredentials: reviewOnly ? false : credentials,
            unattended,
            accessMode,
            ...(place === "folder" ? { trust: trustChoice } : {}),
            branchMode,
            branch: branchMode === "as-is" ? undefined : branch.trim(),
            ...(place === "fresh" && repo.trim() ? { repoUrl: repo.trim() } : {}),
            ...(place === "continue" ? { continueFromJobId: continueFrom } : {}),
            ...(place === "folder" ? { folder } : {}),
          });
        }
      }
      if (selectedDevice) input.deviceId = selectedDevice.id;
      return api.assign(input);
    },
    onSuccess: () => {
      toast(
        selectedDevice
          ? selectedDevice.online
            ? `Queued on ${selectedDevice.name}.`
            : `Queued until ${selectedDevice.name} is back.`
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
    if (selectedDevice && !selectedDevice.online) return `Queued until ${selectedDevice.name} is back.`;
    if (selectedDevice) return `Runs on ${selectedDevice.name}. ${sandboxStay(selectedDevice.name)}`;
    if (kind === "research") return "Reads the web and papers, writes into the task page. Nothing runs on your computer.";
    const where = place === "folder" ? "your folder" : place === "continue" ? "the earlier task's folder" : "its own checkout";
    const git = delivery === "local" ? "no commit or push" : delivery === "commit" ? "may commit" : "may commit and push";
    const mode = reviewOnly ? " · review only" : "";
    const alone = unattended ? " · run unattended" : "";
    const box = !osSandbox ? "Not fully sandboxed" : sandbox ? "Sandboxed" : "Unsandboxed";
    return `${box} · works in ${where}${mode} · ${git}${delivery !== "local" && askFirst && !reviewOnly ? " (asks you first)" : ""}${credentials && !reviewOnly ? " · git sign-in stays in the app" : ""}${alone}`;
  }, [kind, place, delivery, sandbox, askFirst, credentials, reviewOnly, unattended, osSandbox, selectedDevice]);

  const candidates = (tasks.data?.tasks ?? []).filter((row) => !["done", "dropped"].includes(row.status));

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
          <Label tip={selectedDevice ? `A task for ${selectedDevice.name} waits until it is open. It does not run on the server instead.` : "A task for your computer waits until that computer is open. It does not run on the server instead."}>Run on</Label>
          <div className="space-y-1.5">
            {serverRunner ? (
              <button type="button" onClick={() => setRunOn("server")} className={cx("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", runOn === "server" ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong")}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="font-medium">This server</span>
              </button>
            ) : null}
            {(computers.data?.devices ?? []).map((device) => (
              <button key={device.id} type="button" onClick={() => { setRunOn(device.id); setFolderLabel(""); }} className={cx("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", runOn === device.id ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-raised hover:border-line-strong")}>
                <span className={cx("h-2 w-2 shrink-0 rounded-full", device.online ? "bg-ok pulse-dot" : "bg-faint")} />
                <Monitor size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium">{device.name}</span>
                <span className="shrink-0 text-[12px] text-muted">{device.online ? "Online" : device.lastSeenAt ? `last seen ${new Date(device.lastSeenAt).toLocaleString()}` : "Not seen yet"}</span>
              </button>
            ))}
            {!serverRunner && !(computers.data?.devices.length) ? <div className="text-[12.5px] text-muted">Add a computer with the Ensemble CLI in Settings → Devices, or pair the desktop app. Code tasks run there.</div> : null}
          </div>
        </div>

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
            <select value={effort} onChange={(event) => setEffort(event.target.value)} className="field w-full">
              <option value="default">Provider default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>

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
                    <input
                      list="assign-repos"
                      value={repo}
                      onChange={(event) => setRepo(event.target.value)}
                      placeholder="https://github.com/owner/repo, owner/repo, or leave empty for an empty folder"
                      className="field w-full"
                    />
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
                          {row.title} · {["queued", "running", "waiting_approval"].includes(row.status) ? "not finished yet — waits for it" : row.branch || row.status}
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
                    <div className="mt-1 text-[12px] text-muted">Only names {computerName(selectedDevice?.name)} already published. A path typed here is refused.</div>
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
                <Label tip="Existing switches to a branch that already exists. New creates it first. As is changes nothing.">
                  <GitBranch size={13} /> Branch
                </Label>
                <Segmented value={branchMode} onChange={setBranchMode} options={[{ id: "as-is", label: "As is" }, { id: "existing", label: "Existing" }, { id: "new", label: "New" }]} />
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
                <Label tip="Enforced on every git call, not just asked for in the prompt. The agent is never allowed to force-push, delete branches, or change git config and remotes.">Git permissions</Label>
                <Segmented value={delivery} onChange={setDelivery} options={[{ id: "local", label: "Local only" }, { id: "commit", label: "Commit" }, { id: "push", label: "Commit + push" }]} />
                {delivery !== "local" ? (
                  <label className="mt-2 flex items-center gap-2 text-[12.5px] text-muted">
                    <input type="checkbox" checked={askFirst} onChange={(event) => setAskFirst(event.target.checked)} />
                    Ask me on Needs me before each {delivery === "push" ? "commit and push" : "commit"}
                  </label>
                ) : null}
              </div>
            </div>

            {selectedDevice ? (
              <div className="space-y-2 rounded-lg border border-line bg-raised p-3">
                <div className="text-[12.5px] text-muted">Change sandbox, trust, and unattended on {selectedDevice.name}. This page cannot grant them.</div>
                <SettingRow title="Push to this task's own branch" description={`Off unless you turn it on from ${selectedDevice.name}, and only in repos that computer already trusts.`}>
                  <RunBranchStatus on={selectedDevice.runBranchPush} device={selectedDevice.name} />
                </SettingRow>
              </div>
            ) : (
            <div className="space-y-2 rounded-lg border border-line bg-raised p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Mode</span>
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: "ask", label: "Ask" },
                    { id: "review", label: "Review only" },
                    { id: "unattended", label: "Run unattended" },
                  ]}
                />
              </div>
              <div className="text-[12px] text-muted" data-testid="assign-mode-help">
                {mode === "review"
                  ? osSandbox
                    ? "Read-only, no network. It asks only when the agent wants to write, use the network, or leave this folder."
                    : "Read-only, no network. Without an OS sandbox nothing stops a command from writing, so it asks before every command."
                  : mode === "unattended"
                    ? "No Allow prompts, inside a folder you have trusted. A path outside it is blocked, and it never pushes; you push from the review."
                    : askOnly
                      ? "Asks before every command and file change."
                      : "Asks before changes and commands unless the folder is trusted. A path outside the folder always asks."}
              </div>
              {osSandbox ? (
                <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={14} className={sandbox ? "text-ok" : "text-warn"} />
                    <span className="font-medium">Sandbox</span>
                    <InfoTip text="A macOS sandbox around every command: files can only change inside the work folder, keys and browser data cannot be read, and Ensemble's own API and database cannot be reached." />
                  </div>
                  <Toggle checked={sandbox} onChange={setSandbox} label="Sandbox" />
                </div>
              ) : (
                <div className="flex items-start gap-1.5 border-t border-line pt-2 text-[12px] text-warn" data-testid="not-sandboxed">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    <span className="font-medium">Not fully sandboxed on this {guard.data?.sandbox.os === "linux" ? "Linux" : guard.data?.sandbox.os === "win32" ? "Windows" : ""} computer.</span>{" "}
                    Commands run as you with Ensemble&apos;s allow-list and folder checks only; a script could still reach the rest of the computer.
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
                  <InfoTip text="Ensemble uses your GitHub sign-in to clone, fetch, and fast-forward this run's own branch. The token stays in the app. The agent never sees it." />
                </div>
                <Toggle checked={credentials} onChange={setCredentials} label="Use my git sign-in" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="pl-[22px] font-medium">Internet access</span>
                <Toggle checked={reviewOnly ? false : network} onChange={setNetwork} label="Internet access" />
              </div>
              {place === "folder" ? (
                <div className="space-y-2 border-t border-line pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">Trust this folder</span>
                    <Segmented
                      value={trustChoice}
                      onChange={setTrustChoice}
                      options={[
                        { id: "none", label: "Ask" },
                        { id: "task", label: "This task" },
                        { id: "always", label: "Always" },
                      ]}
                    />
                  </div>
                </div>
              ) : null}
              {unattendedBlocked ? (
                <div className="flex items-start gap-1.5 text-[12px] text-danger" role="alert">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {askOnly
                    ? "Run unattended needs an OS sandbox, and this computer runs agents in Ask mode. Choose Ask or Review only."
                    : "Run unattended can't be used with a folder you haven't trusted. Trust this folder, or turn off Run unattended."}
                </div>
              ) : null}
            </div>
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
              ["Max minutes", maxMinutes, setMaxMinutes, settings.data?.settings.orchestration.maxMinutes ?? 60],
              ["Max tool calls", maxToolCalls, setMaxToolCalls, 80],
              ["Max model turns", maxTurns, setMaxTurns, settings.data?.settings.orchestration.maxTurns ?? 40],
            ] as const).map(([label, value, set, fallback]) => (
              <label key={label} className="block">
                <span className="text-[12px] text-muted">{label}</span>
                <input
                  type="number"
                  min={1}
                  value={value}
                  placeholder={String(fallback)}
                  onChange={(event) => (set as (value: number | "") => void)(event.target.value ? Number(event.target.value) : "")}
                  className="field mt-1 w-full"
                />
              </label>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t border-line pt-3">
          <div className="min-w-0 flex-1 text-[12px] leading-4 text-muted">
            <div className="truncate">{summary}</div>
            <div>
              {selectedDevice
                ? selectedDevice.online
                  ? `Queued for ${selectedDevice.name}. It does not run on the server.`
                  : "It does not run on the server."
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
