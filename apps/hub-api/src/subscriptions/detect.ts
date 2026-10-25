/**
 * Which of the person's AI subscriptions this computer can run, found the way the vendor ships
 * them (docs/30 §8): Claude Code as the `claude` command or the copy the Claude app keeps for its
 * Code tab; Codex as the `codex` command or the copy inside the ChatGPT app; Cursor's agent;
 * Copilot CLI. For each: where it is, its version, whether it is signed in (as the tool itself
 * reports it, never by reading its credentials), and the models it offers.
 *
 * The checks start the tools themselves, so the answer is cached: the heartbeat reports the last
 * one, and "Check again" on the web or a finished sign-in asks for a new one.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { claudeCodeModelsFrom, type SubscriptionAgent, type UsageWindow, type SubscriptionModel, type SubscriptionProvider } from "@ensemble/shared-types";
import { bundledCodex } from "../workspace/handoff.js";
import { hostExecutable } from "../workspace/policy.js";
import { RpcConnection } from "../workspace/engines/rpc.js";
import { acpProbe } from "./acp-probe.js";
import { ANTIGRAVITY_MODELS, antigravityInstalled, antigravitySignedIn } from "./antigravity.js";
import { claudeControl } from "./claude-control.js";
import { copilotSavedSignIn, copilotStatus } from "./copilot.js";

/**
 * Variables that would make an agent bill an API key or another account instead of the person's
 * own sign-in, and Ensemble's own tokens, which no agent gets.
 */
const NOT_FOR_AGENTS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CURSOR_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "ENSEMBLE_DESKTOP_TOKEN",
  "ENSEMBLE_INTERNAL_TOKEN",
];

export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of NOT_FOR_AGENTS) delete env[key];
  return env;
}

export type AgentBinary = { path: string; via: "app" | "cli" };

const versionParts = (name: string): number[] => name.split(/[.\-+]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));

/** Newest first: 2.1.300 before 2.1.296 before 2.1.29. */
export function newestFirst(names: string[]): string[] {
  return names
    .filter((name) => /^\d+\.\d+/.test(name))
    .sort((a, b) => {
      const left = versionParts(a);
      const right = versionParts(b);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (right[index] ?? 0) - (left[index] ?? 0);
        if (difference) return difference;
      }
      return 0;
    });
}

function executableIn(folder: string, names: string[], depth: number): string | null {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return null;
  }
  for (const name of names) {
    const path = join(folder, name);
    try {
      if (entries.includes(name) && statSync(path).isFile()) return path;
    } catch {
      // unreadable: keep looking
    }
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(folder, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = executableIn(path, names, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * The Claude Code the Claude app keeps for its Code tab: Anthropic's own signed program, one
 * folder per version (on macOS `claude-code/<version>/<build>/claude.app/Contents/MacOS/claude`).
 * The newest version that has the program.
 */
export function claudeAppCopy(platform = process.platform, home = homedir(), env = process.env): string | null {
  const bases =
    platform === "darwin"
      ? [join(home, "Library", "Application Support", "Claude", "claude-code")]
      : platform === "win32"
        ? [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude-code"), join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "AnthropicClaude", "claude-code")]
        : [join(home, ".config", "Claude", "claude-code")];
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    let versions: string[];
    try {
      versions = newestFirst(readdirSync(base));
    } catch {
      continue;
    }
    for (const version of versions) {
      const found = executableIn(join(base, version), names, 5);
      if (found) return found;
    }
  }
  return null;
}

/** The person's Claude Code: the `claude` command first, else the Claude app's copy. */
export async function claudeBinary(): Promise<AgentBinary | null> {
  const cli = await hostExecutable("claude").catch(() => null);
  if (cli) return { path: cli, via: "cli" };
  const app = claudeAppCopy();
  return app ? { path: app, via: "app" } : null;
}

export async function codexAgentBinary(): Promise<AgentBinary | null> {
  const cli = await hostExecutable("codex").catch(() => null);
  if (cli) return { path: cli, via: "cli" };
  const app = bundledCodex();
  return app ? { path: app, via: "app" } : null;
}

/** The command each agent runs as; Antigravity's is the server Ensemble installs. */
const COMMANDS: Record<Exclude<SubscriptionProvider, "claude-code" | "codex" | "antigravity">, string> = {
  "cursor-agent": "cursor-agent",
  "copilot-cli": "copilot",
  "grok-cli": "grok",
  opencode: "opencode",
  "gemini-cli": "gemini",
};

export async function agentBinary(id: SubscriptionProvider): Promise<AgentBinary | null> {
  if (id === "claude-code") return claudeBinary();
  if (id === "codex") return codexAgentBinary();
  if (id === "antigravity") {
    const installed = antigravityInstalled();
    return installed ? { path: installed.executable, via: "app" } : null;
  }
  const name = COMMANDS[id];
  const cli = await hostExecutable(name).catch(() => null);
  return cli ? { path: cli, via: "cli" } : null;
}

type Ran = { code: number | null; stdout: string; stderr: string };

/** Runs a tool for a short check. Never throws: a tool that hangs or fails just answers less. */
export function quickRun(path: string, args: string[], timeoutMs = 15_000): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(path, args, { cwd: tmpdir(), env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 400_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");

export const firstVersion = (text: string): string | null => /\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?/.exec(stripAnsi(text))?.[0] ?? null;

/** `claude auth status --json` (or its text form): whether Claude Code has a sign-in, and the plan it names. */
export function parseClaudeStatus(ran: Pick<Ran, "code" | "stdout" | "stderr">): { signedIn: boolean | null; plan: string | null } {
  const text = stripAnsi(`${ran.stdout}\n${ran.stderr}`);
  const start = ran.stdout.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(ran.stdout.slice(start)) as Record<string, unknown>;
      if (body.authMethod === "api_key" || body.authMethod === "apiKey" || body.authMethod === "api_key_env_var") return { signedIn: false, plan: null };
      const signedIn = [body.loggedIn, body.logged_in, body.isLoggedIn, body.authenticated].find((value) => typeof value === "boolean") as boolean | undefined;
      const plan = [body.subscriptionType, body.subscription, body.plan].find((value) => typeof value === "string" && value.trim()) as string | undefined;
      if (signedIn !== undefined) return { signedIn, plan: signedIn ? (plan?.trim().slice(0, 60) ?? null) : null };
    } catch {
      // not JSON: read the words
    }
  }
  if (/not\s+(logged|signed)\s+in|no\s+account|log\s*in\s+required/i.test(text)) return { signedIn: false, plan: null };
  if (/(logged|signed)\s+in/i.test(text)) return { signedIn: true, plan: null };
  return { signedIn: null, plan: null };
}

/** Claude Code's thinking levels, from the `--effort <level> … (low, medium, …)` line of its help. */
export function claudeEfforts(help: string): string[] {
  const text = stripAnsi(help);
  const at = text.indexOf("--effort");
  if (at < 0) return [];
  const list = /\(([a-z, ]+)\)/.exec(text.slice(at, at + 400))?.[1];
  return list ? list.split(",").map((part) => part.trim()).filter((part) => /^[a-z]+$/.test(part)) : [];
}

/** `cursor-agent status`: "Logged in as …" or "Not logged in". */
export function parseCursorStatus(text: string): boolean | null {
  const clean = stripAnsi(text);
  if (/not\s+(logged|signed)\s+in|log\s*in\s+required|unauthenticated/i.test(clean)) return false;
  if (/(logged|signed)\s+in/i.test(clean)) return true;
  return null;
}

/** One model per line, as `id - Label` or `id`: what `cursor-agent models` prints. Headings and blanks are skipped. */
export function parseModelLines(text: string): SubscriptionModel[] {
  const models: SubscriptionModel[] = [];
  const seen = new Set<string>();
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.replace(/^[\s*•\-–>]+/, "").trim();
    if (!line || /^(available|models?|loading|error|tip|usage)\b/i.test(line) || line.endsWith(":")) continue;
    const match = /^([A-Za-z0-9][\w.\-/:[\]=,]*)(?:\s+(?:[-–—:]\s*)?(.*))?$/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    if (seen.has(id) || id.length > 120) continue;
    seen.add(id);
    const rest = (match[2] ?? "").trim();
    const isDefault = /\((current|default)\)/i.test(rest);
    const label = rest.replace(/\((current|default)\)/gi, "").trim() || id;
    models.push({ id, label: label.slice(0, 120), ...(isDefault ? { isDefault: true } : {}) });
  }
  return models.slice(0, 120);
}

/** The `model` entry of `copilot help config`: one quoted model id per bullet. */
export function parseCopilotModels(text: string): SubscriptionModel[] {
  const clean = stripAnsi(text);
  const start = clean.search(/`model`\s*:/);
  if (start < 0) return [];
  const models: SubscriptionModel[] = [{ id: "auto", label: "Auto (Copilot picks)", isDefault: true }];
  for (const line of clean.slice(start).split("\n").slice(1)) {
    const bullet = /^\s*-\s*"([^"]+)"/.exec(line);
    if (bullet) {
      if (!models.some((model) => model.id === bullet[1])) models.push({ id: bullet[1]!, label: bullet[1]! });
      continue;
    }
    if (line.trim() && !/^\s*-/.test(line)) break;
  }
  return models.length > 1 ? models.slice(0, 120) : [];
}

/** Copilot's thinking levels, from `--reasoning-effort … [possible values: …]`. */
export function copilotEfforts(help: string): string[] {
  const text = stripAnsi(help);
  const at = text.indexOf("--reasoning-effort");
  if (at < 0) return [];
  const list = /possible values:\s*([a-z, ]+)\]/.exec(text.slice(at, at + 400))?.[1];
  return list ? list.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

const now = () => new Date().toISOString();

async function probeClaude(): Promise<SubscriptionAgent | null> {
  const found = await claudeBinary();
  if (!found) return null;
  const [version, status, help, control] = await Promise.all([
    quickRun(found.path, ["--version"]),
    quickRun(found.path, ["auth", "status", "--json"]),
    quickRun(found.path, ["--help"]),
    claudeControl(found.path).catch(() => null),
  ]);
  const { signedIn, plan } = parseClaudeStatus(status);
  const efforts = claudeEfforts(help.stdout);
  const installed = firstVersion(version.stdout);
  return {
    id: "claude-code",
    via: found.via,
    version: installed,
    signedIn,
    plan: plan ?? (signedIn ? (control?.subscription ?? null) : null),
    // The plan's models as Claude Code lists them, with context windows from Ensemble's table.
    models: claudeCodeModelsFrom(control?.models, installed),
    typedModels: true,
    ...(efforts.length ? { efforts } : {}),
    ...(signedIn !== false && control?.limits.length ? { limits: control.limits } : {}),
    problem: version.code === 0 ? null : "Claude Code did not start. Open the Claude app once, or reinstall Claude Code.",
    checkedAt: now(),
  };
}

type CodexModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
  defaultReasoningEffort?: string | null;
  inputModalities?: string[];
  serviceTiers?: Array<{ id?: string; name?: string }> | null;
  additionalSpeedTiers?: string[] | null;
};

/** The service tier that is Codex's fast mode for a model ("priority", named Fast), or the older `fast` speed tier. */
export function codexFastTier(row: Pick<CodexModel, "serviceTiers" | "additionalSpeedTiers">): string | null {
  const named = (row.serviceTiers ?? []).find((tier) => typeof tier?.id === "string" && /fast/i.test(`${tier.name ?? ""} ${tier.id}`));
  if (named?.id) return named.id.slice(0, 40);
  return (row.additionalSpeedTiers ?? []).includes("fast") ? "fast" : null;
}

export function codexModels(rows: CodexModel[]): SubscriptionModel[] {
  return rows
    .filter((row) => !row.hidden && (row.model || row.id))
    .map((row) => {
      const id = String(row.model || row.id).slice(0, 120);
      const efforts = (row.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort).filter((value): value is string => typeof value === "string" && value.length <= 20);
      const fallback = typeof row.defaultReasoningEffort === "string" && efforts.includes(row.defaultReasoningEffort) ? row.defaultReasoningEffort : null;
      return {
        id,
        label: String(row.displayName || id).slice(0, 120),
        ...(row.isDefault ? { isDefault: true } : {}),
        ...(efforts.length ? { efforts: efforts.slice(0, 10) } : {}),
        ...(fallback ? { defaultEffort: fallback } : {}),
        ...(Array.isArray(row.inputModalities) ? { vision: row.inputModalities.includes("image") } : {}),
        ...(codexFastTier(row) ? { fast: codexFastTier(row)! } : {}),
        ...(row.description ? { description: row.description.slice(0, 240) } : {}),
      };
    })
    .slice(0, 120);
}

type CodexWindow = { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null } | null | undefined;
type CodexLimitSnapshot = { limitId?: string | null; planType?: string | null; primary?: CodexWindow; secondary?: CodexWindow };

const HOURS_5 = 5 * 60;
const WEEK = 7 * 24 * 60;
const MONTH = 30 * 24 * 60;

/**
 * Codex's `account/rateLimits/read`: the plan's windows with how much of each is used. The first
 * window is the 5-hour one (the month on Free and Go), the second the week, unless Codex says how
 * long each is. Limits for one model only are left out. After T3 Code's `codexUsageLimits.ts`
 * (pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
export function codexLimits(body: { rateLimits?: CodexLimitSnapshot | null; rateLimitsByLimitId?: Record<string, CodexLimitSnapshot> | null } | null | undefined): UsageWindow[] {
  const snapshot = body?.rateLimitsByLimitId?.codex ?? body?.rateLimits;
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== "codex")) return [];
  const monthly = snapshot.planType === "free" || snapshot.planType === "go";
  const windows: UsageWindow[] = [];
  for (const [id, window, fallback] of [["primary", snapshot.primary, monthly ? MONTH : HOURS_5], ["secondary", snapshot.secondary, WEEK]] as const) {
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    const minutes = typeof window.windowDurationMins === "number" && window.windowDurationMins > 0 ? Math.round(window.windowDurationMins) : fallback;
    const label = minutes >= MONTH ? "Monthly limit" : minutes >= WEEK ? "Weekly limit" : minutes % 60 === 0 ? `${minutes / 60}-hour limit` : `${minutes}-minute limit`;
    const resetsAt = typeof window.resetsAt === "number" && window.resetsAt > 0 ? new Date(window.resetsAt * 1000).toISOString() : undefined;
    windows.push({ id, label, usedPercent: Math.min(100, Math.max(0, window.usedPercent)), minutes, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

/** Codex answers through its app-server: whether it is signed in (`account/read`) and its models (`model/list`). */
async function probeCodex(): Promise<SubscriptionAgent | null> {
  const found = await codexAgentBinary();
  if (!found) return null;
  const child = spawn(found.path, ["app-server"], { cwd: tmpdir(), env: agentEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => undefined);
  child.on("error", () => undefined);
  const server = new RpcConnection((line) => {
    if (child.stdin.writable) child.stdin.write(line);
  });
  server.onRequest = async () => {
    throw new Error("Not during a check.");
  };
  createInterface({ input: child.stdout }).on("line", (line) => void server.receive(line));
  child.stderr.resume();
  child.once("close", () => server.close("Codex stopped."));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const base: SubscriptionAgent = { id: "codex", via: found.via, version: null, signedIn: null, plan: null, models: [], typedModels: true, problem: null, checkedAt: now() };
  try {
    const init = (await server.request("initialize", { clientInfo: { name: "ensemble", title: "Ensemble", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } })) as { userAgent?: string };
    server.notify("initialized");
    base.version = firstVersion(String(init.userAgent ?? "").replace(/^[^/]*\//, ""));
    const account = (await server.request("account/read", {})) as { account?: { type?: string; planType?: string } | null; requiresOpenaiAuth?: boolean };
    base.signedIn = account.account?.type === "chatgpt";
    if (!base.signedIn && account.requiresOpenaiAuth === false) base.problem = "Codex is configured for an API key or custom provider. Sign in with ChatGPT to use a subscription here.";
    base.plan = account.account?.type === "chatgpt" && account.account.planType && account.account.planType !== "unknown" ? account.account.planType : null;
    const rows: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const listed = (await server.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) })) as { data?: CodexModel[]; nextCursor?: string | null };
      rows.push(...(listed.data ?? []));
      cursor = listed.nextCursor ?? null;
      if (!cursor) break;
    }
    base.models = codexModels(rows);
    // How much of the plan's 5-hour and weekly windows is used; a Codex without the method lists none.
    if (base.signedIn) {
      const limits = codexLimits((await server.request("account/rateLimits/read", {}).catch(() => null)) as Parameters<typeof codexLimits>[0]);
      if (limits.length) base.limits = limits;
    }
    // A Codex set up with its own model provider may list none: it still answers with its configured model.
    if (!base.models.length) base.models = [{ id: "default", label: "Codex's default", isDefault: true }];
  } catch (error) {
    base.problem = `Codex did not answer: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
  return base;
}

async function probeCursor(): Promise<SubscriptionAgent | null> {
  const found = await agentBinary("cursor-agent");
  if (!found) return null;
  const [version, status, models] = await Promise.all([quickRun(found.path, ["--version"]), quickRun(found.path, ["status"], 20_000), quickRun(found.path, ["models"], 25_000)]);
  const listed = parseModelLines(models.stdout);
  return {
    id: "cursor-agent",
    via: "cli",
    version: firstVersion(version.stdout),
    signedIn: parseCursorStatus(`${status.stdout}\n${status.stderr}`),
    plan: null,
    models: listed.length ? listed : [{ id: "default", label: "Cursor's default", isDefault: true }],
    typedModels: true,
    problem: null,
    checkedAt: now(),
  };
}

async function probeCopilot(): Promise<SubscriptionAgent | null> {
  const found = await agentBinary("copilot-cli");
  if (!found) return null;
  // Copilot CLI 1.0 reports its account and the plan's models (context windows, thinking levels, cost) itself.
  const reported = await copilotStatus(found.path).catch(() => null);
  if (reported) {
    // Not signed in while a saved sign-in is listed: the keychain could not be read (locked, or not ready after a restart).
    const keychain = reported.signedIn === false && (await copilotSavedSignIn());
    return {
      id: "copilot-cli",
      via: "cli",
      version: firstVersion(reported.version ?? "") ?? firstVersion((await quickRun(found.path, ["--version"])).stdout),
      signedIn: keychain ? null : reported.signedIn,
      plan: null,
      account: reported.account,
      models: reported.models.length ? reported.models : [{ id: "auto", label: "Auto (Copilot picks)", isDefault: true }],
      typedModels: true,
      problem: keychain
        ? "Copilot is signed in, but this computer's keychain could not be read just now (locked, or not ready after a restart). Log in to its desktop once if this stays."
        : reported.signedIn === false
          ? "Copilot CLI is not signed in on this computer. Press Sign in, or run `copilot login` there."
          : null,
      checkedAt: now(),
    };
  }
  // An older Copilot without the headless server: its help text lists models and thinking levels.
  const [version, config, help] = await Promise.all([quickRun(found.path, ["--version"]), quickRun(found.path, ["help", "config"]), quickRun(found.path, ["--help"])]);
  const models = parseCopilotModels(config.stdout);
  const efforts = copilotEfforts(help.stdout);
  return {
    id: "copilot-cli",
    via: "cli",
    version: firstVersion(version.stdout),
    signedIn: null,
    plan: null,
    models: models.length ? models : [{ id: "auto", label: "Auto (Copilot picks)", isDefault: true }],
    typedModels: true,
    ...(efforts.length ? { efforts } : {}),
    problem: null,
    checkedAt: now(),
  };
}

/** `grok models`: whether Grok Build is signed in (it always exits 0; the words say) and its models, one bullet each. After T3 Code's `parseGrokModelsCliOutput`. */
export function parseGrokModels(text: string): { signedIn: boolean | null; models: SubscriptionModel[] } {
  const clean = stripAnsi(text);
  const signedIn = /you are logged in/i.test(clean) ? true : /not authenticated|not logged in/i.test(clean) ? false : null;
  const models: SubscriptionModel[] = [];
  for (const line of clean.split("\n")) {
    const bullet = /^\s*[*-]\s+(\S+)(.*)$/.exec(line);
    if (!bullet?.[1] || models.some((model) => model.id === bullet[1])) continue;
    const id = bullet[1].slice(0, 120);
    models.push({ id, label: id.split(/[-_]/).map((part) => (part.toLowerCase() === "grok" ? "Grok" : part)).join(" ").slice(0, 120), ...(/\(default\)/i.test(bullet[2] ?? "") ? { isDefault: true } : {}) });
  }
  return { signedIn, models: models.slice(0, 120) };
}

/** `opencode auth list`: how many providers OpenCode holds a sign-in for (its "N credentials" line, else its bullets). */
export function parseOpenCodeAuth(text: string): number | null {
  const clean = stripAnsi(text);
  const counted = /(\d+)\s+credentials?/i.exec(clean);
  if (counted) return Number(counted[1]);
  const bullets = clean.split("\n").filter((line) => /^\s*[●•*]\s+\S/.test(line)).length;
  return bullets || (clean.trim() ? 0 : null);
}

async function probeGrok(): Promise<SubscriptionAgent | null> {
  const found = await agentBinary("grok-cli");
  if (!found) return null;
  const [version, listed] = await Promise.all([quickRun(found.path, ["--version"]), quickRun(found.path, ["models"], 25_000)]);
  const { signedIn, models } = parseGrokModels(`${listed.stdout}\n${listed.stderr}`);
  return {
    id: "grok-cli",
    via: "cli",
    version: firstVersion(version.stdout),
    signedIn,
    plan: null,
    models: models.length ? models : [{ id: "default", label: "Grok's default", isDefault: true }],
    typedModels: true,
    problem: signedIn === false ? "Grok Build is not signed in on this computer. Press Sign in, or run `grok login` there." : null,
    checkedAt: now(),
  };
}

async function probeOpenCode(): Promise<SubscriptionAgent | null> {
  const found = await agentBinary("opencode");
  if (!found) return null;
  const [version, auth, listed] = await Promise.all([quickRun(found.path, ["--version"]), quickRun(found.path, ["auth", "list"], 20_000), quickRun(found.path, ["models"], 25_000)]);
  const credentials = parseOpenCodeAuth(`${auth.stdout}\n${auth.stderr}`);
  const models = parseModelLines(listed.stdout).filter((model) => model.id.includes("/"));
  return {
    id: "opencode",
    via: "cli",
    version: firstVersion(version.stdout),
    // OpenCode can also run on keys in the person's own environment: a model list counts as signed in.
    signedIn: credentials === null ? (models.length ? true : null) : credentials > 0 || models.length > 0,
    plan: null,
    models: [{ id: "default", label: "OpenCode's default", isDefault: true }, ...models].slice(0, 120),
    typedModels: true,
    problem: credentials === 0 && !models.length ? "OpenCode has no provider signed in. Press Sign in, or run `opencode auth login` there." : null,
    checkedAt: now(),
  };
}

async function probeGemini(): Promise<SubscriptionAgent | null> {
  const found = await agentBinary("gemini-cli");
  if (!found) return null;
  const [version, probe] = await Promise.all([quickRun(found.path, ["--version"]), acpProbe("gemini-cli").catch(() => null)]);
  return {
    id: "gemini-cli",
    via: "cli",
    version: firstVersion(version.stdout),
    signedIn: probe?.signedIn ?? null,
    plan: null,
    models: probe?.models.length ? probe.models : [{ id: "default", label: "Gemini CLI's default", isDefault: true }],
    typedModels: true,
    problem: probe?.signedIn === false ? "Gemini CLI is not signed in on this computer. Press Sign in, or run `gemini` there and choose Sign in with Google." : (probe?.problem ?? null),
    checkedAt: now(),
  };
}

async function probeAntigravity(): Promise<SubscriptionAgent | null> {
  const installed = antigravityInstalled();
  if (!installed) return null;
  const signedIn = antigravitySignedIn();
  return {
    id: "antigravity",
    via: "app",
    version: installed.version,
    signedIn,
    plan: null,
    models: ANTIGRAVITY_MODELS,
    typedModels: true,
    problem: signedIn ? null : "Antigravity is installed but not signed in. Press Sign in: Google's sign-in page opens in the browser.",
    checkedAt: now(),
  };
}

const PROBES: Record<SubscriptionProvider, () => Promise<SubscriptionAgent | null>> = {
  "claude-code": probeClaude,
  codex: probeCodex,
  "cursor-agent": probeCursor,
  "copilot-cli": probeCopilot,
  "grok-cli": probeGrok,
  opencode: probeOpenCode,
  "gemini-cli": probeGemini,
  antigravity: probeAntigravity,
};

const FRESH_MS = 10 * 60_000;
let cache: { at: number; agents: SubscriptionAgent[] } | null = null;
let running: Promise<SubscriptionAgent[]> | null = null;

/** Every subscription agent on this computer, checked now (or the check already under way). */
export function detectAgents(options: { force?: boolean } = {}): Promise<SubscriptionAgent[]> {
  if (!options.force && cache && Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.agents);
  running ??= Promise.all(
    (Object.keys(PROBES) as SubscriptionProvider[]).map((id) =>
      PROBES[id]().catch((error: unknown) => ({
        id,
        via: "cli" as const,
        version: null,
        signedIn: null,
        plan: null,
        models: [],
        problem: `The check failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        checkedAt: now(),
      })),
    ),
  )
    .then((rows) => {
      const agents = rows.filter((row): row is SubscriptionAgent => row !== null);
      cache = { at: Date.now(), agents };
      return agents;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Checks one agent again (after a sign-in) and puts the answer in the cache. */
export async function refreshAgent(id: SubscriptionProvider): Promise<SubscriptionAgent | null> {
  const found = await PROBES[id]().catch(() => null);
  const others = (cache?.agents ?? []).filter((row) => row.id !== id);
  cache = { at: cache?.at ?? Date.now(), agents: found ? [...others, found] : others };
  return found;
}

/** The last answer without waiting; a stale one starts a new check in the background. */
export function cachedAgents(): SubscriptionAgent[] | null {
  if (!cache || Date.now() - cache.at >= FRESH_MS) void detectAgents().catch(() => undefined);
  return cache?.agents ?? null;
}

export function forgetAgentsForTests(): void {
  cache = null;
  running = null;
}
