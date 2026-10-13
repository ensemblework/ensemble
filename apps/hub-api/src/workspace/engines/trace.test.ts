/**
 * An engine's work as run steps: tool calls keep their place when the result comes back, open
 * calls are closed at the end, text is cut and scrubbed, and a run keeps a bounded number of steps.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EngineTrace, SECRET_OUTPUT, TRACE_MAX_STEPS, TRACE_PREVIEW } from "./trace.js";

type Row = Record<string, unknown> & { index: number };

function fakePrisma() {
  const rows = new Map<number, Row>();
  const prisma = {
    runStep: {
      upsert: async ({ where, create, update }: { where: { runId_index: { index: number } }; create: Row; update: Row }) => {
        const index = where.runId_index.index;
        rows.set(index, rows.has(index) ? { ...rows.get(index)!, ...update } : create);
        return rows.get(index);
      },
    },
  };
  return { rows, prisma };
}

test("a tool call is one step: running, then done with its output and time; thinking and messages in order", async () => {
  const { rows, prisma } = fakePrisma();
  const trace = new EngineTrace({ prisma: prisma as never, runId: "run-1" }, "claude-code");
  await trace.thinking("I should clone it.");
  await trace.toolStart("toolu_1", "Bash", { command: "git clone https://github.com/a/b" }, "$ git clone https://github.com/a/b");
  assert.equal(rows.get(1)?.status, "running");
  await trace.message("Cloned. Reading the README.", { model: "claude-sonnet-4-6", tokensIn: 10, tokensOut: 5 });
  await trace.toolEnd("toolu_1", "Done: Ensemble cloned it", true);
  await trace.toolStart("toolu_2", "Read", { file_path: "b/README.md" }, "Read b/README.md");
  await trace.toolEnd("toolu_2", "ENOENT", false);
  await trace.toolStart("toolu_3", "Grep", { pattern: "x" }, "Grep x");
  await trace.finish("## Summary\nDone.", { model: "claude-sonnet-4-6", tokensIn: 100, tokensOut: 50 });

  const titles = [...rows.values()].sort((a, b) => a.index - b.index).map((row) => [row.title, row.status]);
  assert.deepEqual(titles, [
    ["Thinking", "done"],
    ["$ git clone https://github.com/a/b", "done"],
    ["Message", "done"],
    ["Read b/README.md", "failed"],
    ["Grep x", "done"],
    ["Result", "done"],
  ]);
  const clone = rows.get(1)!;
  const call = (clone.toolCalls as Array<Record<string, unknown>>)[0]!;
  assert.equal(call.name, "Bash");
  assert.equal(call.ok, true);
  assert.equal(typeof call.ms, "number");
  assert.match(String(call.args), /git clone/);
  assert.equal(clone.output, "Done: Ensemble cloned it");
  assert.match(String(rows.get(3)!.error), /ENOENT/);
  assert.equal(rows.get(0)!.reasoning, "I should clone it.");
  assert.equal(rows.get(5)!.output, "## Summary\nDone.");
  assert.equal(rows.get(5)!.tokensIn, 100);
});

test("previews are cut and scrubbed; a run keeps at most TRACE_MAX_STEPS steps plus its result", async () => {
  const { rows, prisma } = fakePrisma();
  const trace = new EngineTrace({ prisma: prisma as never, runId: "run-2" }, "codex");
  await trace.toolStart("c1", "commandExecution", { command: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "echo token");
  await trace.toolEnd("c1", "x".repeat(TRACE_PREVIEW.output * 3), true);
  const first = rows.get(0)!;
  assert.equal(String(first.output).length <= TRACE_PREVIEW.output + 40, true, "output is a preview");
  assert.doesNotMatch(String((first.toolCalls as Array<{ args: string }>)[0]!.args), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/, "known secret shapes are redacted");
  for (let index = 0; index < TRACE_MAX_STEPS + 20; index += 1) await trace.message(`step ${index}`);
  await trace.finish("done");
  assert.equal(rows.size, TRACE_MAX_STEPS + 1);
});

test("without a run there is nothing to write", async () => {
  const { rows, prisma } = fakePrisma();
  const trace = new EngineTrace({ prisma: prisma as never, runId: "" }, "cursor");
  await trace.toolStart("a", "edit", {}, "edit");
  await trace.finish("done");
  assert.equal(rows.size, 0);
});

test("a result handled before its call was recorded is kept; a stopped run closes open calls without a result", async () => {
  const { rows, prisma } = fakePrisma();
  const trace = new EngineTrace({ prisma: prisma as never, runId: "run-3" }, "codex");
  const ended = trace.toolEnd("c1", "fast output", true);
  await trace.toolStart("c1", "commandExecution", { command: "ls" }, "Run ls");
  await ended;
  assert.equal(rows.get(0)?.status, "done", "the early result completes the call");
  assert.equal(rows.get(0)?.output, "fast output");
  await trace.toolStart("c2", "commandExecution", { command: "sleep 100" }, "Run sleep 100");
  await trace.stop("skipped", "Stopped.");
  assert.equal(rows.get(1)?.status, "skipped");
  assert.equal(rows.get(1)?.error, "Stopped.");
  await trace.finish("too late");
  assert.equal(rows.size, 2, "no result step after a stop");
});

test("a call that reads a secrets file keeps no output", async () => {
  const { rows, prisma } = fakePrisma();
  const trace = new EngineTrace({ prisma: prisma as never, runId: "run-4" }, "claude-code");
  await trace.toolStart("t1", "Read", { file_path: "/work/app/.env" }, "Read .env");
  await trace.toolEnd("t1", "DATABASE_URL=postgres://u:p@h/db", true);
  await trace.toolStart("t2", "Bash", { command: "cat config/.env.local" }, "cat");
  await trace.toolEnd("t2", "X=1", true);
  await trace.toolStart("t3", "Read", { file_path: "/work/app/src/environment.ts" }, "Read environment.ts");
  await trace.toolEnd("t3", "export const env = 1;", true);
  assert.equal(rows.get(0)?.output, SECRET_OUTPUT);
  assert.equal(rows.get(1)?.output, SECRET_OUTPUT);
  assert.equal(rows.get(2)?.output, "export const env = 1;");
});

