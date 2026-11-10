/**
 * Opt-in, real-agent check of an Ensemble Node on its owner's own AI plan (docs/35, a node's brain on the
 * owner's plan). Runs in this process as the desktop app does: a test database, this computer's agent
 * (GitHub Copilot by default, on its default model), a temporary workspace and state folder. Four turns in
 * the node's DM, checked against live ground truth and the workspace, then: how many agent sessions the
 * node's conversation used, and where. Every agent session it made is deleted at the end.
 *
 *   pnpm --filter @ensemble/hub-api exec tsx scripts/node-subscription-eval.ts [--agent copilot-cli] [--model default]
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback);
const agent = arg("--agent", "copilot-cli");
const model = arg("--model", "default");
const scratch = mkdtempSync(join(tmpdir(), "ensemble-node-sub-eval-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "state");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "workspace");

const { createHttpHarness } = await import("../src/test/http.js");
const harness = await createHttpHarness();
process.env.ENSEMBLE_DESKTOP = "1";
const { setLocalPort } = await import("../src/workspace/engines/registry.js");
const { settleTurns } = await import("../src/node/queue.js");
const { deleteNativeSession } = await import("../src/workspace/engines/delete-session.js");
await harness.app.listen({ port: 0, host: "127.0.0.1" });
setLocalPort((harness.app.server.address() as { port: number }).port);

type Row = { id: string; kind: string; body: string; authorKind: string; data: any };
const store = () => (existsSync(join(scratch, "state", "assistant-sessions.json")) ? (JSON.parse(readFileSync(join(scratch, "state", "assistant-sessions.json"), "utf8")) as Record<string, { id: string; folder?: string; from?: number }>) : {});
const sessionsSeen = new Set<string>();
const results: Array<{ turn: string; passed: boolean; problems: string[]; seconds: number; tools: string[]; session: string | null; tokensIn: number | null; tokensOut: number | null }> = [];

try {
  const owner = await harness.asUser();
  await harness.prisma.user.update({ where: { id: owner.id }, data: { name: "Akash", emailVerifiedAt: new Date() } });
  const made = await owner.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(made.statusCode, 201, made.body);
  const { node, room } = made.json() as { node: { id: string; slug: string }; room: { id: string } };
  await harness.prisma.nodeAgent.update({ where: { id: node.id }, data: { provider: agent, model } });
  const endoflife = async (product: string) => (await (await fetch(`https://endoflife.date/api/${product}.json`, { signal: AbortSignal.timeout(20_000) })).json()) as Array<Record<string, string | boolean>>;
  const lts = (await endoflife("nodejs")).find((row) => row.lts && String(row.lts) <= new Date().toISOString().slice(0, 10))!;
  const py314 = (await endoflife("python")).find((row) => row.cycle === "3.14")!;

  const turn = async (name: string, message: string, check: (reply: string) => Promise<string[]> | string[]) => {
    const started = Date.now();
    const before = await harness.prisma.nodeTurn.count({ where: { nodeId: node.id } });
    const sent = await owner.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: message } });
    assert.equal(sent.statusCode, 201, sent.body);
    await settleTurns();
    const rows = ((await owner.inject({ method: "GET", url: `/api/node/rooms/${room.id}/messages` })).json() as { messages: Row[] }).messages;
    const reply = rows.filter((row) => row.authorKind === "node").at(-1);
    const turns = await harness.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" }, skip: before });
    const assistant = await harness.prisma.assistantMessage.findFirst({ where: { userId: owner.id, role: "assistant" }, orderBy: { createdAt: "desc" }, select: { toolCalls: true } });
    const tools = (Array.isArray(assistant?.toolCalls) ? assistant!.toolCalls : []).map((call) => String((call as { name?: unknown }).name ?? ""));
    const metric = await harness.prisma.metricEvent.findFirst({ where: { userId: owner.id, kind: "model.call" }, orderBy: { ts: "desc" }, select: { payload: true } });
    const meta = (metric?.payload ?? {}) as { tokensIn?: number | null; tokensOut?: number | null };
    const text = reply?.body ?? "";
    const problems = [...(turns.some((row) => row.status === "failed") ? [`turn failed: ${turns.map((row) => row.error).filter(Boolean).join("; ").slice(0, 300)}`] : []), ...(await check(text))];
    for (const entry of Object.values(store())) sessionsSeen.add(entry.id);
    const session = Object.values(store())[0]?.id ?? null;
    results.push({ turn: name, passed: problems.length === 0, problems, seconds: Math.round((Date.now() - started) / 1000), tools, session, tokensIn: meta.tokensIn ?? null, tokensOut: meta.tokensOut ?? null });
    console.log(JSON.stringify({ turn: name, passed: problems.length === 0, problems, tools, session, reply: text.slice(0, 500) }));
  };

  await turn("fact with a source", "What is the latest LTS version of Node.js, and when does its support end? Cite the source.", (reply) => [
    ...(new RegExp(`(?<!\\d)${lts.cycle}(?!\\d)`).test(reply) ? [] : [`names Node ${lts.cycle}`]),
    ...(reply.includes(String(lts.eol).slice(0, 4)) ? [] : [`end of support ${String(lts.eol).slice(0, 4)}`]),
    ...(/https?:\/\//.test(reply) ? [] : ["a link"]),
  ]);
  await turn("todo and memory", "Add a todo called Draft the Q4 plan, and remember that I prefer short answers.", async () => {
    const task = await harness.prisma.task.findFirst({ where: { userId: owner.id, title: { contains: "Q4 plan" } } });
    const memory = await harness.prisma.nodeMemory.findFirst({ where: { nodeId: node.id } });
    return [...(task ? [] : ["the todo"]), ...(memory && /short/i.test(memory.content) ? [] : ["the memory"])];
  });
  await turn("recall after the instructions changed", "What did I ask you to remember a moment ago, and which todo did you add?", (reply) => [...(/short/i.test(reply) ? [] : ["recalls short answers"]), ...(/Q4 plan/i.test(reply) ? [] : ["recalls the todo"])]);
  await turn("look up, then write", "Find the official release date of Python 3.14 on the web and put it in the notes of the todo Draft the Q4 plan. Don't ask me anything.", async () => {
    const task = await harness.prisma.task.findFirst({ where: { userId: owner.id, title: { contains: "Q4 plan" } }, select: { id: true, notes: true, description: true } });
    const page = task ? await harness.prisma.taskPage.findUnique({ where: { taskId: task.id } }) : null;
    const text = `${task?.notes ?? ""} ${task?.description ?? ""} ${JSON.stringify(page ?? {})}`;
    return text.includes(String(py314.releaseDate)) || /october\s+7,?\s+2025|7 october 2025|oct\.? 7,? 2025/i.test(text) ? [] : [`notes carry ${py314.releaseDate}`];
  });

  const entries = store();
  const folders = existsSync(join(scratch, "workspace", "projects")) ? readdirSync(join(scratch, "workspace", "projects")).filter((name) => !name.startsWith(".")) : [];
  console.log(
    JSON.stringify({
      agent,
      model,
      passed: results.filter((row) => row.passed).length,
      of: results.length,
      sessionsUsed: sessionsSeen.size,
      sessionNow: Object.values(entries).map((entry) => ({ id: entry.id, folder: entry.folder ?? null, from: entry.from ?? null })),
      projectFolders: folders,
      perTurn: results.map((row) => ({ turn: row.turn, passed: row.passed, seconds: row.seconds, tools: row.tools, tokensIn: row.tokensIn, tokensOut: row.tokensOut })),
    }),
  );
} finally {
  // Every agent session this check made goes from the agent too (its app lists none of them afterwards).
  for (const id of sessionsSeen) {
    await deleteNativeSession(agent as never, id, join(scratch, "workspace")).catch((error: unknown) => console.error(`could not delete session ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }
  // Belt and braces: any Copilot session left with its folder in this check's scratch space.
  const copilotState = join(process.env.HOME ?? "", ".copilot", "session-state");
  if (agent === "copilot-cli" && existsSync(copilotState)) {
    for (const id of readdirSync(copilotState)) {
      const yaml = join(copilotState, id, "workspace.yaml");
      if (!sessionsSeen.has(id) && existsSync(yaml) && readFileSync(yaml, "utf8").includes(scratch)) {
        sessionsSeen.add(id);
        await deleteNativeSession(agent as never, id, join(scratch, "workspace")).catch(() => undefined);
      }
    }
  }
  console.log(JSON.stringify({ deletedSessions: [...sessionsSeen] }));
  await harness.app.close().catch(() => undefined);
  await harness.close().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
}
