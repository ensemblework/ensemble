/**
 * The app's pure logic: slash commands, the Tasks list (grouped: needs you, running, queued,
 * stopped, done), and the answers a waiting request offers. No terminal here, so it is tested
 * directly.
 */
import { claudeCodeModels, ENGINE_LABELS, isCodeEngine, type CodeEngine, type ContextTier, type RunProfile, type SubscriptionAgent, type SubscriptionModel } from "@ensemble/shared-types";
import type { Decision, JobCard, Workspace } from "./local.js";
import type { Engine, Tab } from "./prefs.js";

// ── slash commands ──────────────────────────────────────────────────────────────────────────

export type Command = { name: string; args?: string; description: string; aliases?: string[]; tab?: Tab };

export const COMMANDS: readonly Command[] = [
  { name: "tasks", description: "Agent runs, and what needs you" },
  { name: "chat", description: "Chat with your agent" },
  { name: "node", description: "Ensemble Node: your nodes, rooms, approvals and runs (read-only here)" },
  { name: "new", description: "Start a new chat", tab: "chat" },
  { name: "run", args: "<what to do>", description: "Start your agent on it as a task, in this folder, with your run profile" },
  { name: "allow", args: "[once|task|always]", description: "Allow what the selected run is asking", tab: "tasks" },
  { name: "deny", args: "[reason]", description: "Deny what the selected run is asking", tab: "tasks" },
  { name: "answer", args: "<text>", description: "Answer the selected question in your own words", tab: "tasks" },
  { name: "stop", description: "Stop the selected run, or the reply being written" },
  { name: "retry", description: "Run the selected task again", tab: "tasks" },
  { name: "profile", args: "[name]", description: "Run profile: mode, git, sandbox, internet" },
  { name: "agent", args: "[name]", description: "Who you work with: Claude Code, Codex, Cursor, GitHub Copilot (your sign-in) or Ensemble agent" },
  { name: "model", args: "[model]", description: "Your agent's model" },
  { name: "folder", description: "The folder your agent works in" },
  { name: "trust", description: "Trust this folder (Review only and Run unattended need it)" },
  { name: "keys", args: "[provider]", description: "Add a model key on this computer" },
  { name: "sandbox", description: "This computer's sandbox, and set it up" },
  { name: "hooks", description: "Send Claude, Codex, Copilot and Cursor prompts to Needs me" },
  { name: "login", description: "Sign in, so tasks from ensemblework.com run here" },
  { name: "logout", description: "Sign out and unpair this computer" },
  { name: "runner", args: "[install|uninstall]", description: "Start Ensemble at login, or stop doing that" },
  { name: "update", description: "Update Ensemble on this computer" },
  { name: "status", description: "Account, runtime, sandbox and keys" },
  { name: "sidebar", description: "Show or hide the sidebar (Ctrl+B)" },
  { name: "help", description: "Keys and commands" },
  { name: "exit", aliases: ["quit", "q"], description: "Leave; Ensemble keeps running tasks in the background" },
];

/** Commands whose name starts with what was typed after the slash, best first. */
export function matchCommands(typed: string, tab: Tab): Command[] {
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
  return isCodeEngine(job.provider) ? ENGINE_LABELS[job.provider] : "Ensemble";
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

/** What `/model` picked for the person's own agent: a model, and for GitHub Copilot its thinking level and context window. */
export type AgentChoice = { model: string | null; effort?: string | null; context?: ContextTier | null };

/**
 * The Assign request `/run` sends: a code task in this folder, under the run profile, with the
 * chosen engine. `agent`, the `/model` choice for the person's own agent, replaces the profile's
 * model, thinking level and context window when it names a model. A profile that ends in a pull
 * request runs in its own clone of this folder (a git repository) instead of in the folder, on a
 * branch Ensemble makes from the base (empty: the repository's default branch); it commits, and
 * Ensemble pushes and opens the pull request.
 */
export function runRequest(input: {
  taskId: string;
  folder: string;
  instructions: string;
  profile: RunProfile;
  engine: Engine | null;
  agent?: AgentChoice | null;
}): Record<string, unknown> {
  const { profile } = input;
  const engine = input.engine ?? profile.engine;
  const own = engine === profile.engine;
  const model =
    !profile.model || !own
      ? {}
      : engine === "ensemble" && profile.model.includes("::")
        ? { provider: profile.model.split("::")[0], model: profile.model.split("::")[1] }
        : { model: profile.model };
  // The profile's thinking level and context window go with the agent the profile names, as the
  // web's Assign sends them; the runner on the computer checks them against the model's own.
  const effort = own && profile.effort && profile.effort !== "default" ? { reasoningEffort: profile.effort } : {};
  const context = own && engine !== "ensemble" && profile.context === "long_context" ? { contextTier: "long_context" } : {};
  const picked = engine !== "ensemble" && input.agent?.model && input.agent.model !== "default" ? agentFields(input.agent) : null;
  const pullRequest = profile.pullRequest ?? null;
  return {
    taskId: input.taskId,
    kind: "code",
    engine,
    ...(picked ?? { ...model, ...effort, ...context }),
    instructions: [profile.instructions, input.instructions].filter(Boolean).join("\n\n"),
    ...(pullRequest ? { repoUrl: input.folder, pullRequest: { base: pullRequest.base, merge: pullRequest.merge } } : { folder: input.folder }),
    branchMode: pullRequest ? "as-is" : profile.branchMode,
    delivery: pullRequest ? "push" : profile.delivery,
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

export type AgentEngine = CodeEngine;

/** A run that has ended, one way or another. */
export const FINISHED = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

/**
 * An agent as this computer's runtime found it (`GET /api/subscriptions`), with the models it lists,
 * each with its own thinking levels and context windows. Claude Code falls back to Ensemble's own
 * table of its models before the check answers; the others then take a typed model name.
 */
export function agentOf(agents: readonly SubscriptionAgent[] | null | undefined, engine: AgentEngine): SubscriptionAgent | null {
  const found = agents?.find((agent) => agent.id === engine) ?? null;
  if (found || engine !== "claude-code") return found;
  return { id: "claude-code", via: "cli", version: null, signedIn: null, models: claudeCodeModels(null), typedModels: true, checkedAt: "" };
}

/** The Assign fields for a `/model` choice that names a model. */
function agentFields(choice: AgentChoice): Record<string, unknown> {
  return {
    model: choice.model,
    ...(choice.effort && choice.effort !== "default" ? { reasoningEffort: choice.effort } : {}),
    ...(choice.context === "long_context" ? { contextTier: "long_context" } : {}),
  };
}

/**
 * The Assign request for one message in Chat with the person's own agent: in the folder the app
 * was opened in (later messages continue the first one's folder and session), under the run profile.
 * A chat message never ends in a pull request, whatever the profile says.
 */
export function chatTurnRequest(input: {
  taskId: string;
  folder: string;
  message: string;
  profile: RunProfile;
  engine: AgentEngine;
  model: string | null;
  /** GitHub Copilot's thinking level and context window for that model. */
  effort?: string | null;
  context?: ContextTier | null;
  previousJobId: string | null;
}): Record<string, unknown> {
  const first = !input.previousJobId;
  return {
    ...runRequest({
      taskId: input.taskId,
      folder: input.folder,
      instructions: input.message,
      profile: { ...input.profile, instructions: first ? input.profile.instructions : "", pullRequest: null },
      engine: input.engine,
      agent: { model: input.model, effort: input.effort, context: input.context },
    }),
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
  if (has("copilot")) return "copilot-cli";
  return null;
}

// ── GitHub Copilot on this computer ─────────────────────────────────────────────────────────

const COPILOT_INSTALL = "npm install -g @github/copilot";

/**
 * Copilot as this computer's runtime found it (`GET /api/subscriptions`): its row, null when the
 * check found no Copilot, undefined when there is no answer yet.
 */
export function copilotOf(agents: readonly SubscriptionAgent[] | null | undefined): SubscriptionAgent | null | undefined {
  if (!agents) return undefined;
  return agents.find((agent) => agent.id === "copilot-cli") ?? null;
}

/** Why a Chat message or /run cannot go to Copilot here, with the fix; null when it can, or when it is not known yet. */
export function copilotProblem(copilot: SubscriptionAgent | null | undefined): string | null {
  if (copilot === null) return `GitHub Copilot isn't on this computer yet: ${COPILOT_INSTALL}, then copilot login.`;
  if (copilot?.signedIn === false) return "GitHub Copilot isn't signed in on this computer: run copilot login in a terminal, then try again.";
  return null;
}

/** Copilot's note in /agent. `cli`: whether the `copilot` command is on the PATH, for when the check has not answered. */
export function copilotNote(copilot: SubscriptionAgent | null | undefined, cli: boolean): string {
  if (copilot === null || (copilot === undefined && !cli)) return `not found · ${COPILOT_INSTALL}`;
  if (copilot?.signedIn === false) return "not signed in · run copilot login";
  return `your Copilot sign-in${copilot?.account ? ` (${copilot.account})` : ""}`;
}

/** "200K", "1.05M". */
function tokenSize(count: number): string {
  return count >= 1_000_000 ? `${Number((count / 1_000_000).toFixed(2))}M` : `${Math.round(count / 1000)}K`;
}

/** The dim note beside a Copilot model in /model: what it costs and its context sizes ("low cost · 200K / 922K context"). */
export function modelNote(model: SubscriptionModel): string {
  const sizes = (model.contexts ?? []).map((context) => (context.tokens ? tokenSize(context.tokens) : context.label));
  return [model.cost, sizes.length ? `${sizes.join(" / ")} context` : null].filter(Boolean).join(" · ");
}

/** The thinking levels a model takes: its own, or the ones an older Copilot lists for every model. */
export function modelEfforts(model: SubscriptionModel, copilot: SubscriptionAgent | null | undefined): string[] {
  return model.efforts?.length ? model.efforts : (copilot?.efforts ?? []);
}

/** The agent's model as the status line and /status show it: "GPT-5.6 Luna · high thinking · long context". */
export function agentChoiceLabel(choice: AgentChoice, models: readonly SubscriptionModel[] = [], fallback = "default model"): string {
  const model = choice.model ? (models.find((row) => row.id === choice.model)?.label ?? choice.model) : (models.find((row) => row.isDefault)?.label ?? fallback);
  return [model, choice.effort ? `${choice.effort} thinking` : null, choice.context === "long_context" ? "long context" : null].filter(Boolean).join(" · ");
}

/** A short title from what the person typed. */
export function titleFrom(text: string): string {
  const first = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

/** What a run may do with git: `local` and `commit` are limits the person picked; `push` has none. */
export function deliveryLabel(delivery: string): string {
  return delivery === "local" ? "local only" : delivery === "commit" ? "may commit" : "No limits (commit, push, pull requests)";
}

/** The branch a pull request goes into: the one named, or the repository's default branch. */
export function baseLabel(base: string): string {
  return base || "the default branch";
}

export function profileSummary(profile: RunProfile): string {
  const mode = profile.mode === "unattended" ? "Run unattended" : profile.mode === "review" ? "Review only" : "Ask";
  const plan = profile.pullRequest;
  const git = plan
    ? `pull request into ${baseLabel(plan.base)}${plan.merge === "auto" ? ", merged when its checks pass" : plan.merge === "ask" ? ", merged if you approve" : ", left open"}`
    : deliveryLabel(profile.delivery);
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
