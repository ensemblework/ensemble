/**
 * The app's pure logic: slash commands, the Tasks list (grouped: needs you, running, queued,
 * stopped, done), and the answers a waiting request offers. No terminal here, so it is tested
 * directly.
 */
import type { RunProfile } from "@ensemble/shared-types";
import type { Decision, JobCard, Workspace } from "./local.js";

// ── slash commands ──────────────────────────────────────────────────────────────────────────

export type Command = { name: string; args?: string; description: string; aliases?: string[]; tab?: "tasks" | "chat" };

export const COMMANDS: readonly Command[] = [
  { name: "tasks", description: "Agent runs, and what needs you" },
  { name: "chat", description: "Chat with your agent" },
  { name: "new", description: "Start a new chat", tab: "chat" },
  { name: "run", args: "<what to do>", description: "Start your agent on it as a task, in this folder, with your run profile" },
  { name: "allow", args: "[once|task|always]", description: "Allow what the selected run is asking", tab: "tasks" },
  { name: "deny", args: "[reason]", description: "Deny what the selected run is asking", tab: "tasks" },
  { name: "answer", args: "<text>", description: "Answer the selected question in your own words", tab: "tasks" },
  { name: "stop", description: "Stop the selected run, or the reply being written" },
  { name: "retry", description: "Run the selected task again", tab: "tasks" },
  { name: "profile", args: "[name]", description: "Run profile: mode, git, sandbox, internet" },
  { name: "agent", args: "[name]", description: "Who you work with: Claude Code, Codex, Cursor (your sign-in) or Ensemble agent" },
  { name: "model", args: "[model]", description: "Your agent's model" },
  { name: "folder", description: "The folder your agent works in" },
  { name: "trust", description: "Trust this folder (Review only and Run unattended need it)" },
  { name: "keys", args: "[provider]", description: "Add a model key on this computer" },
  { name: "sandbox", description: "This computer's sandbox, and set it up" },
  { name: "hooks", description: "Send Claude, Codex, Copilot and Cursor prompts to Needs me" },
  { name: "login", description: "Sign in, so tasks from ensemblework.com run here" },
  { name: "logout", description: "Sign out and unpair this computer" },
  { name: "runner", args: "[install|uninstall]", description: "Start Ensemble at login, or stop doing that" },
  { name: "status", description: "Account, runtime, sandbox and keys" },
  { name: "sidebar", description: "Show or hide the sidebar (Ctrl+B)" },
  { name: "help", description: "Keys and commands" },
  { name: "exit", aliases: ["quit", "q"], description: "Leave; Ensemble keeps running tasks in the background" },
];

/** Commands whose name starts with what was typed after the slash, best first. */
export function matchCommands(typed: string, tab: "tasks" | "chat"): Command[] {
  const word = typed.replace(/^\//, "").split(/\s/)[0]!.toLowerCase();
  const all = COMMANDS.filter((command) => [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(word)));
  // This tab's own commands first.
  return [...all.filter((command) => !command.tab || command.tab === tab), ...all.filter((command) => command.tab && command.tab !== tab)];
}

export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const typed = match[1]!.toLowerCase();
  const command = COMMANDS.find((item) => item.name === typed || item.aliases?.includes(typed));
  return { name: command?.name ?? typed, args: match[2]!.trim() };
}

// ── the Tasks list ──────────────────────────────────────────────────────────────────────────

export type Group = "needs" | "running" | "queued" | "stopped" | "done";

export const GROUP_LABEL: Record<Group, string> = { needs: "Needs you", running: "Running", queued: "Queued", stopped: "Stopped", done: "Done" };

export type Item = { key: string; group: Group; job: JobCard | null; decision: Decision | null };

/** Runs and requests, grouped; a run waiting on a question is under "Needs you" with it. */
export function buildItems(workspace: Workspace | null, decisions: readonly Decision[]): Item[] {
  const items: Item[] = [];
  const asked = new Map<string, Decision>();
  for (const decision of decisions) if (decision.detail?.jobId && decision.status === "pending") asked.set(decision.detail.jobId, decision);
  const jobs = workspace ? [...workspace.waiting, ...workspace.running, ...workspace.queued, ...workspace.stopped, ...workspace.completed] : [];
  const seen = new Set<string>();
  const push = (group: Group, job: JobCard | null, decision: Decision | null) => {
    const key = job ? `job:${job.id}` : `decision:${decision!.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, group, job, decision });
  };
  for (const job of jobs) if (asked.has(job.id) || job.status === "waiting_approval") push("needs", job, asked.get(job.id) ?? null);
  // A request from an editor or an app hand-off, not tied to a run here.
  for (const decision of decisions) if (decision.status === "pending" && !(decision.detail?.jobId && jobs.some((job) => job.id === decision.detail.jobId))) push("needs", null, decision);
  for (const job of workspace?.running ?? []) push("running", job, null);
  for (const job of workspace?.queued ?? []) push("queued", job, null);
  for (const job of workspace?.stopped ?? []) push("stopped", job, null);
  for (const job of workspace?.completed ?? []) push("done", job, null);
  return items;
}

// ── answering ───────────────────────────────────────────────────────────────────────────────

export type Answer = { decision: "allow" | "deny"; scope?: "once" | "session" | "always"; reason?: string };
export type Action = { id: string; label: string; answer: Answer; tone: "primary" | "normal" | "danger"; recommended?: boolean };

/** The buttons a waiting request shows: its own options, or allow once / for this task / always / deny. */
export function decisionActions(decision: Decision): Action[] {
  const options = decision.detail?.options ?? [];
  if (options.length) {
    const recommended = decision.detail.recommended ?? null;
    const actions: Action[] = options.map((option, index) => ({
      id: `option-${index}`,
      label: option,
      answer: { decision: "allow", reason: option },
      tone: option === recommended ? "primary" : "normal",
      recommended: option === recommended,
    }));
    if (decision.event === "question") actions.push({ id: "skip", label: "Skip", answer: { decision: "deny" }, tone: "danger" });
    return actions;
  }
  const actions: Action[] = [
    { id: "once", label: "Allow once", answer: { decision: "allow", scope: "once" }, tone: "primary" },
    { id: "session", label: "Allow for this task", answer: { decision: "allow", scope: "session" }, tone: "normal" },
  ];
  // A path outside the folder is never turned into a standing rule.
  if (decision.toolName !== "outside") actions.push({ id: "always", label: "Always", answer: { decision: "allow", scope: "always" }, tone: "normal" });
  actions.push({ id: "deny", label: "Deny", answer: { decision: "deny" }, tone: "danger" });
  return actions;
}

/** What `/allow [once|task|always]` or `/deny [reason]` means for this request. */
export function commandAnswer(decision: Decision, name: "allow" | "deny" | "answer", args: string): Answer | string {
  if (name === "deny") return { decision: "deny", ...(args ? { reason: args } : {}) };
  if (name === "answer") {
    if (!args) return "Type the answer after /answer.";
    if (decision.event !== "question" && !(decision.detail?.options ?? []).length) return { decision: "deny", reason: args };
    return { decision: "allow", reason: args };
  }
  if (decision.detail?.options?.length) {
    const pick = decision.detail.options.find((option) => option.toLowerCase() === args.toLowerCase()) ?? (decision.detail.recommended || decision.detail.options[0]);
    return { decision: "allow", reason: pick };
  }
  const scope = !args || args === "once" ? "once" : args === "task" || args === "session" ? "session" : args === "always" ? "always" : null;
  if (!scope) return "Use /allow once, /allow task or /allow always.";
  if (scope === "always" && decision.toolName === "outside") return "A path outside the folder is allowed once or for this task, never always.";
  return { decision: "allow", scope };
}

// ── small words ─────────────────────────────────────────────────────────────────────────────

export const STATUS_GLYPH: Record<string, { glyph: string; color: string }> = {
  queued: { glyph: "◌", color: "gray" },
  claimed: { glyph: "◌", color: "gray" },
  running: { glyph: "●", color: "cyan" },
  stopping: { glyph: "●", color: "yellow" },
  waiting_approval: { glyph: "◆", color: "yellow" },
  blocked: { glyph: "◆", color: "yellow" },
  succeeded: { glyph: "✓", color: "green" },
  failed: { glyph: "✗", color: "red" },
  cancelled: { glyph: "■", color: "gray" },
  interrupted: { glyph: "■", color: "yellow" },
};

export function engineOf(job: Pick<JobCard, "provider">): string {
  return { "claude-code": "Claude Code", codex: "Codex", "cursor-agent": "Cursor" }[job.provider ?? ""] ?? "Ensemble";
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function sourceLabel(source: string): string {
  return { ensemble: "Ensemble", claude: "Claude Code", codex: "Codex", copilot: "Copilot", cursor: "Cursor" }[source] ?? source;
}

// ── starting a run from the terminal ────────────────────────────────────────────────────────

/** The Assign request `/run` sends: a code task in this folder, under the run profile, with the chosen engine. */
export function runRequest(input: {
  taskId: string;
  folder: string;
  instructions: string;
  profile: RunProfile;
  engine: "ensemble" | "claude-code" | "codex" | "cursor-agent" | null;
}): Record<string, unknown> {
  const { profile } = input;
  const engine = input.engine ?? profile.engine;
  const model =
    !profile.model || engine !== profile.engine
      ? {}
      : engine === "ensemble" && profile.model.includes("::")
        ? { provider: profile.model.split("::")[0], model: profile.model.split("::")[1] }
        : { model: profile.model };
  return {
    taskId: input.taskId,
    kind: "code",
    engine,
    ...model,
    instructions: [profile.instructions, input.instructions].filter(Boolean).join("\n\n"),
    folder: input.folder,
    branchMode: profile.branchMode,
    delivery: profile.delivery,
    askBeforePublish: profile.askBeforePublish,
    mode: profile.mode,
    sandbox: profile.sandbox,
    network: profile.network,
    markDone: profile.markDone,
    ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
    ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
  };
}

// ── chat with your own agent ────────────────────────────────────────────────────────────────

export type AgentEngine = "claude-code" | "codex" | "cursor-agent";

/** A run that has ended, one way or another. */
export const FINISHED = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

/** Models to offer for each agent; null means type one (the agent's names change often). */
export const AGENT_MODELS: Record<AgentEngine, string[] | null> = { "claude-code": ["default", "sonnet", "opus", "haiku"], codex: null, "cursor-agent": null };

/**
 * The Assign request for one message in Chat with the person's own agent: in the folder the app
 * was opened in (later messages continue the first one's folder and session), under the run profile.
 */
export function chatTurnRequest(input: {
  taskId: string;
  folder: string;
  message: string;
  profile: RunProfile;
  engine: AgentEngine;
  model: string | null;
  previousJobId: string | null;
}): Record<string, unknown> {
  const first = !input.previousJobId;
  return {
    ...runRequest({ taskId: input.taskId, folder: input.folder, instructions: input.message, profile: { ...input.profile, instructions: first ? input.profile.instructions : "" }, engine: input.engine }),
    ...(input.model && input.model !== "default" ? { model: input.model } : {}),
    // A chat works on the folder's own branch; it does not start a branch per message.
    branchMode: "as-is",
    markDone: false,
    chat: true,
    ...(input.previousJobId ? { continueFromJobId: input.previousJobId } : {}),
  };
}

/** The agent to chat with when this computer has no model key: the first one installed. */
export function installedAgent(agents: ReadonlyArray<{ id: string; app: boolean; cli: string | null }>): AgentEngine | null {
  const has = (id: string, app = false) => agents.some((agent) => agent.id === id && (agent.cli || (app && agent.app)));
  if (has("claude")) return "claude-code";
  if (has("codex", true)) return "codex";
  if (has("cursor")) return "cursor-agent";
  return null;
}

/** A short title from what the person typed. */
export function titleFrom(text: string): string {
  const first = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

export function profileSummary(profile: RunProfile): string {
  const mode = profile.mode === "unattended" ? "Run unattended" : profile.mode === "review" ? "Review only" : "Ask";
  const git = profile.delivery === "local" ? "local only" : profile.delivery === "commit" ? "may commit" : "may commit and push";
  return `${mode} · ${git} · sandbox ${profile.sandbox ? "on" : "off"} · internet ${profile.network ? "on" : "off"}`;
}

export type KeyRow = { provider: string; source?: string | null };

/** The providers with a key: saved on this computer, or (signed in) saved on the Ensemble account. The runtime lists every provider. */
export function withKeys<T extends KeyRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => Boolean(row.source) && row.source !== "none");
}

/** "google (your account), cursor" for /status. */
export function keyLine(rows: readonly KeyRow[]): string {
  const keyed = withKeys(rows);
  if (!keyed.length) return "none (/keys here, or Settings → Models on the web)";
  return keyed.map((row) => (row.source === "account" ? `${row.provider} (your account)` : row.provider)).join(", ");
}
