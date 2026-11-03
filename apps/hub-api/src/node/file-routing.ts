import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveSession } from "../workspace/sessions.js";
import { currentDevice } from "../devices/successor.js";
import { FileQuote, OriginalSource, fileQuoteContext, resolveOriginal, validateFileQuotes } from "./file-workspace.js";
import { sessionOwners } from "./session-queue.js";
import { ownerContext, sendToSession } from "./sessions.js";
import { postMessage, updateMessageData, wireMessage } from "./store.js";
import { ToolBlockedError } from "../assistant/types.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";

const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code, expose: true });
export const FileTarget = z.object({
  kind: z.enum(["node", "session"]), roomId: z.string().uuid(), nodeId: z.string().uuid(),
  nodeName: z.string(), sessionId: z.string().uuid().optional(), agentName: z.string().optional(),
});
type Candidate = { kind: "node" | "job"; id: string; path: string; fileId: string | null };

export async function fileTarget(prisma: PrismaClient, accountId: string, input: OriginalSource) {
  const original = await resolveOriginal(prisma, accountId, input);
  let source = input;
  const job = source.kind === "job" ? await prisma.workspaceJob.findUnique({ where: { id: source.id }, select: { evidence: true } }) : null;
  const files = (job?.evidence as { files?: Array<{ path: string; fileId?: string }> } | null)?.files;
  const fileId = source.kind === "node" ? source.fileId : files?.find(file => file.path === source.path)?.fileId;
  if (fileId && original.deviceId) {
    const devices = await prisma.device.findMany({ where: { userId: accountId } });
    const named = devices.find(device => device.id === original.deviceId);
    const computer = named ? await currentDevice(prisma, named) : null;
    const ids: string[] = [];
    for (const device of devices) if ((await currentDevice(prisma, device))?.id === computer?.id && computer) ids.push(device.id);
    if (ids.length) {
      const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
        SELECT kind,id,path,"fileId" FROM (
          SELECT 'node'::text kind,m.id,f.value->>'path' path,f.value->>'fileId' "fileId",
            COALESCE((f.value->>'updatedAt')::timestamp,m.created_at) at
          FROM node_messages m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.data->'sources')='array' THEN m.data->'sources' ELSE '[]'::jsonb END) f(value)
          WHERE m.user_id=${accountId} AND m.kind='files' AND m.data->>'deviceId' IN (${Prisma.join(ids)}) AND f.value->>'fileId'=${fileId}
          UNION ALL
          SELECT 'job',j.id,f.value->>'path',f.value->>'fileId',
            COALESCE((f.value->>'modifiedAt')::timestamp,j.finished_at,j.last_progress_at,j.started_at,j.created_at)
          FROM workspace_jobs j CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.evidence->'files')='array' THEN j.evidence->'files' ELSE '[]'::jsonb END) f(value)
          WHERE COALESCE(j.runner_account_id,j.user_id)=${accountId} AND j.device_id IN (${Prisma.join(ids)}) AND f.value->>'fileId'=${fileId}
        ) edits ORDER BY at DESC,id DESC LIMIT 1
      `);
      const latest = candidates[0];
      if (latest) source = latest.kind === "node" ? { kind: "node", id: latest.id, fileId: latest.fileId!, path: latest.path } : { kind: "job", id: latest.id, path: latest.path };
    }
  }
  let nodeId: string | null = null, sessionId: string | undefined, agentName: string | undefined;
  if (source.kind === "node") {
    const card = await prisma.nodeMessage.findFirst({ where: { id: source.id, userId: accountId, kind: "files" }, select: { authorNodeId: true } });
    nodeId = card?.authorNodeId ?? null;
  } else {
    const session = await resolveSession(prisma, { space: accountId, runner: null }, source.id);
    if (!session) throw fail(409, "This file's editing session is no longer available.");
    sessionId = session.id; agentName = session.agentName;
    nodeId = (await sessionOwners(prisma, accountId, [session.id])).get(session.id) ?? null;
  }
  const node = nodeId ? await prisma.nodeAgent.findFirst({ where: { id: nodeId, userId: accountId } }) : null;
  if (!node) throw fail(409, "This file has no available editing node. Give its session to one of your nodes from Sessions first.");
  const room = await prisma.nodeRoom.findFirst({ where: { userId: accountId, kind: "dm", archivedAt: null, members: { some: { nodeId: node.id } } } });
  if (!room) throw fail(409, "The editing node's chat is no longer available.");
  return { kind: sessionId ? "session" as const : "node" as const, roomId: room.id, nodeId: node.id, nodeName: node.name, ...(sessionId ? { sessionId, agentName } : {}) };
}

export function registerFileRouting(app: FastifyInstance, accountOf: (request: FastifyRequest) => string) {
  app.post("/api/node/files/target", async request => {
    const accountId = accountOf(request);
    const body = z.object({ source: OriginalSource }).strict().parse(request.body);
    return { target: await fileTarget(app.prisma, accountId, body.source) };
  });
  app.post("/api/node/files/query", async (request, reply) => {
    const accountId = accountOf(request);
    await requireVerifiedUser(accountId);
    const body = z.object({ body: z.string().max(8000), clientId: z.string().min(1).max(80), fileQuotes: z.array(FileQuote).min(1).max(4), target: FileTarget }).strict().parse(request.body);
    if (!body.body.trim()) throw fail(400, "Add your question about the selected lines.");
    const previous = await app.prisma.nodeMessage.findFirst({ where: { userId: accountId, roomId: body.target.roomId, clientId: body.clientId, authorKind: "human" } });
    if (previous) {
      const data = previous.data as { fileTarget?: z.infer<typeof FileTarget>; fileJobId?: string };
      const job = await app.prisma.workspaceJob.findUnique({ where: { operationId: `file-query:${previous.id}` }, select: { id: true } });
      const turn = await app.prisma.nodeTurn.findUnique({ where: { operationId: `file-query:${previous.id}` }, select: { id: true } });
      if (data.fileTarget && (data.fileJobId || job || turn)) return { message: wireMessage(previous), target: data.fileTarget };
    }
    const quotes = await validateFileQuotes(app.prisma, accountId, body.fileQuotes);
    const prompt = `${body.body.trim()}\n${fileQuoteContext({ fileQuotes: quotes })}`;
    if (prompt.length > 38_000) throw fail(400, "These file references and selected lines exceed the session's message buffer. Send a smaller selection.");
    const targets = await Promise.all(quotes.map(quote => fileTarget(app.prisma, accountId, quote.source)));
    const target = targets[0]!;
    if (targets.some(item => item.roomId !== target.roomId || item.sessionId !== target.sessionId) || body.target.nodeId !== target.nodeId || body.target.sessionId !== target.sessionId || body.target.roomId !== target.roomId) throw fail(409, "The file's editing destination changed. Select the lines again to review the new destination.", "FILE_TARGET_CHANGED");
    const lock = `ensemble:file-query:${accountId}:${body.clientId}`, token = randomUUID();
    if (await app.redis.set(lock, token, "EX", 60, "NX") !== "OK") throw fail(409, "This file question is being queued. Wait a moment, then retry.");
    try {
      const { message, duplicate } = await postMessage(app.prisma, {
        roomId: target.roomId, userId: accountId, authorKind: "human", body: body.body.trim(), clientId: body.clientId,
        visibleTo: [accountId], data: { fileQuotes: quotes, fileTarget: target },
      });
      if (target.kind === "node") {
        const { dispatchMessage } = await import("./queue.js");
        await dispatchMessage(app, message, `file-query:${message.id}`);
      } else if (!(message.data as { fileJobId?: string }).fileJobId) {
        const node = await app.prisma.nodeAgent.findUniqueOrThrow({ where: { id: target.nodeId } });
        const room = await app.prisma.nodeRoom.findUniqueOrThrow({ where: { id: target.roomId } });
        const done = await sendToSession({
          ctx: await ownerContext(app, accountId), app, prisma: app.prisma, node, room,
          privateTo: [accountId], via: "card", operationId: `file-query:${message.id}`,
          lineage: { rootMessageId: message.id, botDepth: 0, fromNonOwner: false },
        }, { session: target.sessionId!, delivery: "queue", prompt, title: `File question: ${quotes[0]!.source.path.split("/").at(-1)}` });
        await updateMessageData(app.prisma, message, { fileJobId: (done.data as { jobId: string }).jobId });
      }
      const saved = await app.prisma.nodeMessage.findUniqueOrThrow({ where: { id: message.id } });
      return reply.code(duplicate ? 200 : 201).send({ message: wireMessage(saved), target });
    } catch (error) {
      if (error instanceof ToolBlockedError) throw fail(409, [error.message, error.remedy].filter(Boolean).join(" "));
      throw error;
    } finally { if (await app.redis.get(lock) === token) await app.redis.del(lock); }
  });
}
