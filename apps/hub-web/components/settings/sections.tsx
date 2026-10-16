"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import { SHORTCUTS, formatBinding } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";
import { isApplePlatform } from "@/lib/platform";
import { plural, relative } from "@/lib/format";
import { useToast } from "../toast";
import { TERMINAL_DESKTOP_BODY, TERMINAL_DESKTOP_TITLE, useDesktopShell } from "../code/terminal-desktop-note";
import { currentTerminalAccess } from "../code/terminal-address";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { InfoTip, SectionCard, SettingRow, Spinner, Tag, Toggle, cx } from "../ui";
import { confirmAction } from "@/components/ask-dialog";
import { isEmailAddress, timeZoneName } from "@ensemble/shared-types";
import { sameTimeZone, timeZoneLabel, timeZoneOptions } from "@/lib/time-zones";
import { NumberField } from "./number-field";
import { askNotificationPermission, notificationNote, readNotificationState, refreshNotificationPermission, showNotification, type NotificationState } from "./reminders";

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
          <NumberField label="Daily high-risk write limit" min={0} max={500} value={orchestration.dailyHighRiskLimit} onChange={(dailyHighRiskLimit) => set({ dailyHighRiskLimit })} />
        </SettingRow>
        <SettingRow
          title="Network for sandboxed commands"
          description="Commands the model runs in a sandbox can reach the network, so it can read a PR, call an API or fetch a page. The sandbox still limits what they can change on this computer. Off is safer when a task reads untrusted input."
        >
          <Toggle label="Sandbox network" checked={orchestration.sandboxNetwork} onChange={(sandboxNetwork) => set({ sandboxNetwork })} />
        </SettingRow>
        <SettingRow
          title="Run commands in the Ensemble workspace without asking"
          description="The workspace folder is trusted on this device. Commands inside it run without an Allow prompt. A folder you have not trusted asks before each command, unless you pick Review only, which asks only when the agent wants more access. Run unattended only works in a trusted folder, and a path outside that folder is blocked."
        >
          <Toggle label="Run without asking" checked={orchestration.runWithoutAsking} onChange={(runWithoutAsking) => set({ runWithoutAsking })} />
        </SettingRow>
        <TrustSharingRow />

      </div>
    </SectionCard>
  );
}

/** On this computer only: folders trusted here are trusted in the person's other AI tools too. */
function TrustSharingRow() {
  const client = useQueryClient();
  const sharing = useQuery({ queryKey: ["trust-sharing"], queryFn: api.trustSharing });
  const toggle = useMutation({
    mutationFn: api.setTrustSharing,
    onSuccess: (data) => client.setQueryData(["trust-sharing"], data),
  });
  if (!sharing.data?.available) return null;
  const found = sharing.data.tools.filter((tool) => tool.found).map((tool) => tool.name);
  return (
    <SettingRow
      title="Trust folders in your other AI tools too"
      description={`A folder you trust here is also trusted in ${found.length ? found.join(", ") : "Claude Code, Codex, GitHub Copilot CLI, Cursor and Gemini CLI"} on this computer, in their apps and their command lines, so they do not ask again. Untrusting it here removes only what Ensemble added. Off removes all of it.`}
    >
      <Toggle label="Share folder trust" checked={sharing.data.enabled} onChange={(enabled) => toggle.mutate(enabled)} />
    </SettingRow>
  );
}

export function OrchestrationSection({ settings, patch }: Props) {
  const orchestration = settings.orchestration;
  const set = (value: Partial<Settings["orchestration"]>) => patch({ orchestration: value });
  const number = (key: "maxConcurrentJobs" | "maxTurns" | "maxMinutes", min: number, max: number) => (
    <NumberField
      label={{ maxConcurrentJobs: "Tasks that run at once", maxTurns: "Model turns per task", maxMinutes: "Minutes per task" }[key]}
      min={min}
      max={max}
      value={orchestration[key]}
      onChange={(value) => set({ [key]: value })}
    />
  );
  return (
    <SectionCard title="Orchestration" description="Tasks start in assignment order. Tasks sharing a project, repository or folder wait their turn. After a Needs me request waits an hour, one extra task can start; the queue then waits until fewer than your limit remain.">
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
        <SettingRow title="Sandbox by default" description="New code tasks start with this computer's own sandbox on: files change only inside the work folder, keys and browser data cannot be read, Ensemble's own API cannot be reached. You can turn it off per task.">
          <Toggle label="Sandbox by default" checked={orchestration.defaultExecution === "sandbox"} onChange={(on) => set({ defaultExecution: on ? "sandbox" : "native" })} />
        </SettingRow>
        <SettingRow title="Internet for agent commands by default" description="Needed to clone, install packages or read the web. Turn it off for tasks whose inputs you do not trust.">
          <Toggle label="Sandbox network" checked={orchestration.sandboxNetwork} onChange={(sandboxNetwork) => set({ sandboxNetwork })} />
        </SettingRow>
        <SettingRow
          title="Outside the work folder, in sandboxed tasks"
          description="Read only lets the agent read your other folders (never keys or browser data) and asks before it writes there; when nobody is there to answer, a write is refused and the task carries on. Read and write lets it change them too. No access keeps it inside the work folder. Tasks without the sandbox are not affected. You can change it per task."
        >
          <select
            aria-label="Outside the work folder"
            value={orchestration.outsideAccess}
            onChange={(event) => set({ outsideAccess: event.target.value as Settings["orchestration"]["outsideAccess"] })}
            className="field"
          >
            <option value="read">Read only</option>
            <option value="read-write">Read and write</option>
            <option value="none">No access</option>
          </select>
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

// ── quiet hours ────────────────────────────────────────────────────────────

export function QuietHoursSection({ settings, patch }: Props) {
  return (
    <SectionCard title="Quiet hours" description="Notifications hold until morning. Nothing is lost, the digest carries it over.">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <Toggle label="Quiet hours" checked={settings.quietHours.enabled} onChange={(enabled) => patch({ quietHours: { enabled } })} />
        <span className="text-muted">From</span>
        <input type="time" aria-label="Quiet hours start" value={settings.quietHours.from} onChange={(event) => patch({ quietHours: { from: event.target.value } })} className="field [color-scheme:dark]" />
        <span className="text-muted">until</span>
        <input type="time" aria-label="Quiet hours end" value={settings.quietHours.until} onChange={(event) => patch({ quietHours: { until: event.target.value } })} className="field [color-scheme:dark]" />
      </div>
    </SectionCard>
  );
}

export { ModelsSection } from "./models";
export { AssistantSection } from "./assistant";
export { FetchSection } from "./fetching";

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
        <div className="flex flex-wrap items-center gap-3">
          Keep finished tasks on the Context graph for
          <NumberField label="Context review days" min={0} max={365} unit="days" width="w-16" value={settings.contextReviewDays} onChange={(contextReviewDays) => patch({ contextReviewDays })} />
        </div>
        <p className="text-[12.5px] text-muted">Zero hides them until All completed is ticked on the graph. Open Completed or Trash below to see their history.</p>
        <div className="flex flex-wrap items-center gap-3">
          Undo history
          <NumberField label="Undo depth" min={3} max={20} unit="actions" width="w-16" value={settings.undoDepth} onChange={(undoDepth) => patch({ undoDepth })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          Keep the audit log and status history
          <NumberField label="History retention" min={30} max={365} unit="days" value={settings.historyRetentionDays} onChange={(historyRetentionDays) => patch({ historyRetentionDays })} />
        </div>
      </div>
      <p className="mt-2 text-[12.5px] text-muted">
        Deleted items stay in Trash until the trash window. Completed tasks and deliverables stay visible, then move to Trash after their own window. Undo keeps the last few actions (3–20, default 5) and is never unlimited. The audit log and status history use their own clock, separate from Trash, default 90 days. Active work is never purged. Before older completed work moves to Trash, Ensemble gives at least a day’s notice and uses your High model to learn personal skills. If learning fails, the work stays in Completed.
      </p>
    </SectionCard>
  );
}

export function RemindersSection({ settings, patch }: Props) {
  const desktop = useDesktopShell();
  const toast = useToast();
  const [permission, setPermission] = useState<NotificationState>(() => readNotificationState());
  useEffect(() => {
    void refreshNotificationPermission().then(setPermission);
    // Allowing or blocking from the address bar while this page is open updates the note.
    let status: PermissionStatus | null = null;
    const update = () => setPermission(readNotificationState());
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        status = result;
        result.addEventListener("change", update);
      })
      .catch(() => undefined);
    return () => status?.removeEventListener("change", update);
  }, []);
  const test = () => void showNotification("Ensemble", "Reminders will appear like this.");
  const enable = async () => {
    const result = await askNotificationPermission();
    setPermission(result);
    if (result !== "granted") return;
    patch({ desktopReminders: true });
    test();
  };
  // The setting is per account; whether this browser may show it is not. Off here unless both say yes.
  const on = settings.desktopReminders && permission === "granted";
  const blocked = permission === "denied" || permission === "unsupported";
  return (
    <SectionCard
      title={desktop ? "App notifications" : "Browser notifications"}
      info="Uses this platform’s notification permissions and focus settings."
      description={desktop ? "Native reminders while the Ensemble app is running." : "Reminders while an Ensemble tab is open in this browser."}
    >
      <SettingRow title="Show reminders as desktop notifications" description={notificationNote(permission)}>
        <Toggle label="Desktop reminders" checked={on} disabled={blocked} onChange={(next) => (next ? void enable() : patch({ desktopReminders: false }))} />
      </SettingRow>
      {settings.desktopReminders && blocked ? (
        <p role="alert" className="mb-2 text-[12.5px] text-danger">
          Reminders are switched on for your account, but this device can&apos;t show them.{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => patch({ desktopReminders: false })}>
            Switch them off
          </button>
        </p>
      ) : null}
      {permission === "granted" ? (
        <button type="button" className="btn" onClick={() => (on ? test() : void enable())}>
          {on ? "Send a test notification" : "Turn on and send a test"}
        </button>
      ) : permission === "default" ? (
        <button type="button" className="btn" onClick={() => void enable()}>
          Allow notifications
        </button>
      ) : permission === "denied" ? (
        <button type="button" className="btn" onClick={() => {
          void refreshNotificationPermission().then((now) => {
          setPermission(now);
          if (now === "denied") toast(desktop ? "Allow Ensemble notifications in your system settings." : "Allow notifications in the site settings, then reload this page.", { tone: "error" });
          });
        }}>
          Check again
        </button>
      ) : null}
    </SectionCard>
  );
}

/**
 * On Ensemble on the web: the passkeys that unlock the terminal on your paired computers (Code tab).
 * Removing one needs the terminal unlocked, like on the computer.
 */
function WebPasskeys() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["terminal-status", "web"], queryFn: api.webTerminalStatus });
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: api.webTerminalRemovePasskey,
    onSuccess: () => client.invalidateQueries({ queryKey: ["terminal-status"] }),
    onError: (failure) => setError((failure as Error).message),
  });
  const unlock = useMutation({
    mutationFn: async () => {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const options = await api.webTerminalUnlockOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      await api.webTerminalUnlockVerify(response);
    },
    onSuccess: () => { setError(null); void client.invalidateQueries({ queryKey: ["terminal-status"] }); },
    onError: (failure) => setError((failure as Error).message),
  });
  const keys = status.data?.passkeys ?? [];
  return (
    <div className="mb-3 rounded-md border border-line bg-panel px-3 py-2 text-[12.5px]" data-testid="web-terminal-passkeys">
      <div className="font-medium">Passkeys for the terminal on your computers</div>
      <p className="mt-0.5 text-muted">
        The terminal on a paired computer opens from the Code tab after you unlock it with one of these (Touch ID, Windows Hello, your phone or a security key). It locks after 30 minutes idle, 8 hours at most. Each computer decides whether the web may open it (Settings → this computer there, or <code className="font-mono">ensemble web terminal on|off</code>).
      </p>
      <div className="mt-1.5 space-y-1">
        {status.isLoading ? null : keys.length === 0 ? (
          <div className="text-muted">None yet. Open the terminal on a computer in the Code tab to add one.</div>
        ) : (
          keys.map((key) => (
            <div key={key.id} className="group flex items-center gap-2">
              <span>{key.label || "Passkey"}</span>
              <span className="text-faint">added {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleString()}` : ""}</span>
              <button
                type="button"
                className="icon-btn h-6 w-6 shrink-0"
                aria-label={`Remove ${key.label || "passkey"}`}
                title={status.data?.unlocked ? "Remove" : "Unlock below to remove a passkey"}
                disabled={!status.data?.unlocked || remove.isPending}
                onClick={() => remove.mutate(key.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))
        )}
      </div>
      {keys.length > 0 && !status.data?.unlocked ? (
        <button type="button" className="btn mt-2" disabled={unlock.isPending} onClick={() => unlock.mutate()}>
          {unlock.isPending ? "Unlocking…" : "Unlock to manage passkeys"}
        </button>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p> : null}
      <p className="mt-1 text-[12px] text-muted">Every passkey added is recorded in the audit ledger. Remove any you do not recognise.</p>
    </div>
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
      ) : access && !access.ok && access.reason === "named-host" ? (
        <WebPasskeys />
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
                <button type="button" className="icon-btn h-6 w-6 shrink-0" onClick={() => patch({ terminal: { roots: terminal.roots.filter((value) => value !== root) } })}>
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
                    className="icon-btn h-6 w-6 shrink-0"
                    aria-label={`Remove ${key.label || "passkey"}`}
                title={status.data?.unlocked ? "Remove" : "Unlock below to remove a passkey"}
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
    <div data-jump-label="Folders Code can use" data-testid="code-folders" className="mb-1">
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
  const [email, setEmail] = useState(settings.email);
  const [left, setLeft] = useState(false);
  useEffect(() => setEmail(settings.email), [settings.email]);
  const emailError = left && !isEmailAddress(email) ? "Enter an email address like name@example.com." : null;
  const zones = useMemo(() => timeZoneOptions(settings.timezone), [settings.timezone]);
  const known = timeZoneName(settings.timezone);
  const device = typeof Intl === "undefined" ? null : timeZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return (
    <SectionCard title="Scheduling and confirmations" description="Your time zone sets scheduled tasks, the morning brief and quiet hours. The email below confirms sensitive workspace changes; it does not change your sign-in email.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="text-[13px] font-medium">
          <label htmlFor="settings-email">Email</label>
          <input
            id="settings-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              // Saved once it is a whole address; until then the last good one stays.
              if (isEmailAddress(event.target.value)) patch({ email: event.target.value.trim() });
            }}
            onBlur={() => setLeft(true)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "settings-email-error" : undefined}
            className="field mt-1.5 w-full"
          />
          {emailError ? (
            <span id="settings-email-error" role="alert" className="mt-1 block text-[12px] font-normal text-danger">
              {emailError}
            </span>
          ) : null}
        </div>
        <div className="text-[13px] font-medium">
          <label htmlFor="settings-timezone">Time zone</label>
          <select
            id="settings-timezone"
            value={known ?? settings.timezone}
            onChange={(event) => patch({ timezone: event.target.value })}
            aria-invalid={known ? undefined : true}
            aria-describedby={known ? undefined : "settings-timezone-error"}
            className="field mt-1.5 w-full"
          >
            {known ? null : <option value={settings.timezone}>{settings.timezone || "None"} (not a time zone)</option>}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabel(zone)}
              </option>
            ))}
          </select>
          {known ? null : (
            <span id="settings-timezone-error" role="alert" className="mt-1 block text-[12px] font-normal text-danger">
              Pick your time zone from the list.
            </span>
          )}
          {device && !sameTimeZone(device, known) ? (
            <button type="button" className="mt-1 block text-[12px] font-normal text-accent hover:underline" onClick={() => patch({ timezone: device })}>
              Use this computer&apos;s, {device.replace(/_/g, " ")}
            </button>
          ) : null}
        </div>
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
          <button type="button" className="btn" onClick={() => void confirmAction({ title: "Remove deleted items?", body: "Everything in deleted items is removed for good.", confirm: "Remove all", danger: true }).then((yes) => yes && empty.mutate())}>
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
      description="Context only removes ingested mail, chats, meetings and the context graph. Everything also removes your workspace content. Your account, sign-ins, devices, connected-app setup, model keys and settings stay. The audit ledger records the deletion. Stop active agent tasks first."
    >
      <select aria-label="Data deletion scope" disabled={remove.isPending} value={scope} onChange={(event) => setScope(event.target.value as "context" | "everything")} className="field w-full">
        <option value="context">Context only</option>
        <option value="everything">Everything (tasks, projects, skills, chats too)</option>
      </select>
      <div className="mt-3 text-[12.5px] text-muted">
        Type <span className="font-mono text-ink">{settings.email}</span> to confirm. This cannot be undone.
      </div>
      <input aria-label="Confirm data deletion with your email" disabled={remove.isPending} value={confirm} onChange={(event) => setConfirm(event.target.value)} className="field mt-1.5 w-full" />
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
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
        Untouched for
        <NumberField label="Days before a quiet nudge" min={1} max={180} unit="days" value={settings.staleNudge.untouchedDays} onChange={(untouchedDays) => patch({ staleNudge: { untouchedDays } })} />
      </div>
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
        The other shortcut is <span className="kbd">{other}</span>. Inside Ensemble you can also press C when you are not typing.
      </p>
    </SectionCard>
  );
}
