/**
 * The Code suite: the Code tab's agent on the owner's computer, driven as the Code tab drives it
 * (`POST /api/agent/threads`, then each message as `POST /api/agent/assign` with `chat` and `surface:
 * "code"`, `/api/agent/threads/:id/fork` for a fork), in a small git repository in the computer's own
 * workspace folder, where Code may work. A change across files with tests and Ensemble's verification run,
 * a fact in Ensemble that changes between two turns of one session, and a new session that takes over
 * from the earlier one with a handoff record (docs/16 §9, DESIGN §11, Cursor study 08).
 */
import { join } from "node:path";
import { asserts, check, norm } from "../lib/grade.js";
import { seedTask } from "../lib/fixtures.js";
import type { Task, TaskContext } from "../lib/types.js";
import { changedFiles, filesIn, gitRepo, hiddenTests, nodeTests, readText } from "./helpers.js";

const CODE_MS = 15 * 60_000;
const PACKAGE = JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2);

/** A repository for the task in the computer's own workspace folder, where the Code tab may work without settings. */
async function repo(ctx: TaskContext, name: string, files: Record<string, string>): Promise<string> {
  const path = join(ctx.computer.dirs.workspace, `${ctx.task.id}-${ctx.repeat + 1}`, name);
  await gitRepo(path, files);
  ctx.data.repo = path;
  return path;
}

/** One message to the Code tab's agent, as the Code tab sends it: answers the new run's id. */
function assignment(ctx: TaskContext, message: string, continueFrom?: string): Record<string, unknown> {
  return {
    engine: ctx.world.agent,
    model: ctx.world.model,
    instructions: message,
    folder: ctx.data.repo as string,
    deviceId: ctx.deviceId,
    chat: true,
    surface: "code",
    branchMode: "as-is",
    markDone: false,
    delivery: "local",
    mode: "review",
    sandbox: false,
    ...(continueFrom ? { continueFromJobId: continueFrom } : {}),
  };
}

async function newThread(ctx: TaskContext, message: string): Promise<string> {
  const made = await ctx.api<{ thread: { id: string } }>("POST", "/api/agent/threads", { deviceId: ctx.deviceId, folder: ctx.data.repo as string, message });
  return made.thread.id;
}

async function send(ctx: TaskContext, thread: string, message: string, continueFrom?: string): Promise<string> {
  const made = await ctx.api<{ jobId: string }>("POST", "/api/agent/assign", { taskId: thread, ...assignment(ctx, message, continueFrom) });
  return made.jobId;
}

/** The agent session a run worked in (its `engine` event), as the computer reported it. */
async function sessionOf(ctx: TaskContext, jobId: string): Promise<string | null> {
  const events = await ctx.world.prisma.workspaceEvent.findMany({ where: { jobId, kind: "engine" }, select: { data: true } });
  for (const event of events) {
    const session = (event.data as { session?: unknown } | null)?.session;
    if (typeof session === "string") return session;
  }
  return null;
}

type Turn = { id: string; status: string; summary?: string | null; completion?: unknown; packet?: unknown; handoff?: unknown };

/** A thread as the Code tab reads it: its turns with their states (and, where the checkout keeps them, completion, packet and handoff). */
async function threadTurns(ctx: TaskContext, thread: string): Promise<Turn[]> {
  const answer = await ctx.request("GET", `/api/agent/threads/${thread}`);
  return ((answer.json() as { turns?: Turn[] } | null)?.turns ?? []).map((turn) => ({ id: turn.id, status: turn.status, summary: turn.summary ?? null, completion: turn.completion ?? null, packet: turn.packet ?? null, handoff: turn.handoff ?? null }));
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// A change across two modules, with tests, and Ensemble's verification run.

const MONEY = `/** "$5.00" for 5. */
export function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}
`;
const INVOICE = `import { formatMoney } from "./money.js";

/** The total of an invoice's lines ({ qty, price }), formatted. */
export function invoiceTotal(lines) {
  const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  return formatMoney(total);
}
`;
const MONEY_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "../src/money.js";

test("dollars by default", () => assert.equal(formatMoney(5), "$5.00"));
`;
const INVOICE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { invoiceTotal } from "../src/invoice.js";

test("sums the lines", () => assert.equal(invoiceTotal([{ qty: 2, price: 3 }]), "$6.00"));
`;
const CURRENCY_HIDDEN = (root: string) => `import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from ${JSON.stringify(`file://${join(root, "src/money.js")}`)};
import { invoiceTotal } from ${JSON.stringify(`file://${join(root, "src/invoice.js")}`)};

test("formatMoney: dollars by default, euros on request", () => {
  assert.equal(formatMoney(5), "$5.00");
  assert.equal(formatMoney(5, "USD"), "$5.00");
  assert.equal(formatMoney(5, "EUR"), "€5.00");
  assert.equal(formatMoney(1234.5, "EUR"), "€1234.50");
});
test("invoiceTotal passes the currency on", () => {
  assert.equal(invoiceTotal([{ qty: 2, price: 3 }]), "$6.00");
  assert.equal(invoiceTotal([{ qty: 2, price: 3 }], "EUR"), "€6.00");
});
`;

const multiFile: Task = {
  id: "multi-file-change-with-tests",
  suite: "code",
  category: "code",
  title: "A change across two modules with tests for both, in the Code tab: the tests pass and Ensemble's own verification run passes",
  timeoutMs: CODE_MS,
  setup: async (ctx) => {
    await repo(ctx, "invoice", { "package.json": PACKAGE, "src/money.js": MONEY, "src/invoice.js": INVOICE, "test/money.test.js": MONEY_TEST, "test/invoice.test.js": INVOICE_TEST, "README.md": "# invoice\n\n`npm test` runs the tests.\n" });
  },
  steps: [
    {
      act: {
        what: "a Code tab message to the agent in the invoice repository",
        run: async (ctx) => {
          const message = "Add currency support: formatMoney(amount, currency) takes 'USD' (the default, \"$5.00\") or 'EUR' (\"€5.00\"), and invoiceTotal(lines, currency) passes the currency on. Add EUR tests to both test files and make sure all the tests pass.";
          ctx.data.thread = await newThread(ctx, message);
          ctx.data.job = await send(ctx, ctx.data.thread as string, message);
          return `run ${(ctx.data.job as string).slice(0, 8)}`;
        },
      },
      wait: "quiet",
      quietMs: 13 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const root = ctx.data.repo as string;
    const turns = await threadTurns(ctx, ctx.data.thread as string);
    return {
      changed: await changedFiles(root),
      tests: await nodeTests(root),
      hidden: await hiddenTests(ctx, "currency.hidden.test.js", CURRENCY_HIDDEN(root)),
      eurTests: ["test/money.test.js", "test/invoice.test.js"].filter((file) => /EUR|€/.test(readText(join(root, file)) ?? "")),
      turn: turns[0] ?? null,
    };
  },
  checks: ({ ev }) => {
    const changed = (ev.extra.changed as string[]) ?? [];
    const tests = ev.extra.tests as { pass: boolean; summary: string };
    const hidden = ev.extra.hidden as { pass: boolean; summary: string };
    const turn = ev.extra.turn as Turn | null;
    const completion = record(turn?.completion);
    const checks = record(completion.checks);
    return [
      check("both modules changed", changed.includes("src/money.js") && changed.includes("src/invoice.js"), "state", { evidence: true, note: changed.join(", ") || "nothing" }),
      check("EUR tests in both test files", ((ev.extra.eurTests as string[]) ?? []).length === 2, "state", { evidence: true, note: ((ev.extra.eurTests as string[]) ?? []).join(", ") || "none" }),
      check("its tests pass", tests.pass, "state", { evidence: true, note: tests.summary }),
      check("the hidden acceptance tests pass", hidden.pass, "state", { evidence: true, note: hidden.summary }),
      check("the turn finished", turn?.status === "succeeded", "state", { evidence: true, note: turn?.status ?? "no turn" }),
      check("Ensemble's own verification run passed", checks.state === "passed", "state", { evidence: true, note: turn?.completion ? `checks ${String(checks.state)}: ${String(checks.passed ?? 0)} passed, ${String(checks.failed ?? 0)} failed, ${String(checks.notRun ?? 0)} not run` : "no verification run recorded" }),
    ];
  },
};

// A fact in Ensemble changes between two turns of one session.

const contextDelta: Task = {
  id: "resume-picks-up-context-delta",
  suite: "code",
  category: "code",
  title: "A task the thread mentions is renamed between two turns of one session: the next turn uses the new name",
  timeoutMs: CODE_MS,
  setup: async (ctx) => {
    await repo(ctx, "labels", { "README.md": "# labels\n\nRelease tooling.\n", "VERSION.txt": "" });
    ctx.data.fact = await seedTask(ctx, { title: "Release label is BLUE-HERON" });
  },
  steps: [
    {
      act: {
        what: "turn 1: write the label from the mentioned task",
        run: async (ctx) => {
          const message = `Write the current release label from the task I mention into VERSION.txt (just the label, one line).\n\n(Mentioned in Ensemble: @Release label is BLUE-HERON [task] ensemble://task/${ctx.data.fact as string})`;
          ctx.data.thread = await newThread(ctx, message);
          ctx.data.first = await send(ctx, ctx.data.thread as string, message);
          return `run ${(ctx.data.first as string).slice(0, 8)}`;
        },
      },
      wait: "quiet",
      quietMs: 10 * 60_000,
    },
    {
      act: {
        what: "rename the task to the new label, then turn 2 in the same session",
        run: async (ctx) => {
          ctx.data.versionAfterFirst = readText(join(ctx.data.repo as string, "VERSION.txt"));
          await ctx.api("PATCH", `/api/tasks/${ctx.data.fact as string}`, { title: "Release label is GREEN-OTTER" });
          ctx.data.second = await send(ctx, ctx.data.thread as string, "Now add a 'Release' section to README.md that names the current release label.", ctx.data.first as string);
          return `run ${(ctx.data.second as string).slice(0, 8)}`;
        },
      },
      wait: "quiet",
      quietMs: 10 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const turns = await threadTurns(ctx, ctx.data.thread as string);
    return {
      readme: readText(join(ctx.data.repo as string, "README.md")),
      sessions: [await sessionOf(ctx, ctx.data.first as string), await sessionOf(ctx, ctx.data.second as string)],
      packet: record(turns[1]?.packet).mode ?? null,
      statuses: turns.map((turn) => turn.status),
    };
  },
  checks: ({ ev, data }) => {
    const readme = String(ev.extra.readme ?? "");
    const [first, second] = (ev.extra.sessions as Array<string | null>) ?? [];
    return [
      check("the first turn wrote the label it was given", /BLUE-HERON/.test(String(data.versionAfterFirst ?? "")), "state", { evidence: true, note: norm(String(data.versionAfterFirst ?? "")).slice(0, 40) }),
      check("the second turn went on in the same agent session", Boolean(first && second && first === second), "trace", { evidence: true, note: `${first ? "a session" : "none"} then ${second === first ? "the same" : second ? "another" : "none"}; packet ${String(ev.extra.packet ?? "not recorded")}` }),
      check("README names the new label", /GREEN-OTTER/.test(readme), "state", { evidence: true, note: norm(readme).slice(0, 160) }),
      check("and not the old one", !/BLUE-HERON/.test(readme), "state", { evidence: true }),
    ];
  },
};

// A new session takes over from the earlier one.

const handoff: Task = {
  id: "handoff-to-another-agent",
  suite: "code",
  category: "code",
  title: "The owner forks a thread into a new agent session: a handoff record goes with it, the new session uses it, and nobody calls it lossless",
  timeoutMs: CODE_MS,
  requires: ["code-tab-harness"],
  setup: async (ctx) => {
    await repo(ctx, "deploy", { "README.md": "# deploy\n\nDeploy helpers.\n", "package.json": PACKAGE });
  },
  steps: [
    {
      act: {
        what: "turn 1: the owner gives a code to keep for later",
        run: async (ctx) => {
          const message = "For later in this thread: the deploy code is 4417. Don't write it into any file yet. For now, just create hello.js that prints hello.";
          ctx.data.thread = await newThread(ctx, message);
          ctx.data.first = await send(ctx, ctx.data.thread as string, message);
          return `run ${(ctx.data.first as string).slice(0, 8)}`;
        },
      },
      wait: "quiet",
      quietMs: 10 * 60_000,
    },
    {
      act: {
        what: "fork the thread at turn 1 into a new session",
        run: async (ctx) => {
          const made = await ctx.api<{ thread: { id: string }; jobId: string }>("POST", `/api/agent/threads/${ctx.data.thread as string}/fork`, {
            jobId: ctx.data.first as string,
            turn: assignment(ctx, "Write the deploy code I gave you earlier into DEPLOY.txt (just the number), and tell me where you got it from."),
          });
          ctx.data.fork = made.thread.id;
          ctx.data.second = made.jobId;
          return `fork ${made.thread.id.slice(0, 8)}`;
        },
      },
      wait: "quiet",
      quietMs: 10 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const root = ctx.data.repo as string;
    const turns = await threadTurns(ctx, ctx.data.fork as string);
    const files = filesIn(join(root, ".ensemble", "handoff"));
    const records = files.map((file) => readText(join(root, ".ensemble", "handoff", file), 60_000) ?? "").join("\n\n");
    const job = await ctx.world.prisma.workspaceJob.findUnique({ where: { id: ctx.data.second as string }, select: { summary: true, status: true } });
    return {
      handoff: turns[0]?.handoff ?? null,
      records,
      deploy: readText(join(root, "DEPLOY.txt")),
      sessions: [await sessionOf(ctx, ctx.data.first as string), await sessionOf(ctx, ctx.data.second as string)],
      summary: job?.summary ?? "",
      status: job?.status ?? null,
    };
  },
  checks: ({ ev }) => {
    const handoffRow = record(ev.extra.handoff);
    const records = String(ev.extra.records ?? "");
    const [first, second] = (ev.extra.sessions as Array<string | null>) ?? [];
    const summary = String(ev.extra.summary ?? "");
    const lossless = /\blossless\b/i.test(summary) || asserts(summary, /\b(the )?(full|complete|entire|whole) (earlier |previous )?(history|conversation|transcript|context)\b/i);
    return [
      check("a handoff record went with the new session", Boolean(ev.extra.handoff) || records.length > 0, "state", { evidence: true, note: ev.extra.handoff ? `reason ${String(handoffRow.reason ?? "?")}` : records ? "a record file" : "none" }),
      check("a new agent session took over", Boolean(first && second && first !== second), "trace", { evidence: true }),
      check("the record carried the owner's words with the code", /4417/.test(records), "state", { evidence: true }),
      check("the record says what it does not carry", /(not a full history|not carried|notCarried|lossy)/i.test(records), "state", { evidence: true }),
      check("the new session used it", /4417/.test(String(ev.extra.deploy ?? "")), "state", { evidence: true, note: norm(String(ev.extra.deploy ?? "none")).slice(0, 40) }),
      check("nobody called it lossless or a full history", !lossless, "reply", { note: norm(summary).slice(0, 160) }),
    ];
  },
};

export const CODE: Task[] = [multiFile, contextDelta, handoff];
