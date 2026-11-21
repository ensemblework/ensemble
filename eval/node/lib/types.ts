/**
 * The shapes shared by the eval harness, its tasks and its reports (eval/node/README.md).
 */
import type { World, Owner } from "./world.js";

export type Suite = "core" | "crew" | "hard";

/** Where a check's answer comes from: the reply text, the database or files, the trace of tools, live ground truth, or the rubric judge. */
export type CheckKind = "reply" | "state" | "trace" | "truth" | "judge";

/**
 * One check of a task run. `evidence` marks a check that looks at what really exists (a row, a file, a
 * picture, a tool that ran), not at words: a verified pass needs every evidence check to pass.
 */
export type Check = { name: string; pass: boolean; kind: CheckKind; evidence?: boolean; note?: string };

export type Verdict = { score: number; reason: string; ok: boolean };
export type Judge = (rubric: string, answer?: string) => Promise<Verdict>;

/** A node the task made, by the key the task gave it. */
export type MadeNode = { id: string; slug: string; roomId: string };

/** One owner message, sent after an optional wait, then followed by a wait for quiet unless `wait` is "none". */
export type Step = {
  say: string | ((ctx: TaskContext) => string);
  /** Key of the room in `ctx.rooms`; "main" when left out. */
  room?: string;
  /** Wait for this before sending: it answers what it saw (truthy) or null while it waits. */
  before?: { what: string; until: (ctx: TaskContext) => Promise<string | null>; timeoutMs?: number };
  wait?: "quiet" | "none";
  /** The longest the quiet wait lasts after this message; past it the task goes on and notes what still ran. */
  quietMs?: number;
  /** After the quiet wait, keep watching (cards, trace) this long before the next step or the grading. */
  holdMs?: number;
};

export type TaskContext = {
  world: World;
  owner: Owner;
  task: Task;
  repeat: number;
  /** The task's own folder on this computer, made fresh for this run. */
  dir: string;
  deviceId: string;
  nodes: Record<string, MadeNode>;
  rooms: Record<string, string>;
  /** What setup wants the checks to know (fixture ground truth, ids, ports). Saved with the evidence. */
  data: Record<string, unknown>;
  log: (line: string) => void;
  /** Things to stop or remove when the run ends (a local web server, say). */
  onCleanup: (work: () => Promise<void> | void) => void;
  /** A node from a template, on the run's agent and model; its DM becomes `rooms[key]` (and `rooms.main` for the first). */
  makeNode: (key: string, templateId: string, options?: { name?: string; slug?: string }) => Promise<MadeNode>;
  /** A crew of nodes made before, led by `lead`; its room becomes `rooms[key]`. */
  makeCrew: (key: string, title: string, members: string[], lead: string) => Promise<string>;
  /** A call to Ensemble's API as the owner; throws unless it answers 2xx. */
  api: <T = Record<string, unknown>>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => Promise<T>;
};

export type Message = {
  id: string;
  room: string;
  seq: number;
  author: string;
  kind: string;
  type: string | null;
  status: string | null;
  body: string;
  media: Array<{ evidenceId: string | null; kind: string | null; name: string | null; mime: string | null; size: number | null }>;
  tools: Array<{ name: string; state: string }>;
  at: string;
};

export type ToolCall = { name: string; ok: boolean; input: string; output: string; node: string | null };

export type Evidence = {
  /** The nodes' text replies the owner can read, oldest first. */
  replies: string[];
  /** The replies after each owner message (one entry per message the owner sent, in order), joined. */
  answers: string[];
  messages: Message[];
  /** Ensemble's tools the nodes called (assistant_messages.toolCalls). */
  tools: ToolCall[];
  /** The agent's own calls (its shell, files, web, and Ensemble's tools over MCP), from its session log when it keeps one. */
  agentTools: Array<{ name: string; session: string }>;
  turns: Array<{ node: string; reason: string; status: string; error: string | null; receipts: unknown[]; startedAt: string; finishedAt: string | null }>;
  tasks: Array<{ id: string; title: string; notes: string; description: string; status: string; owner: string; due: string | null; startsAt: string | null; createdBy: string; createdAt: string; seeded: boolean }>;
  pages: Array<{ id: string; title: string; text: string; taskId: string | null; createdAt: string; seeded: boolean }>;
  memories: Array<{ node: string; content: string }>;
  routines: Array<{ kind: string; id: string; title: string; when: string | null; detail: string }>;
  missions: Array<{ id: string; status: string; goal: string | null; steps: Array<{ id: string; node: string; kind: string; status: string; outcome: string; attempt: number; result: string | null }> }>;
  runs: Array<{ id: string; node: string; jobId: string; status: string; sessionId: string | null; planStep: string | null; prompt: string }>;
  jobs: Array<{ id: string; provider: string; model: string; status: string; error: string | null; kind: string }>;
  cards: CardLog[];
  /** Copilot (or other agent) sessions the run made, by id. */
  sessions: string[];
  usage: Usage;
  extra: Record<string, unknown>;
};

export type Usage = {
  /** Node turns Ensemble ran (each one agent run on a subscription). */
  turns: number;
  /** Model calls the agent made inside those runs, from its session logs (0 when it keeps none). */
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** The agent's AI credits as it reports them (Copilot: nano AIU / 1e9). */
  credits: number;
  /** Ensemble's own record (metric_events `model.call`): one per turn, with the tokens the agent reported. */
  ensembleCalls: number;
  ensembleTokensIn: number;
  ensembleTokensOut: number;
  models: string[];
};

export type CardLog = { id: string; type: string; answer: string; answered: boolean; at: string; note?: string };

export type GradeInput = { ev: Evidence; truth: Record<string, string>; judge: Judge; data: Record<string, unknown> };

export type Task = {
  id: string;
  suite: Suite;
  category: string;
  /** One line for the README and the summary. */
  title: string;
  /** Default 10 minutes (core and hard) or 25 minutes (crew). */
  timeoutMs?: number;
  setup: (ctx: TaskContext) => Promise<void>;
  steps: Step[];
  /** Live ground truth, fetched once per run and cached (lib/truth.ts). */
  truth?: () => Promise<Record<string, string>>;
  /** What this task's checks need beyond the common evidence (file contents, a hidden test run). Saved, so a regrade can read it. */
  collect?: (ctx: TaskContext, ev: Evidence) => Promise<Record<string, unknown>>;
  checks: (input: GradeInput) => Check[] | Promise<Check[]>;
  /** Replies that would be false if nothing backs them, with what backs them (lib/grade.ts `falseClaims`). */
  claims?: Array<{ says: RegExp; backed: (ev: Evidence) => boolean; what: string }>;
};

export type RunMetrics = {
  wallMs: number;
  turns: number;
  failedTurns: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  credits: number;
  ensembleCalls: number;
  ensembleTools: number;
  agentTools: number;
  approvals: number;
  unanswered: number;
  errors: number;
  /** Turns that failed because the agent ended without a reply ("The model returned no answer"). Absent in older result files. */
  noAnswerTurns?: number;
  /** Error messages posted in the chat for the owner to read. Absent in older result files. */
  errorMessages?: number;
};

export type RunResult = {
  task: string;
  suite: Suite;
  category: string;
  repeat: number;
  status: "done" | "timeout" | "error";
  score: number;
  pass: boolean;
  verifiedPass: boolean;
  checks: Check[];
  falseClaims: string[];
  metrics: RunMetrics;
  tools: string[];
  agentToolNames: string[];
  models: string[];
  cards: CardLog[];
  errors: string[];
  sessions: string[];
  trace: string;
  startedAt: string;
};

export type CleanupEntry = { agent: string; id: string; kind: string; task: string | null; deleted: boolean; note?: string };

export type Saved = {
  label: string;
  stamp: string;
  commit: string;
  agent: string;
  model: string;
  judgeModel: string;
  tasks: string[];
  repeat: number;
  startedAt: string;
  finishedAt: string | null;
  results: RunResult[];
  cleanup: CleanupEntry[];
  notes: string[];
};
