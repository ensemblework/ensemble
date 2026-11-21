/**
 * The work suite: a node set to work for the owner beyond one reply. A routine with its schedule and
 * action, a connected app reached through Ensemble's connection (a fake MCP server, no real account),
 * and a task handed to a coding agent that is done only when a branch with passing tests is on the
 * remote (a bare git repository on this computer; nothing reaches GitHub).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, mentionsDate, norm, run } from "../lib/grade.js";
import { seedTask, shareFolder } from "../lib/fixtures.js";
import { startFakeMcp, type FakeMcp } from "../lib/mcp-fake.js";
import type { Task, TaskContext } from "../lib/types.js";
import { assistant, gitRepo, lastAnswer, nodeTests, hiddenTests } from "./helpers.js";

const WORK_MS = 12 * 60_000;

// A routine: weekdays at 8:30, a summary of the day's tasks.

/** Whether a cron's day-of-week field means Monday to Friday. */
export function weekdays(field: string): boolean {
  const days = new Set<number>();
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = (text: string) => (/^\d$/.test(text) ? Number(text) % 7 : names.indexOf(text.toLowerCase().slice(0, 3)));
  for (const part of field.split(",")) {
    const [from, to] = part.split("-");
    if (from === undefined || day(from) < 0) return false;
    const end = to === undefined ? day(from) : day(to);
    if (end < 0) return false;
    for (let at = day(from); at <= end; at += 1) days.add(at);
  }
  return [1, 2, 3, 4, 5].every((value) => days.has(value)) && !days.has(0) && !days.has(6);
}

type Routine = { kind: string; title: string; cron: string | null; timezone: string; instruction: string; nextRunAt: string | null; status: string };

const routine: Task = {
  id: "create-a-routine",
  suite: "work",
  category: "work",
  title: "\"Every weekday at 8:30, a summary of my tasks due that day\": one routine with that schedule, time zone and action",
  timeoutMs: WORK_MS,
  setup: assistant,
  steps: [{ say: "Every weekday at 8:30 in the morning, send me a short summary of my tasks due that day." }],
  collect: async (ctx) => {
    const prisma = ctx.world.prisma;
    const nodeRoutines = await prisma.nodeRoutine.findMany({ where: { userId: ctx.owner.id } });
    const assistantRoutines = await prisma.assistantRoutine.findMany({ where: { userId: ctx.owner.id, builtInKey: null } });
    const routines: Routine[] = [
      ...nodeRoutines.map((row) => ({ kind: "node", title: row.title, cron: row.cron, timezone: row.timezone, instruction: `${row.instruction ?? ""} ${JSON.stringify(row.template ?? "")}`, nextRunAt: row.nextRunAt?.toISOString() ?? null, status: row.status })),
      ...assistantRoutines.map((row) => ({ kind: "assistant", title: row.title, cron: row.cron, timezone: row.timezone, instruction: row.instruction, nextRunAt: row.nextRunAt?.toISOString() ?? null, status: row.status })),
    ];
    return { routines };
  },
  checks: ({ ev, data }) => {
    const routines = (ev.extra.routines as Routine[]) ?? [];
    const one = routines.length === 1 ? routines[0]! : null;
    const [minute, hour, dom, month, dow] = (one?.cron ?? "").trim().split(/\s+/);
    const zone = String(data.timeZone);
    const next = one?.nextRunAt ? new Date(one.nextRunAt) : null;
    const local = next ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next) : "";
    return [
      check("one routine", routines.length === 1, "state", { evidence: true, note: routines.map((row) => `${row.kind} “${row.title}” ${row.cron ?? ""}`).join(" | ") || "none" }),
      check("weekdays at 8:30", Boolean(one) && Number(minute) === 30 && Number(hour) === 8 && dom === "*" && month === "*" && weekdays(dow ?? ""), "state", { evidence: true, note: one?.cron ?? "no schedule" }),
      check("in the owner's time zone", one?.timezone === zone, "state", { evidence: true, note: `${one?.timezone ?? "none"} (owner ${zone})` }),
      check("its action is a summary of the tasks due that day", Boolean(one) && /task/i.test(one!.instruction) && /(due|today|that day|this day)/i.test(one!.instruction), "state", { evidence: true, note: norm(one?.instruction ?? "").slice(0, 160) }),
      check("its next run is a weekday at 08:30", !next || (/^(Mon|Tue|Wed|Thu|Fri)/.test(local) && local.endsWith("08:30")), "state", { evidence: true, note: local || "not scheduled" }),
      check("active", one?.status === "active", "state", { evidence: true, note: one?.status ?? "none" }),
    ];
  },
};

// A connected app, through Ensemble's connection.

/** The fake CRM of each task run. */
const servers = new WeakMap<TaskContext, FakeMcp>();

const CUSTOMER = "Acme Corp (customer id cus_1042): plan Gold, 40 seats, contract renewal date 2027-03-14, account owner Priya Nair.";

const connectedApp: Task = {
  id: "connected-app-through-bridge",
  suite: "work",
  category: "work",
  title: "A connected CRM (a fake MCP server on this computer): the node looks the customer up and adds one note through Ensemble's connection",
  timeoutMs: WORK_MS,
  setup: async (ctx) => {
    await assistant(ctx);
    const server = await startFakeMcp({
      name: "Fieldnote CRM",
      token: `eval-crm-${ctx.owner.id.slice(0, 8)}`,
      tools: [
        { name: "list_customers", description: "Lists the CRM's customers with their ids.", readOnly: true, inputSchema: { type: "object", properties: {} }, run: () => "Acme Corp (cus_1042); Birch Labs (cus_2210)." },
        {
          name: "find_customer",
          description: "Finds a customer by name: plan, seats, renewal date and account owner.",
          readOnly: true,
          inputSchema: { type: "object", properties: { name: { type: "string", description: "The customer's name" } }, required: ["name"] },
          run: (args) => (/acme/i.test(String(args.name ?? "")) ? CUSTOMER : `No customer named ${String(args.name ?? "")}.`),
        },
        {
          name: "add_note",
          description: "Adds a note to a customer's record.",
          inputSchema: { type: "object", properties: { customerId: { type: "string", description: "The customer's id, such as cus_1042" }, note: { type: "string" } }, required: ["customerId", "note"] },
          run: (args) => `Note saved on ${String(args.customerId ?? "?")}.`,
        },
      ],
    });
    ctx.onCleanup(() => server.close());
    servers.set(ctx, server);
    const connected = await ctx.api<{ status?: string; error?: string }>("POST", "/api/mcp-connections", { url: server.url, name: "Fieldnote CRM", token: server.token });
    if (connected.status !== "connected") throw new Error(`The fake CRM did not connect: ${JSON.stringify(connected).slice(0, 200)}`);
  },
  steps: [{ say: "Using my Fieldnote CRM connection: when does Acme Corp's contract renew? And add a note to their record: 'Call about the renewal'." }],
  collect: async (ctx) => ({ calls: servers.get(ctx)?.calls() ?? [] }),
  checks: ({ ev }) => {
    const calls = (ev.extra.calls as Array<{ tool: string; args: Record<string, unknown> }>) ?? [];
    const looked = calls.filter((call) => call.tool === "find_customer" && /acme/i.test(String(call.args.name ?? "")));
    const notes = calls.filter((call) => call.tool === "add_note");
    const answer = lastAnswer(ev);
    return [
      check("it looked Acme up in the CRM", looked.length >= 1, "trace", { evidence: true, note: calls.map((call) => call.tool).join(", ") || "no call reached the CRM" }),
      check("one note, on Acme's record, about the renewal", notes.length === 1 && notes[0]!.args.customerId === "cus_1042" && /renewal/i.test(String(notes[0]!.args.note ?? "")), "trace", { evidence: true, note: notes.map((call) => JSON.stringify(call.args).slice(0, 100)).join(" | ") || "none" }),
      check("the renewal date in the answer", mentionsDate(answer, "2027-03-14") || /14(th)? march,? 2027|march 14(th)?,? 2027/i.test(answer), "reply", { note: norm(answer).slice(0, 160) }),
    ];
  },
};

// A task handed to a coding agent, done when its branch is on the remote.

const PARSE_DATE = `/** Parses "DD/MM/YYYY" into { day, month, year }. */
export function parseDate(text) {
  const [day, month, year] = text.split("/").map(Number);
  return { day: month, month: day, year };
}
`;
const PARSE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { parseDate } from "../src/parse-date.js";

test("day, month and year", () => assert.deepEqual(parseDate("25/12/2026"), { day: 25, month: 12, year: 2026 }));
`;
const PARSE_HIDDEN = (root: string) => `import assert from "node:assert/strict";
import test from "node:test";
import { parseDate } from ${JSON.stringify(`file://${join(root, "src/parse-date.js")}`)};

test("parses DD/MM/YYYY", () => {
  assert.deepEqual(parseDate("01/02/2027"), { day: 1, month: 2, year: 2027 });
  assert.deepEqual(parseDate("31/12/1999"), { day: 31, month: 12, year: 1999 });
});
`;

/** The branches of a bare repository, with their commits. */
async function branches(bare: string): Promise<Record<string, string>> {
  const listed = await run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], { cwd: bare, timeoutMs: 30_000 });
  return Object.fromEntries(listed.output.split("\n").map((line) => line.trim().split(" ")).filter((parts) => parts.length === 2) as Array<[string, string]>);
}

const assignVerify: Task = {
  id: "assign-to-coding-agent-verify",
  suite: "work",
  category: "work",
  title: "A board task handed to a coding agent: done only when a branch with the fix and passing tests is on the remote (a local bare repository)",
  timeoutMs: 20 * 60_000,
  setup: async (ctx) => {
    await assistant(ctx);
    const bare = join(ctx.dir, "remote", "parsers.git");
    mkdirSync(bare, { recursive: true });
    if ((await run("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare })).code !== 0) throw new Error("git init --bare failed");
    const work = join(ctx.dir, "parsers");
    await gitRepo(work, { "package.json": JSON.stringify({ name: "parsers", version: "1.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2), "src/parse-date.js": PARSE_DATE, "test/parse-date.test.js": PARSE_TEST, "README.md": "# parsers\n\n`npm test` runs the tests.\n" });
    for (const args of [["remote", "add", "origin", bare], ["push", "-q", "origin", "main"]]) {
      const done = await run("git", args, { cwd: work, timeoutMs: 30_000 });
      if (done.code !== 0) throw new Error(`git ${args[0]} failed: ${done.output.slice(0, 200)}`);
    }
    await shareFolder(ctx, "parsers", work);
    ctx.data.bare = bare;
    ctx.data.work = work;
    ctx.data.main = (await branches(bare)).main ?? null;
    ctx.data.task = await seedTask(ctx, { title: "Fix parseDate in the parsers repo", notes: "parseDate swaps the day and the month. Fix it on a new branch with the tests passing, and push that branch to origin. Done only when the branch is pushed." });
    // This task's runs may push: the eval's run profile, with git unlimited.
    const { saveSettings } = await import("../../../apps/hub-api/src/lib/settings.js");
    const { RunProfile } = await import("../../../packages/shared-types/src/index.js");
    await saveSettings(ctx.world.prisma, ctx.owner.id, {
      runProfiles: [RunProfile.parse({ id: "eval", name: "Eval", kind: "code", engine: ctx.world.agent, model: ctx.world.model, mode: "review", delivery: "push", deviceId: ctx.deviceId, sandbox: false })],
      defaultRunProfileId: "eval",
    });
  },
  steps: [
    {
      say: (ctx) => `Please hand the task 'Fix parseDate in the parsers repo' on my board to a coding agent on my computer, working in the parsers folder (${ctx.data.work as string}). It's done only when a branch with the fix and passing tests is pushed to origin; tell me the branch name then.`,
      quietMs: 17 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const bare = ctx.data.bare as string;
    const heads = await branches(bare);
    const pushed = Object.keys(heads).filter((name) => name !== "main" && name !== "master");
    const verified: Record<string, { tests: { pass: boolean; summary: string }; hidden: { pass: boolean; summary: string } }> = {};
    for (const name of pushed.slice(0, 3)) {
      const copy = join(ctx.world.dirs.root, "verify", `${ctx.task.id}-${ctx.repeat}-${name.replace(/[^a-z0-9-]/gi, "_")}`);
      await run("git", ["clone", "-q", "--branch", name, bare, copy], { cwd: ctx.world.dirs.root, timeoutMs: 60_000 });
      verified[name] = { tests: await nodeTests(copy), hidden: await hiddenTests(ctx, `parse-${Object.keys(verified).length}.hidden.test.js`, PARSE_HIDDEN(copy)) };
    }
    const remotes = await run("git", ["remote", "-v"], { cwd: ctx.data.work as string, timeoutMs: 30_000 });
    const board = await ctx.world.prisma.task.findUnique({ where: { id: ctx.data.task as string }, select: { status: true } });
    const jobs = await ctx.world.prisma.workspaceJob.findMany({ where: { userId: ctx.owner.id }, select: { status: true, results: true } });
    return { heads, pushed, verified, remotes: remotes.output.trim().split("\n"), status: board?.status ?? null, results: jobs.map((row) => JSON.stringify(row.results ?? [])) };
  },
  checks: ({ ev, data }) => {
    const heads = (ev.extra.heads as Record<string, string>) ?? {};
    const pushed = (ev.extra.pushed as string[]) ?? [];
    const verified = (ev.extra.verified as Record<string, { tests: { pass: boolean; summary: string }; hidden: { pass: boolean; summary: string } }>) ?? {};
    const good = pushed.filter((name) => verified[name]?.tests.pass && verified[name]?.hidden.pass);
    const answer = lastAnswer(ev);
    const remotes = (ev.extra.remotes as string[]) ?? [];
    const results = (ev.extra.results as string[]) ?? [];
    return [
      check("a branch was pushed to origin", pushed.length > 0, "state", { evidence: true, note: pushed.join(", ") || "only main" }),
      check("its tests pass", pushed.some((name) => verified[name]?.tests.pass), "state", { evidence: true, note: pushed.map((name) => `${name}: ${verified[name]?.tests.summary ?? "not checked"}`).join(" | ") || "no branch" }),
      check("the fix is on it (hidden tests)", good.length > 0, "state", { evidence: true, note: pushed.map((name) => `${name}: ${verified[name]?.hidden.summary ?? "not checked"}`).join(" | ") || "no branch" }),
      check("main was left as it was", heads.main === data.main, "state", { evidence: true }),
      check("done only with the branch, and the owner heard its name", (ev.extra.status !== "done" || good.length > 0) && good.some((name) => answer.includes(name)), "reply", { note: `task ${String(ev.extra.status)}; ${norm(answer).slice(0, 120)}` }),
      check("nothing reached GitHub", remotes.every((line) => !/github\.com/i.test(line)) && results.every((row) => !/github\.com/i.test(row)), "state", { evidence: true, note: remotes.join(" | ") }),
    ];
  },
};

export const WORK: Task[] = [routine, connectedApp, assignVerify];
