/**
 * What a task run left, read once its work is quiet (or its time ran out): the conversation, the
 * nodes' tool calls and turns, the owner's tasks, pages, memories, reminders, plans and runs, the
 * agent's own session logs, and the cards the harness saw. Text is kept short (lib/redact.ts).
 */
import { copilotUsage, type SessionLedger } from "./sessions.js";
import { cut } from "./redact.js";
import type { CardLog, Evidence, Message, ToolCall, Usage } from "./types.js";
import type { World } from "./world.js";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const json = (value: unknown, max: number): string => cut(typeof value === "string" ? value : JSON.stringify(value ?? null), max);

/** The plain text of a page's document (TipTap JSON), one block per line. */
export function docText(node: unknown): string {
  const item = record(node);
  if (typeof item.text === "string") return item.text;
  // A mention of a task, page, person or date shows its label.
  if (item.type === "mention") return text(record(item.attrs).label) ?? "";
  const children = Array.isArray(item.content) ? item.content.map(docText) : [];
  const block = ["paragraph", "heading", "listItem", "taskItem", "codeBlock", "blockquote", "tableRow"].includes(String(item.type));
  return children.join(block || item.type === "doc" ? "\n" : "").replace(/\n{3,}/g, "\n\n");
}

export type Scope = { ownerId: string; roomIds: string[]; since: Date; seededTasks: string[]; seededPages: string[] };

export async function collectEvidence(world: World, scope: Scope, ledger: SessionLedger, task: string, cards: CardLog[]): Promise<Evidence> {
  const prisma = world.prisma;
  const owner = scope.ownerId;
  const nodes = await prisma.nodeAgent.findMany({ where: { userId: owner }, select: { id: true, slug: true } });
  const slug = new Map(nodes.map((row) => [row.id, row.slug]));
  const members = await prisma.nodeRoomMember.findMany({ where: { nodeId: { in: nodes.map((row) => row.id) } }, select: { nodeId: true, conversationId: true, privateConversationId: true } });
  const steps = await prisma.nodeStep.findMany({ where: { mission: { userId: owner } }, select: { nodeId: true, conversationId: true } });
  const byConversation = new Map<string, string>();
  for (const row of members) for (const id of [row.conversationId, row.privateConversationId]) if (id && row.nodeId) byConversation.set(id, slug.get(row.nodeId) ?? row.nodeId);
  for (const row of steps) if (row.conversationId) byConversation.set(row.conversationId, slug.get(row.nodeId) ?? row.nodeId);

  const rows = await prisma.nodeMessage.findMany({ where: { roomId: { in: scope.roomIds } }, orderBy: [{ createdAt: "asc" }, { seq: "asc" }] });
  const messages: Message[] = rows.map((row) => {
    const data = record(row.data);
    const media = (Array.isArray(data.media) ? data.media : []).map((item) => record(item)).map((item) => ({
      evidenceId: text(item.evidenceId),
      kind: text(item.kind),
      name: text(item.name),
      mime: text(item.mime),
      size: typeof item.size === "number" ? item.size : null,
    }));
    const tools = (Array.isArray(data.tools) ? data.tools : []).map((item) => record(item)).map((item) => ({ name: String(item.name ?? ""), state: String(item.state ?? "") }));
    return {
      id: row.id,
      room: row.roomId,
      seq: row.seq,
      author: row.authorKind === "node" ? `node:${slug.get(row.authorNodeId ?? "") ?? row.authorNodeId ?? "?"}` : row.authorKind === "human" ? (row.userId === owner ? "owner" : "person") : row.authorKind,
      kind: row.kind,
      type: text(data.type),
      status: text(data.status),
      body: cut(row.body, 6000),
      media,
      tools,
      at: row.createdAt.toISOString(),
    };
  });
  const replies = messages.filter((row) => row.author.startsWith("node") && row.kind === "text" && !row.type && row.body.trim()).map((row) => row.body);
  const asked = messages.filter((row) => row.author === "owner" && row.kind === "text");
  const answers = asked.map((row, index) => {
    const next = asked[index + 1]?.at ?? "9999";
    return messages.filter((reply) => reply.author.startsWith("node") && reply.kind === "text" && !reply.type && reply.at >= row.at && reply.at < next).map((reply) => reply.body).join("\n\n");
  });

  const assistant = await prisma.assistantMessage.findMany({ where: { userId: owner, role: "assistant" }, orderBy: { createdAt: "asc" }, select: { conversationId: true, toolCalls: true } });
  const tools: ToolCall[] = assistant.flatMap((row) =>
    (Array.isArray(row.toolCalls) ? row.toolCalls : []).map((call) => {
      const item = record(call);
      const failed = item.state === "failed" || typeof item.error === "string";
      return {
        name: String(item.name ?? ""),
        ok: !failed,
        input: json(item.input ?? item.arguments ?? {}, 400),
        output: cut(String(item.error ?? item.summary ?? ""), 400),
        node: byConversation.get(row.conversationId) ?? null,
      };
    }),
  );

  const turns = (await prisma.nodeTurn.findMany({ where: { userId: owner }, orderBy: { createdAt: "asc" } })).map((row) => ({
    node: slug.get(row.nodeId) ?? row.nodeId,
    reason: row.reason,
    status: row.status,
    error: row.error ? cut(row.error, 600) : null,
    receipts: Array.isArray(row.receipts) ? (row.receipts as unknown[]).slice(0, 60) : [],
    startedAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));

  // A failed or stopped turn leaves no assistant message: its tool calls are only in its receipts.
  for (const turn of turns) {
    if (turn.status === "done") continue;
    for (const receipt of turn.receipts.map((item) => record(item))) {
      tools.push({ name: String(receipt.name ?? ""), ok: receipt.state !== "failed", input: "{}", output: cut(String(receipt.summary ?? receipt.error ?? ""), 400), node: turn.node });
    }
  }

  const tasks = (await prisma.task.findMany({ where: { userId: owner, deletedAt: null }, orderBy: { createdAt: "asc" } })).map((row) => ({
    id: row.id,
    title: row.title,
    notes: cut(row.notes, 3000),
    description: cut(row.description, 3000),
    status: row.status,
    owner: row.owner,
    due: row.due?.toISOString() ?? null,
    startsAt: row.startsAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    seeded: scope.seededTasks.includes(row.id),
  }));

  const pages = (await prisma.taskPage.findMany({ where: { userId: owner, deletedAt: null }, orderBy: { createdAt: "asc" } })).map((row) => ({
    id: row.id,
    title: row.title,
    text: cut((row.content ? docText(row.content) : "") || row.searchText || row.notesSnapshot || "", 6000),
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
    seeded: scope.seededPages.includes(row.id),
  }));

  const memories = (await prisma.nodeMemory.findMany({ where: { userId: owner }, orderBy: { createdAt: "asc" } })).map((row) => ({ node: slug.get(row.nodeId) ?? row.nodeId, content: cut(row.content, 1000) }));

  const reminders = await prisma.reminder.findMany({ where: { userId: owner, deletedAt: null } });
  const nodeRoutines = await prisma.nodeRoutine.findMany({ where: { userId: owner } });
  const assistantRoutines = await prisma.assistantRoutine.findMany({ where: { userId: owner, builtInKey: null } });
  const routines = [
    ...reminders.map((row) => ({ kind: "reminder", id: row.id, title: row.title, when: `${row.dueDate}${row.dueTime ? ` ${row.dueTime}` : ""} ${row.timeZone}`, detail: "" })),
    ...nodeRoutines.map((row) => ({ kind: "node-routine", id: row.id, title: row.title, when: row.nextRunAt?.toISOString() ?? null, detail: cut(`${row.cron ?? ""} ${row.timezone} ${row.instruction ?? ""}`, 400) })),
    ...assistantRoutines.map((row) => ({ kind: "assistant-routine", id: row.id, title: row.title, when: row.nextRunAt?.toISOString() ?? null, detail: cut(`${row.cron} ${row.timezone} ${row.instruction}`, 400) })),
  ];

  const missions = (await prisma.nodeMission.findMany({ where: { userId: owner }, include: { steps: { orderBy: { position: "asc" } } }, orderBy: { createdAt: "asc" } })).map((row) => ({
    id: row.id,
    status: row.status,
    goal: row.goal ? cut(row.goal, 600) : null,
    steps: row.steps.map((step) => ({ id: step.id, node: step.handle, kind: step.kind, status: step.status, outcome: step.outcome, attempt: step.attempt, result: step.result ? cut(step.result, 800) : null })),
  }));
  const runs = (await prisma.nodeRun.findMany({ where: { userId: owner }, orderBy: { createdAt: "asc" } })).map((row) => ({
    id: row.id,
    node: slug.get(row.nodeId) ?? row.nodeId,
    jobId: row.jobId,
    status: row.status,
    sessionId: row.sessionId,
    planStep: row.planStep,
    prompt: cut(row.prompt ?? "", 1200),
  }));
  const jobs = (await prisma.workspaceJob.findMany({ where: { userId: owner }, orderBy: { createdAt: "asc" } })).map((row) => ({ id: row.id, provider: row.provider ?? "", model: row.model, status: row.status, error: row.error ? cut(row.error, 400) : null, kind: row.kind }));

  const sessions = ledger.entries(task).filter((row) => row.kind !== "judge");
  const usage: Usage = { turns: turns.length, modelCalls: 0, tokensIn: 0, tokensOut: 0, credits: 0, ensembleCalls: 0, ensembleTokensIn: 0, ensembleTokensOut: 0, models: [] };
  const models = new Set<string>();
  const agentTools: Evidence["agentTools"] = [];
  for (const session of sessions) {
    const used = session.agent === "copilot-cli" ? copilotUsage(session.id) : null;
    if (!used) continue;
    usage.modelCalls += used.modelCalls;
    usage.tokensIn += used.tokensIn;
    usage.tokensOut += used.tokensOut;
    usage.credits += used.nanoAiu / 1e9;
    for (const model of used.models) models.add(model);
    for (const name of used.tools) agentTools.push({ name, session: session.id });
  }
  const calls = await prisma.metricEvent.findMany({ where: { userId: owner, kind: "model.call", ts: { gte: scope.since } }, select: { payload: true } });
  for (const call of calls) {
    const payload = record(call.payload);
    usage.ensembleCalls += 1;
    if (typeof payload.tokensIn === "number") usage.ensembleTokensIn += payload.tokensIn;
    if (typeof payload.tokensOut === "number") usage.ensembleTokensOut += payload.tokensOut;
    if (typeof payload.model === "string") models.add(payload.model);
  }
  usage.models = [...models];

  return { replies, answers, messages, tools, agentTools, turns, tasks, pages, memories, routines, missions, runs, jobs, cards, sessions: sessions.map((row) => row.id), usage, extra: {} };
}
