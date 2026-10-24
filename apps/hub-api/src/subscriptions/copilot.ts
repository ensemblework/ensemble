/**
 * GitHub Copilot CLI, the person's own `copilot` with its own sign-in (docs/30 §3, §8).
 *
 * Ensemble talks to it two ways, both over stdio and both with the tool's stored sign-in:
 * - its headless server (`copilot --headless --stdio`, JSON-RPC framed with Content-Length, the
 *   protocol of @github/copilot-sdk) for the account (`auth.getStatus`) and the plan's models
 *   with their context windows, thinking levels and request cost (`models.list`);
 * - ACP (`copilot --acp`) for code runs (`workspace/engines/copilot.ts`).
 *
 * Ensemble never reads Copilot's credentials. It removes variables that would replace the stored
 * sign-in (a GitHub token) or approve every tool call by themselves (`COPILOT_ALLOW_ALL`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ContextTier, ModelContext, SubscriptionModel } from "@ensemble/shared-types";
import { hostExecutable } from "../workspace/policy.js";
import { agentEnv } from "./detect.js";

/**
 * Copilot reads these before its stored sign-in, or uses them to approve every tool by itself.
 * A GitHub token in Ensemble's environment would also reach the agent's own shell commands.
 */
export const COPILOT_NOT_FOR_RUNS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL"];

export function copilotEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = agentEnv(extra);
  for (const key of COPILOT_NOT_FOR_RUNS) delete env[key];
  // Updates are the person's to take; a run always uses the copy that was checked.
  env.COPILOT_AUTO_UPDATE = "false";
  return env;
}

export async function copilotBinary(): Promise<string | null> {
  return (await hostExecutable("copilot").catch(() => null)) ?? null;
}

/** One `models.list` row, as Copilot CLI 1.0 returns it (fields Ensemble reads). */
export type CopilotModelRow = {
  id?: string;
  name?: string;
  vendor?: string;
  capabilities?: {
    supports?: { vision?: boolean; reasoningEffort?: boolean };
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
  };
  policy?: { state?: string };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  /** "low", "medium", "high", "very_high": the relative cost Copilot shows on token-billed plans. */
  modelPickerPriceCategory?: string;
  billing?: {
    multiplier?: number;
    tokenPrices?: { contextMax?: number; maxPromptTokens?: number; longContext?: { contextMax?: number; maxPromptTokens?: number } };
  };
};

const tokens = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);

/** "200K", "1.05M". */
export function tokenLabel(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(2))}M`;
  return `${Math.round(count / 1000)}K`;
}

/**
 * The context windows a model offers. A model priced in two tiers has a standard window and a
 * long one (`--context long_context`); otherwise its prompt limit is the only size.
 */
export function copilotContexts(row: CopilotModelRow): ModelContext[] {
  const prices = row.billing?.tokenPrices;
  const standard = tokens(prices?.maxPromptTokens) ?? tokens(prices?.contextMax);
  const long = tokens(prices?.longContext?.maxPromptTokens) ?? tokens(prices?.longContext?.contextMax);
  if (standard && long && long > standard) {
    return [
      { id: "default", label: `${tokenLabel(standard)} (standard)`, tokens: standard },
      { id: "long_context", label: `${tokenLabel(long)} (long context)`, tokens: long },
    ];
  }
  const only = standard ?? tokens(row.capabilities?.limits?.max_prompt_tokens) ?? tokens(row.capabilities?.limits?.max_context_window_tokens);
  return only ? [{ id: "default", label: tokenLabel(only), tokens: only }] : [];
}

/** The plan's models as Ensemble lists them. Models the plan has switched off are left out. */
export function copilotModels(rows: CopilotModelRow[]): SubscriptionModel[] {
  const models: SubscriptionModel[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || id.length > 120 || models.some((model) => model.id === id)) continue;
    if (row.policy?.state === "disabled") continue;
    const efforts = (row.supportedReasoningEfforts ?? []).filter((value) => typeof value === "string" && value.length <= 20).slice(0, 10);
    const contexts = copilotContexts(row);
    const multiplier = row.billing?.multiplier;
    const category = typeof row.modelPickerPriceCategory === "string" && /^[a-z_]{1,20}$/.test(row.modelPickerPriceCategory) ? row.modelPickerPriceCategory.replace(/_/g, " ") : null;
    const cost = typeof multiplier === "number" && Number.isFinite(multiplier) ? `${Number(multiplier.toFixed(2))}× premium requests` : category ? `${category} cost` : null;
    models.push({
      id,
      label: (id === "auto" ? "Auto (Copilot picks)" : row.name?.trim() || id).slice(0, 120),
      ...(id === "auto" ? { isDefault: true } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(row.defaultReasoningEffort && efforts.includes(row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}),
      ...(contexts.length ? { contexts } : {}),
      ...(typeof row.capabilities?.supports?.vision === "boolean" ? { vision: row.capabilities.supports.vision } : {}),
      ...(cost ? { cost } : {}),
      ...(row.vendor ? { description: row.vendor.slice(0, 240) } : {}),
    });
  }
  if (!models.some((model) => model.id === "auto")) models.unshift({ id: "auto", label: "Auto (Copilot picks)", isDefault: true });
  return models.slice(0, 120);
}

/** Whether a context tier is one the model offers; anything else runs on its default. */
export function contextFor(model: Pick<SubscriptionModel, "contexts"> | undefined, wanted: string | null | undefined): ContextTier | null {
  if (wanted !== "long_context") return null;
  return model?.contexts?.some((context) => context.id === "long_context") ? "long_context" : null;
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

/** A short session with Copilot's headless server: requests in order, then it is stopped. */
export async function withCopilotServer<T>(path: string, use: (request: (method: string, params?: unknown) => Promise<Record<string, unknown>>) => Promise<T>, timeoutMs = 25_000): Promise<T> {
  const child = spawn(path, ["--headless", "--no-auto-update", "--stdio"], { cwd: tmpdir(), env: copilotEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  const pending = new Map<number, Pending>();
  let next = 0;
  let buffer = Buffer.alloc(0);
  const fail = (reason: string) => {
    for (const waiting of pending.values()) waiting.reject(new Error(reason));
    pending.clear();
  };
  child.on("error", (error) => fail(error.message));
  child.once("close", () => fail("Copilot stopped."));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1] ?? Number.NaN);
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(end + 4);
        continue;
      }
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      buffer = buffer.subarray(end + 4 + length);
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiting) continue;
      pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(message.error.message ?? "Copilot refused the request."));
      else waiting.resolve(message.result ?? {});
    }
  });
  const request = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  const timer = setTimeout(() => {
    fail("Copilot did not answer in time.");
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    return await use(request);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

export type CopilotStatus = { version: string | null; signedIn: boolean | null; account: string | null; models: SubscriptionModel[] };

/** The account and models Copilot reports. Signed out: no models are asked for. */
export async function copilotStatus(path: string): Promise<CopilotStatus> {
  return withCopilotServer(path, async (request) => {
    const status = (await request("status.get")) as { version?: string };
    const auth = (await request("auth.getStatus")) as { isAuthenticated?: boolean; login?: string; statusMessage?: string };
    const signedIn = typeof auth.isAuthenticated === "boolean" ? auth.isAuthenticated : null;
    const account = signedIn ? (auth.login ?? auth.statusMessage ?? "").trim().slice(0, 120) || null : null;
    if (!signedIn) return { version: status.version ?? null, signedIn, account, models: [] };
    const listed = (await request("models.list")) as { models?: CopilotModelRow[] };
    return { version: status.version ?? null, signedIn, account, models: copilotModels(listed.models ?? []) };
  });
}

/**
 * Whether Copilot's own command sandbox can run here (`copilot help sandbox`): Seatbelt on macOS;
 * on Linux bubblewrap plus a private network (slirp4netns, util-linux, iptables, /dev/net/tun);
 * on Windows Copilot checks the OS itself. What is missing, in words.
 */
export async function copilotSandboxMissing(platform = process.platform): Promise<string[]> {
  if (platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? [] : ["sandbox-exec"];
  if (platform !== "linux") return [];
  const needed = ["bwrap", "slirp4netns", "unshare", "nsenter", "iptables"];
  const found = await Promise.all(needed.map((name) => hostExecutable(name).then(() => true, () => false)));
  const missing = needed.filter((_, index) => !found[index]);
  if (!existsSync("/dev/net/tun")) missing.push("/dev/net/tun");
  return missing;
}
