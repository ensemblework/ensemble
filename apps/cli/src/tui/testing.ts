/** A stand-in for this computer's runtime, for the app's tests. */
import type { SubscriptionAgent } from "@ensemble/shared-types";
import type { Ops } from "./app.js";
import type { ChatFrame, Decision, LocalApi, Workspace } from "./local.js";

export const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first value `read` gives that is not undefined, or undefined after a few seconds (a slow CI machine needs the wait). */
export async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() > end) return value;
    await tick(40);
  }
}

/** The screen once it shows `pattern` (or after a few seconds, so the assertion that follows says what was there). */
export async function screenWith(read: () => string | undefined, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const frame = read() ?? "";
    if (pattern.test(frame) || Date.now() > end) return frame;
    await tick(40);
  }
}

export const job = (id: string, title: string, status: string) => ({
  id,
  taskId: `t-${id}`,
  title,
  status,
  kind: "code",
  provider: "claude-code",
  folder: "/work/app",
  position: null,
  delivery: "commit",
  unattended: false,
  accessMode: "read-write",
  executionMode: "sandbox",
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  finishedAt: null,
  progress: "Running the tests",
});

export const empty: Workspace = { root: "/w", paused: false, maxConcurrent: 2, queued: [], running: [], waiting: [], stopped: [], completed: [] };

/** An agent run as the app sees it on each poll: its status, what it logged, and its final words. `hold` repeats it until something is answered. */
export type RunStep = { status: string; log: string; summary?: string; error?: string; hold?: boolean };

export function fakeApi(
  input: {
    workspace?: Workspace;
    decisions?: Decision[];
    frames?: ChatFrame[];
    /** Agent runs started from Chat, by job id: each poll takes the next step (the last one repeats). */
    runs?: Record<string, RunStep[]>;
    agents?: Array<{ id: string; name: string; app: boolean; cli: string | null }>;
    keys?: string[];
    /** Keys saved on the Ensemble account, which a paired computer uses. */
    accountKeys?: string[];
    /** The coding agents the runtime's check found (`GET /api/subscriptions`). */
    localAgents?: SubscriptionAgent[];
  } = {},
) {
  const calls: Array<{ what: string; body?: unknown }> = [];
  let decisions = input.decisions ?? [];
  let localAgents = input.localAgents ?? [];
  let started = 0;
  const steps = new Map(Object.entries(input.runs ?? {}).map(([id, list]) => [id, [...list]]));
  const api = {
    discovery: { port: 1234, token: "t" },
    workspace: async () => input.workspace ?? empty,
    decisions: async () => decisions,
    job: async (id: string) => {
      const list = steps.get(id);
      if (list?.length) {
        const waiting = list[0]!.hold && !calls.some((call) => call.what.startsWith("decide "));
        const step = list.length > 1 && !waiting ? list.shift()! : list[0]!;
        return { job: { ...job(id, "Chat", step.status), summary: step.summary ?? null, error: step.error ?? null }, log: step.log, events: [] };
      }
      return { job: (input.workspace?.waiting ?? []).concat(input.workspace?.running ?? []).find((row) => row.id === id) ?? job(id, "x", "running"), log: "step one\nstep two", events: [] };
    },
    decide: async (id: string, body: unknown) => {
      calls.push({ what: `decide ${id}`, body });
      decisions = decisions.filter((row) => row.id !== id);
    },
    settings: async () => ({ runProfiles: [], defaultRunProfileId: null, orchestration: {}, models: { medium: { provider: "anthropic", model: "claude-x" } }, assistant: { writePolicy: "preview" } }),
    guard: async () => ({ root: "/w", sandbox: { mechanism: "seatbelt", osSandbox: true, strength: "strong" } }),
    json: async (path: string, init?: { body?: unknown }) => {
      calls.push({ what: path, body: init?.body });
      if (path === "/api/tasks") return { task: { id: "new-task" } };
      if (path === "/api/agent/assign") return { jobId: input.runs ? `chat-${(started += 1)}` : "new-job" };
      return {};
    },
    chat: async (body: unknown, onFrame: (frame: ChatFrame) => void) => {
      calls.push({ what: "chat", body });
      for (const frame of input.frames ?? []) onFrame(frame);
    },
    apply: async (body: unknown) => {
      calls.push({ what: "apply", body });
      return { summary: "Started Claude Code on “Fix it” (job j1)" };
    },
    stopChat: async () => undefined,
    stopJob: async () => undefined,
    retryJob: async () => ({ jobId: "again" }),
    models: async () => ({ providers: [], runtime: true }),
    agentApps: async () => ({ available: true, agents: input.agents ?? [] }),
    localAgents: async (fresh = false) => {
      calls.push({ what: fresh ? "agents check" : "agents" });
      return localAgents;
    },
    // As the runtime answers: every provider, with "none" where there is no key.
    modelKeys: async () => ({
      credentials: ["google", "openai", "anthropic", "mistral", "kimi", "qwen", "openrouter", "copilot", "cursor", "ollama"].map((provider) => ({
        provider,
        source: input.keys?.includes(provider) ? "you" : (input.accountKeys?.includes(provider) ? "account" : "none"),
        hint: null,
      })),
    }),
    trust: async (path: string) => ({ id: "r", path }),
  } as unknown as LocalApi;
  /** A decision arrives while the app runs (an agent asks something). */
  const ask = (decision: Decision) => {
    decisions = [...decisions, decision];
  };
  /** What the runtime's agent check finds from now on (say, after `copilot login`). */
  const setLocalAgents = (agents: SubscriptionAgent[]) => {
    localAgents = agents;
  };
  return { api, calls, ask, setLocalAgents };
}

/** GitHub Copilot as the runtime's check reports it, with two of a plan's models. */
export function copilotAgent(extra: Partial<SubscriptionAgent> = {}): SubscriptionAgent {
  return {
    id: "copilot-cli",
    via: "cli",
    version: "1.0.4",
    signedIn: true,
    account: "mira-chen",
    models: [
      { id: "auto", label: "Auto (Copilot picks)", isDefault: true },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        contexts: [
          { id: "default", label: "200K (standard)", tokens: 200_000 },
          { id: "long_context", label: "922K (long context)", tokens: 922_000 },
        ],
        vision: true,
        cost: "low cost",
        description: "OpenAI",
      },
    ],
    typedModels: true,
    problem: null,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

export const ops: Ops = {
  signIn: async () => ({ email: "me@example.com", paired: true }),
  signOut: async () => [],
  runnerService: async () => "Installed.",
  savePrefs: () => undefined,
  connectHook: async () => "Connected.",
  connectedHooks: async () => [],
};
