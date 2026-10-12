/** A stand-in for this computer's runtime, for the app's tests. */
import type { Ops } from "./app.js";
import type { ChatFrame, Decision, LocalApi, Workspace } from "./local.js";

export const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function fakeApi(input: { workspace?: Workspace; decisions?: Decision[]; frames?: ChatFrame[] } = {}) {
  const calls: Array<{ what: string; body?: unknown }> = [];
  let decisions = input.decisions ?? [];
  const api = {
    discovery: { port: 1234, token: "t" },
    workspace: async () => input.workspace ?? empty,
    decisions: async () => decisions,
    job: async (id: string) => ({ job: (input.workspace?.waiting ?? []).concat(input.workspace?.running ?? []).find((row) => row.id === id) ?? job(id, "x", "running"), log: "step one\nstep two", events: [] }),
    decide: async (id: string, body: unknown) => {
      calls.push({ what: `decide ${id}`, body });
      decisions = decisions.filter((row) => row.id !== id);
    },
    settings: async () => ({ runProfiles: [], defaultRunProfileId: null, orchestration: {}, models: { medium: { provider: "anthropic", model: "claude-x" } }, assistant: { writePolicy: "preview" } }),
    guard: async () => ({ root: "/w", sandbox: { mechanism: "seatbelt", osSandbox: true, strength: "strong" } }),
    json: async (path: string, init?: { body?: unknown }) => {
      calls.push({ what: path, body: init?.body });
      if (path === "/api/tasks") return { task: { id: "new-task" } };
      if (path === "/api/agent/assign") return { jobId: "new-job" };
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
    agentApps: async () => ({ available: true, agents: [] }),
    modelKeys: async () => ({ credentials: [] }),
    trust: async (path: string) => ({ id: "r", path }),
  } as unknown as LocalApi;
  return { api, calls };
}

export const ops: Ops = {
  signIn: async () => ({ email: "me@example.com", paired: true }),
  signOut: async () => [],
  runnerService: async () => "Installed.",
  savePrefs: () => undefined,
  connectHook: async () => "Connected.",
  connectedHooks: async () => [],
};
