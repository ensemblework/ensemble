"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AssistantToolArea, Settings } from "@ensemble/shared-types";
import { SHORTCUTS, formatBinding } from "@ensemble/shared-types";
import { api, type Complexity } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";
import { isApplePlatform } from "@/lib/platform";
import { clockLabel, dateTime, plural, relative } from "@/lib/format";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { TERMINAL_DESKTOP_BODY, TERMINAL_DESKTOP_TITLE, useDesktopShell } from "../code/terminal-desktop-note";
import { currentTerminalAccess } from "../code/terminal-address";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { InfoTip, SectionCard, SettingRow, Spinner, Tag, Toggle, cx } from "../ui";

export type Patch = (patch: Record<string, unknown>) => void;
type Props = { settings: Settings; patch: Patch };

// ── autonomy & orchestration ──────────────────────────────────────────────

export function AutonomySection({ settings, patch }: Props) {
  const orchestration = settings.orchestration;
  const set = (value: Partial<Settings["orchestration"]>) => patch({ orchestration: value });
  return (
    <SectionCard title="Autonomy" description="The default for newly delegated tasks. You can still choose per task when you delegate.">
      <select aria-label="Autonomy level" value={settings.autonomy} onChange={(event) => patch({ autonomy: event.target.value })} className="field w-full">
        <option value="assist">Assist, every external write needs your approval</option>
        <option value="supervised">Supervised, reversible writes proceed; sends need you</option>
        <option value="autonomous">Autonomous, writes proceed; everything still audited</option>
      </select>
      <p className="mt-1.5 text-[12px] text-muted">
        Policy still forces approval for anything leaving your domain or mentioning money, legal or HR matters, at every level.
      </p>
      <div className="mt-2 divide-y divide-[var(--line)]">
        <SettingRow title="Daily high-risk write limit" description="Beyond this, unattended sends fall back to asking you, the runaway brake.">
          <input
            aria-label="Daily high-risk write limit"
            type="number"
            min={0}
            max={500}
            value={orchestration.dailyHighRiskLimit}
            onChange={(event) => set({ dailyHighRiskLimit: Number(event.target.value) })}
            className="field w-20 text-right"
          />
        </SettingRow>
        <SettingRow
          title="Network for sandboxed commands"
          description="Commands the model runs in a sandbox can reach the network, so it can read a PR, call an API or fetch a page. The container is still read-only outside the checkout. Off is safer when a task reads untrusted input."
        >
          <Toggle label="Sandbox network" checked={orchestration.sandboxNetwork} onChange={(sandboxNetwork) => set({ sandboxNetwork })} />
        </SettingRow>
        <SettingRow
          title="Run commands in the Ensemble workspace without asking"
          description="The workspace folder is trusted on this device. Commands inside it run without an Allow prompt. A folder you have not trusted asks before each command, unless you pick Review only, which asks only when the agent wants more access. Run unattended only works in a trusted folder, and a path outside that folder is blocked."
        >
          <Toggle label="Run without asking" checked={orchestration.runWithoutAsking} onChange={(runWithoutAsking) => set({ runWithoutAsking })} />
        </SettingRow>
        <SettingRow title={<span className="flex items-center gap-1.5">Place new tasks by priority <InfoTip text="New tasks land above lower-priority ones on the board instead of at the bottom." /></span>}>
          <Toggle label="Place by priority" checked={orchestration.placeByPriority} onChange={(placeByPriority) => set({ placeByPriority })} />
        </SettingRow>
      </div>
    </SectionCard>
  );
}

export function OrchestrationSection({ settings, patch }: Props) {
  const orchestration = settings.orchestration;
  const set = (value: Partial<Settings["orchestration"]>) => patch({ orchestration: value });
  const number = (key: "maxConcurrentJobs" | "maxTurns" | "maxMinutes", min: number, max: number) => (
    <input
      aria-label={{ maxConcurrentJobs: "Tasks that run at once", maxTurns: "Model turns per task", maxMinutes: "Minutes per task" }[key]}
      type="number"
      min={min}
      max={max}
      value={orchestration[key]}
      onChange={(event) => set({ [key]: Math.min(max, Math.max(min, Number(event.target.value))) })}
      className="field w-20 text-right"
    />
  );
  return (
    <SectionCard title="Orchestration" description="How many agent tasks run at once, and the limits each one gets. The rest wait in the Workspace queue.">
      <div className="divide-y divide-[var(--line)]">
        <SettingRow title="Tasks that run at once" description="Independent tasks run in parallel. Tasks sharing a project, repository or folder wait their turn.">
          {number("maxConcurrentJobs", 1, 8)}
        </SettingRow>
        <SettingRow title="Model turns per task" description="A task that reaches this stops and keeps its progress. You can raise it per task when you assign.">
          {number("maxTurns", 5, 200)}
        </SettingRow>
        <SettingRow title="Minutes per task" description="A task that takes longer is stopped; its folder and partial work are kept.">
          {number("maxMinutes", 5, 480)}
        </SettingRow>
        <SettingRow title="Sandbox by default" description="New code tasks start with the macOS sandbox on: files change only inside the work folder, keys and browser data cannot be read, Ensemble's own API cannot be reached. You can turn it off per task.">
          <Toggle label="Sandbox by default" checked={orchestration.defaultExecution === "sandbox"} onChange={(on) => set({ defaultExecution: on ? "sandbox" : "native" })} />
        </SettingRow>
        <SettingRow title="Internet for agent commands by default" description="Needed to clone, install packages or read the web. Turn it off for tasks whose inputs you do not trust.">
          <Toggle label="Sandbox network" checked={orchestration.sandboxNetwork} onChange={(sandboxNetwork) => set({ sandboxNetwork })} />
        </SettingRow>
      </div>
    </SectionCard>
  );
}

export function PromptsSection() {
  const [open, setOpen] = useState(false);
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: api.prompts, enabled: open });
  return (
    <SectionCard title="Prompts" description="Every instruction Ensemble sends to a model on your behalf, what each one is for, and when it is sent. Worth a look before you trust an agent with a repository.">
      <button type="button" className="text-[13px] text-accent underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
        {open ? "Hide prompts" : "Open prompts"}
      </button>
      {open ? (
        prompts.isLoading ? (
          <Spinner />
        ) : (
          <div className="mt-3 divide-y divide-[var(--line)]">
            {prompts.data?.prompts.map((prompt) => (
              <div key={prompt.id} className="py-2.5 text-[13px]">
                <div className="flex items-center gap-2 font-medium">
                  {prompt.title} <span className="font-mono text-[11px] text-faint">{prompt.id}</span>
                </div>
                <div className="text-muted">
                  <span className="text-ink/80">When:</span> {prompt.when}
                </div>
                <div className="text-muted">{prompt.purpose}</div>
                {prompt.body ? <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-raised p-2 font-sans text-[12.5px] leading-5 text-ink/90">{prompt.body}</pre> : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </SectionCard>
  );
}

// ── models ─────────────────────────────────────────────────────────────────

const TIERS: Array<{ id: Complexity; label: string; hint: string }> = [
  { id: "easy", label: "Low model", hint: "Replies, triage, small edits." },
  { id: "medium", label: "Medium model", hint: "Most delegated tasks." },
  { id: "high", label: "High model", hint: "Refactors, investigations, multi-file changes." },
  { id: "max", label: "Max model", hint: "Architecture, migrations and skill mining. Slowest, best." },
];

// ── assistant ─────────────────────────────────────────────────────────────

const AREAS: Array<{ id: AssistantToolArea; label: string }> = [
  { id: "tasks", label: "Tasks and pages" },
  { id: "projects", label: "Projects and deliverables" },
  { id: "context", label: "People, repos and context" },
  { id: "skills", label: "Skills" },
  { id: "reminders", label: "Reminders" },
  { id: "runs", label: "Runs" },
];

function WatcherList() {
  const client = useQueryClient();
  const toast = useToast();
  const watchers = useQuery({ queryKey: ["watchers"], queryFn: api.watchers });
  const cancel = useMutation({
    mutationFn: api.cancelWatcher,
    onSuccess: () => {
      toast("Watcher cancelled.");
      void client.invalidateQueries({ queryKey: ["watchers"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const rows = watchers.data?.watchers ?? [];
  return (
    <div className="mt-3">
      <div className="text-[13px] font-medium">Watchers</div>
      <div className="mt-1 text-[12.5px] text-muted">Conditions Ensemble is watching. Cancel one here or where you created it.</div>
      {watchers.isLoading && !watchers.data ? (
        <div className="mt-2 h-4 w-40 rounded bg-line" aria-hidden />
      ) : rows.length === 0 ? (
        <div className="mt-2 text-[12.5px] text-muted">No watchers yet.</div>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{row.message}</span>
              <span className="text-[12px] text-muted">{row.status}</span>
              {row.status === "active" ? (
                <button type="button" className="btn h-7 px-2 text-[12px]" onClick={() => cancel.mutate(row.id)}>
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AssistantSection({ settings, patch }: Props) {
  const assistant = settings.assistant;
  return (
    <SectionCard title="The assistant" description="The chat in the corner can change your board, projects, deliverables, context and skills. This decides whether it does so as it works, or asks you first.">
      <SettingRow title="When it wants to change something" description="Preview shows what it wants to change and waits for you to press Apply in the chat.">
        <select aria-label="Write policy" value={assistant.writePolicy} onChange={(event) => patch({ assistant: { writePolicy: event.target.value } })} className="field">
          <option value="preview">Show me a preview first</option>
          <option value="immediate">Just do it (undoable)</option>
          <option value="needs-me">Queue it on Needs me</option>
        </select>
      </SettingRow>
      <SettingRow title="Act as" description="Changes tone and suggested actions. It does not change what Ensemble can read or change.">
        <select aria-label="Act as" value={assistant.actAs ?? "general"} onChange={(event) => patch({ assistant: { actAs: event.target.value } })} className="field">
          <option value="general">General</option>
          <option value="student">Student</option>
          <option value="engineer">Engineer</option>
          <option value="teacher">Teacher</option>
          <option value="lawyer">Lawyer</option>
        </select>
      </SettingRow>
      <WatcherList />
      <SettingRow title="Default model preset">
        <select aria-label="Default complexity" value={assistant.defaultTier} onChange={(event) => patch({ assistant: { defaultTier: event.target.value } })} className="field">
          {TIERS.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.label.replace(" model", "")} · {settings.models[tier.id].model}
            </option>
          ))}
        </select>
      </SettingRow>
      <div className="mt-2 text-[13px] font-medium">What it may change</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {AREAS.map((area) => {
          const on = assistant.allowedWriteAreas.includes(area.id);
          return (
            <label key={area.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={on}
                onChange={() =>
                  patch({
                    assistant: {
                      allowedWriteAreas: on ? assistant.allowedWriteAreas.filter((value) => value !== area.id) : [...assistant.allowedWriteAreas, area.id],
                    },
                  })
                }
                className="accent-[rgb(var(--accent-rgb))]"
              />
              {area.label}
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        This covers your own data, which can always be undone from the app bar. Anything that leaves the building, sending mail, opening a pull request, posting to chat, keeps its own approval gate whatever this is set to.
      </p>
    </SectionCard>
  );
}

// ── fetch schedule & quiet hours ───────────────────────────────────────────

export function FetchSection({ settings, patch }: Props) {
  const client = useQueryClient();
  const toast = useToast();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const fetchNow = useMutation({
    mutationFn: api.fetchNow,
    onSuccess: (result) => {
      toast(result.message ?? `Fetched ${plural(result.results.length, "source")}.`);
      void client.invalidateQueries();
    },
  });
  const fetch = settings.fetch;
  const nextFetch = (() => {
    if (!fetch.scheduled || !fetch.times.length) return null;
    const now = new Date();
    for (let day = 0; day < 2; day += 1) {
      for (const time of [...fetch.times].sort()) {
        const [h, m] = time.split(":").map(Number);
        const candidate = new Date(now);
        candidate.setDate(now.getDate() + day);
        candidate.setHours(h!, m!, 0, 0);
        if (candidate > now) return candidate;
      }
    }
    return null;
  })();
  return (
    <SectionCard
      title="When Ensemble fetches"
      description="Twice a day, and whenever you press the button. Ensemble does not watch your mailbox or calendar in the background."
      actions={
        <button type="button" className="btn-primary" onClick={() => fetchNow.mutate()} disabled={fetchNow.isPending}>
          <FetchGlyph active={fetchNow.isPending} size={12} /> Fetch now
        </button>
      }
    >
      <SettingRow title="Scheduled fetching" description={nextFetch ? `Next fetch ${dateTime(nextFetch)}` : "Off, fetch only when you press the button."}>
        <Toggle label="Scheduled fetch" checked={fetch.scheduled} onChange={(scheduled) => patch({ fetch: { scheduled } })} />
      </SettingRow>
      <SettingRow title="Times" description={`Your local time (${settings.timezone}). Morning between ${clockLabel("08:00")} and ${clockLabel("10:00")}, afternoon between ${clockLabel("15:00")} and ${clockLabel("17:00")}, is what most days want.`}>
        <div className="flex items-center gap-2">
          {fetch.times.map((time, index) => (
            <span key={index} className="flex items-center gap-1">
              <input
                type="time"
                aria-label={`Fetch time ${index + 1}`}
                value={time}
                onChange={(event) => patch({ fetch: { times: fetch.times.map((value, i) => (i === index ? event.target.value : value)) } })}
                className="field [color-scheme:dark]"
              />
              {fetch.times.length > 1 ? (
                <button type="button" className="icon-btn h-6 w-6" onClick={() => patch({ fetch: { times: fetch.times.filter((_, i) => i !== index) } })}>
                  <X size={12} />
                </button>
              ) : null}
            </span>
          ))}
          {fetch.times.length < 4 ? (
            <button type="button" className="btn-ghost" onClick={() => patch({ fetch: { times: [...fetch.times, "12:00"] } })}>
              + time
            </button>
          ) : null}
        </div>
      </SettingRow>
      <SettingRow title="Look back" description="How far back the first fetch after a gap reads.">
        <select aria-label="Fetch look-back days" value={fetch.lookbackDays} onChange={(event) => patch({ fetch: { lookbackDays: Number(event.target.value) } })} className="field">
          {[1, 2, 3, 7, 14, 30].map((days) => (
            <option key={days} value={days}>
              {days} day{days === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Propose todos from what was read" description="New items that need you become proposed todos on Today. Off means context only.">
        <Toggle label="Propose todos" checked={fetch.proposeTodos} onChange={(proposeTodos) => patch({ fetch: { proposeTodos } })} />
      </SettingRow>
      <div className="mt-2 text-[12.5px] text-muted">Last fetch: {connections.data?.lastFetch ? dateTime(connections.data.lastFetch) : "never"}</div>
    </SectionCard>
  );
}

export function QuietHoursSection({ settings, patch }: Props) {
  return (
    <SectionCard title="Quiet hours" description="Notifications hold until morning. Nothing is lost, the digest carries it over.">
      <div className="flex items-center gap-4 text-[13px]">
        <Toggle label="Quiet hours" checked={settings.quietHours.enabled} onChange={(enabled) => patch({ quietHours: { enabled } })} />
        <span className="text-muted">From</span>
        <input type="time" aria-label="Quiet hours start" value={settings.quietHours.from} onChange={(event) => patch({ quietHours: { from: event.target.value } })} className="field [color-scheme:dark]" />
        <span className="text-muted">until</span>
        <input type="time" aria-label="Quiet hours end" value={settings.quietHours.until} onChange={(event) => patch({ quietHours: { until: event.target.value } })} className="field [color-scheme:dark]" />
      </div>
    </SectionCard>
  );
}

export { ConnectionsSection, ModelsSection } from "./setup";

// ── retention, reminders, terminal ─────────────────────────────────────────

export function RetentionSection({ settings, patch }: Props) {
  const trash = [30, 60, 90].includes(settings.retentionDays) ? settings.retentionDays : 30;
  const completed = [30, 60, 90].includes(settings.completedRetentionDays) ? settings.completedRetentionDays : 60;
  return (
    <SectionCard title="Data retention" info="Two clocks. Trash and completed work are purged on different schedules, and a missed night is caught up the next time Ensemble starts.">
      <div className="space-y-3 text-[13.5px]">
        <label className="flex items-center gap-3">
          Keep items in Trash for
          <select
            aria-label="Trash retention"
            value={trash}
            onChange={(event) => patch({ retentionDays: Number(event.target.value) })}
            className="field"
          >
            {[30, 60, 90].map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3">
          Purge completed items after
          <select
            aria-label="Completed retention"
            value={completed}
            onChange={(event) => patch({ completedRetentionDays: Number(event.target.value) })}
            className="field"
          >
            {[30, 60, 90].map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
          unless pinned
        </label>
        <label className="flex items-center gap-3">
          Show recently completed
          <select
            aria-label="Completed visible count"
            value={settings.completedVisible}
            onChange={(event) => patch({ completedVisible: Number(event.target.value) })}
            className="field"
          >
            {[3, 5, 8, 10, 15, 20].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
          on the board
        </label>
        <label className="flex items-center gap-3">
          Keep finished tasks on the Context graph for
          <input
            type="number"
            min={0}
            max={365}
            aria-label="Context review days"
            value={settings.contextReviewDays}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 0 && value <= 365) patch({ contextReviewDays: value });
            }}
            className="field w-16"
          />
          days
        </label>
        <p className="text-[12.5px] text-muted">Zero hides them until All completed is ticked on the graph. Completed and Trash live further down this page.</p>
        <label className="flex items-center gap-3">
          Undo history
          <input
            type="number"
            min={3}
            max={20}
            aria-label="Undo depth"
            value={settings.undoDepth}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 3 && value <= 20) patch({ undoDepth: value });
            }}
            className="field w-16"
          />
          actions
        </label>
        <label className="flex items-center gap-3">
          Keep the audit log and status history
          <input
            type="number"
            min={30}
            max={365}
            aria-label="History retention"
            value={settings.historyRetentionDays}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 30 && value <= 365) patch({ historyRetentionDays: value });
            }}
            className="field w-20"
          />
          days
        </label>
      </div>
      <p className="mt-2 text-[12.5px] text-muted">
        Deleted items stay in Trash until the trash window. Completed tasks and deliverables stay visible, then move to Trash after their own window. Undo keeps the last few actions (3–20, default 5) and is never unlimited. The audit log and status history use their own clock, separate from Trash, default 90 days. Active work is never purged.
      </p>
    </SectionCard>
  );
}

export function RemindersSection({ settings, patch }: Props) {
  const toast = useToast();
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  return (
    <SectionCard
      title="Desktop reminders"
      info="Uses your browser's notifications. Your OS focus and notification settings still apply."
      description="Reminders pop up on this computer while a Ensemble tab is open."
    >
      <SettingRow title="Show reminders as desktop notifications" description={`Browser permission: ${permission}`}>
        <Toggle label="Desktop reminders" checked={settings.desktopReminders} onChange={(desktopReminders) => patch({ desktopReminders })} />
      </SettingRow>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          if (typeof Notification === "undefined") return toast("This browser does not support notifications.", { tone: "error" });
          const result = await Notification.requestPermission();
          setPermission(result);
          if (result === "granted") new Notification("Ensemble", { body: "Reminders will appear like this." });
        }}
      >
        Set up desktop reminders
      </button>
    </SectionCard>
  );
}

export function TerminalSection({ settings, patch }: Props) {
  const client = useQueryClient();
  const codeOn = useModuleOn("code");
  const [folder, setFolder] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const terminal = settings.terminal;
  const desktop = useDesktopShell();
  // The same rule as the Code tab's terminal (terminal.tsx): the desktop note first, then this page's address.
  // Read only after mount (desktop is null until then), so the static export and first render match.
  const access = desktop === false ? currentTerminalAccess() : null;
  const usable = access?.ok === true;
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: codeOn });
  const status = useQuery({ queryKey: ["terminal-status"], queryFn: api.terminalStatus, enabled: codeOn && usable });
  const removeKey = useMutation({
    mutationFn: api.terminalRemovePasskey,
    onSuccess: () => client.invalidateQueries({ queryKey: ["terminal-status"] }),
    onError: (error) => setFolderError((error as Error).message),
  });
  const addFolder = async () => {
    setFolderError(null);
    try {
      const resolved = await api.resolveFolder(folder.trim());
      patch({ terminal: { roots: [...new Set([...terminal.roots, resolved.path])] } });
      setFolder("");
    } catch (error) {
      setFolderError((error as Error).message);
    }
  };
  if (!codeOn) return null;
  return (
    <SectionCard title="Terminal and commits" info="The terminal in the Code tab is for you only: it opens with Touch ID, runs an allow-list of commands one at a time, and every command runs in the macOS sandbox, confined to the folder it is in.">
      {desktop ? (
        <div role="note" data-testid="terminal-desktop-note" className="mb-3 rounded-md border border-warn/50 bg-panel px-3 py-2 text-[12.5px]">
          <div className="font-medium">{TERMINAL_DESKTOP_TITLE}</div>
          <div className="mt-0.5 text-muted">{TERMINAL_DESKTOP_BODY}</div>
        </div>
      ) : access && !access.ok ? (
        <div role="note" data-testid="terminal-address-note" data-reason={access.reason} className="mb-3 rounded-md border border-warn/50 bg-panel px-3 py-2 text-[12.5px] text-muted">
          {access.message}
        </div>
      ) : null}
      <CodeFolders settings={settings} patch={patch} workspace={repos.data?.roots[0]} desktop={desktop === true} />
      {usable ? (
        <SettingRow title="Terminal on">
          <Toggle label="Terminal" checked={terminal.enabled} onChange={(enabled) => patch({ terminal: { enabled } })} />
        </SettingRow>
      ) : null}
      {usable ? (
        <>
          <div className="mt-4 text-[13px] font-medium">Folders the terminal can use</div>
          <div className="mt-1.5 space-y-1 font-mono text-[12px]">
            <div>
              {repos.data?.roots[0] ?? "Ensemble workspace"} <span className="font-sans text-faint">(always)</span>
            </div>
            {terminal.roots.map((root) => (
              <div key={root} className="group flex items-center gap-2">
                {root}
                <button type="button" className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100" onClick={() => patch({ terminal: { roots: terminal.roots.filter((value) => value !== root) } })}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input aria-label="Terminal folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/Users/you/another-folder" className="field flex-1 font-mono text-[12.5px]" />
            <button type="button" className="btn" disabled={!folder.trim()} onClick={() => void addFolder()}>
              Allow folder
            </button>
          </div>
          {folderError ? <p className="mt-1 text-[12px] text-danger">{folderError}</p> : null}
          <p className="mt-1 text-[12px] text-muted">
            Everything inside a folder is reachable; nothing above it. System folders, your home folder itself, ~/Library, key folders and Ensemble&apos;s own code are always refused.
          </p>
          <div className="mt-4 text-[13px] font-medium">Touch ID passkeys</div>
          <div className="mt-1.5 space-y-1 text-[12.5px]">
            {(status.data?.passkeys ?? []).length === 0 ? (
              <div className="text-muted">None yet. Open the terminal in the Code tab to set one up.</div>
            ) : (
              status.data!.passkeys.map((key) => (
                <div key={key.id} className="group flex items-center gap-2">
                  <span>{key.label || "Passkey"}</span>
                  <span className="text-faint">added {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleString()}` : ""}</span>
                  <button
                    type="button"
                    className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100"
                    title={status.data?.unlocked ? "Remove" : "Unlock the terminal first to remove a passkey"}
                    disabled={!status.data?.unlocked}
                    onClick={() => removeKey.mutate(key.id)}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))
            )}
            <p className="text-[12px] text-muted">Every passkey added is recorded in the audit ledger. Remove any you do not recognise.</p>
          </div>
        </>
      ) : null}
      <div className="mt-3 divide-y divide-[var(--line)]">
        <SettingRow title="Branch prefix for agent work">
          <input aria-label="Branch prefix" value={terminal.branchPrefix} onChange={(event) => patch({ terminal: { branchPrefix: event.target.value } })} className="field w-40 font-mono text-[12.5px]" />
        </SettingRow>
        <SettingRow title="Commit author" description="“Name <email>”. Empty uses your git config.">
          <input aria-label="Commit author" value={terminal.commitAuthor} onChange={(event) => patch({ terminal: { commitAuthor: event.target.value } })} placeholder="Ada Lovelace <ada@example.com>" className="field w-64" />
        </SettingRow>
        <SettingRow title="Sign commits" description="Passes -S to git commit. Requires a signing key in your git config.">
          <Toggle label="Sign commits" checked={terminal.signCommits} onChange={(signCommits) => patch({ terminal: { signCommits } })} />
        </SettingRow>
        <SettingRow title="Keep reviewed code on this device" description="Faster reopening of old reviews. Capped at 150 MB, cleared as reviews expire.">
          <Toggle label="Keep review cache" checked={terminal.keepReviewCache} onChange={(keepReviewCache) => patch({ terminal: { keepReviewCache } })} />
        </SettingRow>
      </div>
    </SectionCard>
  );
}

/**
 * "Folders Code can use" (settings.code.roots): what the Code tab lists and
 * reviews. Shown wherever the Code tab works, desktop and every web address,
 * separately from the terminal's folders, which only show where the terminal
 * can open. hub-api checks every added folder (resolveCodeFolder) again when
 * Settings saves.
 */
function CodeFolders({ settings, patch, workspace, desktop }: Props & { workspace?: string; desktop: boolean }) {
  const client = useQueryClient();
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roots = settings.code?.roots ?? [];
  const save = (next: string[]) => {
    patch({ code: { roots: next } });
    // Settings saves after a short pause; refresh the Code tab's list after that.
    window.setTimeout(() => void client.invalidateQueries({ queryKey: ["code-repos"] }), 1200);
  };
  const add = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      const resolved = await api.resolveCodeFolder(path.trim());
      save([...new Set([...roots, resolved.path])]);
      setFolder("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    setError(null);
    try {
      const picked = await pickFolderNative("Choose a folder Code can use");
      if (picked === undefined) setError("There is no folder picker here. Type the folder's path instead.");
      else if (picked) await add(picked);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <div data-testid="code-folders" className="mb-1">
      <div className="text-[13px] font-medium">Folders Code can use</div>
      <p className="mt-0.5 text-[12px] text-muted">The Code tab lists and reviews git checkouts in these folders. The terminal keeps its own list.</p>
      <div className="mt-1.5 space-y-1 font-mono text-[12px]">
        <div>
          {workspace ?? "Ensemble workspace"} <span className="font-sans text-faint">(always)</span>
        </div>
        {roots.map((root) => (
          <div key={root} className="group flex items-center gap-2" data-testid="code-folder">
            {root}
            <button type="button" aria-label={`Remove ${root}`} className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => save(roots.filter((value) => value !== root))}>
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {desktop ? (
          <button type="button" className="btn" data-testid="code-folder-choose" disabled={busy} onClick={() => void choose()}>
            Choose folder…
          </button>
        ) : null}
        <input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && folder.trim()) void add(folder);
          }}
          placeholder="/Users/you/projects"
          aria-label="Folder path for Code"
          className="field flex-1 font-mono text-[12.5px]"
        />
        <button type="button" className="btn" disabled={busy || !folder.trim()} onClick={() => void add(folder)}>
          Add folder
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <p className="mt-1 text-[12px] text-muted">
        System folders, your home folder itself, dotfiles and dot-folders in it, paths with “..”, and links that lead somewhere unsafe are refused.
      </p>
    </div>
  );
}

export function IdentitySection({ settings, patch }: Props) {
  return (
    <SectionCard title="You" description="Used for scheduling, quiet hours and to confirm destructive actions.">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[13px] font-medium">
          Email
          <input value={settings.email} onChange={(event) => patch({ email: event.target.value })} className="field mt-1.5 w-full" />
        </label>
        <label className="text-[13px] font-medium">
          Time zone
          <input value={settings.timezone} onChange={(event) => patch({ timezone: event.target.value })} className="field mt-1.5 w-full" />
        </label>
      </div>
    </SectionCard>
  );
}

// ── failures, deleted items, delete my data ────────────────────────────────

export function FailedJobsSection() {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const failed = (connections.data?.connections ?? []).filter((row) => row.enabled && row.lastError);
  return (
    <SectionCard title="Failed jobs" info="Syncs and background jobs that gave up after retrying.">
      {failed.length === 0 ? (
        <div className="flex items-center gap-2 text-[13px]">
          Nothing failed permanently. <Tag tone="green">clear</Tag>
        </div>
      ) : (
        failed.map((row) => (
          <div key={row.id} className="py-1 text-[13px]">
            <span className="font-medium">{row.label}:</span> <span className="text-muted">{row.lastError}</span>
          </div>
        ))
      )}
    </SectionCard>
  );
}

export function DeletedSection() {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const deleted = useQuery({ queryKey: ["deleted"], queryFn: api.deleted, enabled: open });
  const restore = useMutation({
    mutationFn: api.restoreDeleted,
    onSuccess: (result) => {
      toast(`Restored ${plural(result.restored, "item")}.`, { tone: "ok" });
      void client.invalidateQueries();
    },
  });
  const empty = useMutation({
    mutationFn: api.emptyDeleted,
    onSuccess: (result) => {
      toast(`Permanently removed ${plural(result.removed, "item")}.`);
      void client.invalidateQueries({ queryKey: ["deleted"] });
    },
  });
  return (
    <SectionCard
      title="Deleted items"
      actions={
        <>
          <button type="button" className="btn" onClick={() => restore.mutate({})}>
            <RotateCcw size={12} /> Restore all
          </button>
          <button type="button" className="btn" onClick={() => window.confirm("Permanently remove everything in deleted items?") && empty.mutate()}>
            <Trash2 size={12} /> Empty now
          </button>
        </>
      }
    >
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[13px] text-accent hover:underline">
        <ChevronRight size={13} className={cx("transition-transform", open && "rotate-90")} />
        View deleted items here, or open <Link href="/trash" className="underline">Trash</Link>
      </button>
      {open ? (
        deleted.isLoading ? (
          <Spinner />
        ) : (deleted.data?.items ?? []).length === 0 ? (
          <div className="mt-2 text-[13px] text-muted">Nothing deleted.</div>
        ) : (
          <div className="mt-2 divide-y divide-[var(--line)]">
            {deleted.data!.items.map((item) => (
              <div key={`${item.kind}-${item.id}`} className="flex items-center justify-between py-1.5 text-[13px]">
                <span>
                  <Tag tone="gray">{item.kind}</Tag> {item.label}
                </span>
                <span className="flex items-center gap-2 text-[12px] text-muted">
                  {relative(item.deletedAt)}
                  <button type="button" className="btn-ghost py-0" onClick={() => restore.mutate({ kind: item.kind, id: item.id })}>
                    Restore
                  </button>
                </span>
              </div>
            ))}
          </div>
        )
      ) : null}
    </SectionCard>
  );
}

export function DeleteDataSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const client = useQueryClient();
  const [scope, setScope] = useState<"context" | "everything">("context");
  const [confirm, setConfirm] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteMyData(scope, confirm),
    onSuccess: () => {
      toast(scope === "context" ? "Context deleted." : "Everything deleted.");
      setConfirm("");
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <SectionCard
      title="Delete my data"
      description="Removes ingested mail, chats, meetings and the context graph. The audit ledger records that you deleted, and nothing about what was deleted, removing the evidence of a deletion would defeat the point of an audit trail."
    >
      <select aria-label="Data deletion scope" value={scope} onChange={(event) => setScope(event.target.value as "context" | "everything")} className="field w-full">
        <option value="context">Context only</option>
        <option value="everything">Everything (tasks, projects, skills, chats too)</option>
      </select>
      <div className="mt-3 text-[12.5px] text-muted">
        Type <span className="font-mono text-ink">{settings.email}</span> to confirm. This cannot be undone.
      </div>
      <input aria-label="Confirm data deletion with your email" value={confirm} onChange={(event) => setConfirm(event.target.value)} className="field mt-1.5 w-full" />
      <button
        type="button"
        className="btn mt-3 border-danger/60 text-[#ffb4ae]"
        disabled={confirm.trim().toLowerCase() !== settings.email.toLowerCase() || remove.isPending}
        onClick={() => remove.mutate()}
      >
        Delete {scope === "context" ? "context" : "everything"}
      </button>
    </SectionCard>
  );
}

export function MorningBriefSection({ settings, patch }: Props) {
  return (
    <SectionCard
      title="Morning brief"
      description="A note inside Ensemble at the time you pick. It reuses today's focus, proposals, meetings, and deliverables. It never sends email."
    >
      <SettingRow title="Deliver the morning brief" description="Shows in the bell and on Today.">
        <Toggle
          label="Morning brief"
          checked={settings.morningBrief.enabled}
          onChange={(enabled) => patch({ morningBrief: { enabled } })}
        />
      </SettingRow>
      <label className="mt-3 flex items-center gap-3 text-[13px]">
        Time
        <input
          type="time"
          aria-label="Morning brief time"
          value={settings.morningBrief.time}
          onChange={(event) => {
            const value = event.target.value.slice(0, 5);
            if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) patch({ morningBrief: { time: value } });
          }}
          className="field"
        />
      </label>
    </SectionCard>
  );
}

export function StaleSection({ settings, patch }: Props) {
  return (
    <SectionCard
      title="Quiet nudges"
      description="Items left alone, and due items that were never started, ask if they are still relevant. Keep, snooze, done, or Trash."
    >
      <SettingRow title="Ask when work goes quiet">
        <Toggle label="Quiet nudges" checked={settings.staleNudge.enabled} onChange={(enabled) => patch({ staleNudge: { enabled } })} />
      </SettingRow>
      <label className="mt-3 flex items-center gap-3 text-[13px]">
        Untouched for
        <input
          type="number"
          min={1}
          max={180}
          aria-label="Days before a quiet nudge"
          value={settings.staleNudge.untouchedDays}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (value >= 1 && value <= 180) patch({ staleNudge: { untouchedDays: value } });
          }}
          className="field w-20"
        />
        days
      </label>
    </SectionCard>
  );
}

export function QuickCaptureSection() {
  const capture = SHORTCUTS.find((binding) => binding.id === "capture");
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApplePlatform()), []);
  const chord = capture ? formatBinding(capture, apple) : "";
  const other = capture ? formatBinding(capture, !apple) : "";
  return (
    <SectionCard
      title="Quick capture"
      description="Type a reminder from anywhere. The Hub tab listens for the shortcut. A small desktop companion does the same when Ensemble is in the background."
    >
      <p className="text-[13px]">
        This computer: <span className="kbd">{chord}</span>
      </p>
      <p className="mt-2 text-[12.5px] text-muted">
        The other shortcut is <span className="kbd">{other}</span>. Inside Ensemble you can also press C when you are not typing. The companion and why it exists are in docs/20_QUICK_CAPTURE.md.
      </p>
    </SectionCard>
  );
}
