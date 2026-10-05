/**
 * One invoke for every surface. Streams through the same turn as the dock.
 * The answer stays on the anchor; nothing here navigates to a chat page.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ActAs, MODULE_DENIED, hasModule, personaBlock, type AssistantToolCall } from "@ensemble/shared-types";
import { runAssistantTurn } from "../assistant/agent.js";
import { loadSettings } from "../lib/settings.js";
import { citeAnswer } from "../ensemble/citations.js";
import { SURFACE_IDS, loadSurfaceContext } from "../ensemble/surfaces.js";
import { parseWatcher } from "../ensemble/watchers.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { truncateText } from "../lib/text.js";

const InvokeBody = z.object({
  surface: z.enum(SURFACE_IDS),
  prompt: z.string().min(1).max(4000),
  entityIds: z.array(z.string().min(1).max(80)).max(40).optional(),
  selection: z.string().max(8000).optional(),
  codeText: z.string().max(12000).optional(),
  path: z.string().max(500).optional(),
  line: z.number().int().min(1).max(100000).optional(),
  projectId: z.string().max(80).optional(),
  anchorKey: z.string().max(200).optional(),
  actAs: ActAs.optional(),
});

export async function ensembleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ensemble/replies", async (request) => {
    const query = z
      .object({ surface: z.string().min(1).max(40), anchorKey: z.string().min(1).max(200) })
      .parse(request.query);
    const replies = await app.prisma.ensembleReply.findMany({
      where: { userId: request.userId, surface: query.surface, anchorKey: query.anchorKey },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    return { replies };
  });

  app.post("/api/ensemble/replies/:id/applied", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ callId: z.string().min(1), undoEntryId: z.string().min(1).optional() }).parse(request.body);
    const row = await app.prisma.ensembleReply.findFirst({ where: { id, userId: request.userId } });
    if (!row) return reply.code(404).send({ error: "Reply not found." });
    const calls = Array.isArray(row.toolCalls) ? (row.toolCalls as Array<Record<string, unknown>>) : [];
    const next = calls.map((call) => (call.id === body.callId ? { ...call, state: "ok", ...(body.undoEntryId ? { undoEntryId: body.undoEntryId } : {}) } : call));
    await app.prisma.ensembleReply.update({ where: { id }, data: { toolCalls: next as never } });
    return { ok: true };
  });

  app.get("/api/watchers", async (request) => {
    const watchers = await app.prisma.watcher.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { watchers };
  });

  app.post("/api/watchers/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.watcher.findFirst({ where: { id, userId: request.userId } });
    if (!existing) return reply.code(404).send({ error: "Watcher not found." });
    const watcher = await app.prisma.watcher.update({
      where: { id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    return { watcher };
  });

  app.post("/api/ensemble/invoke", async (request, reply) => {
    const body = InvokeBody.parse(request.body);
    if (body.surface === "code" && !hasModule(request.modules, "code")) {
      return reply.code(404).send({ error: MODULE_DENIED });
    }
    const since = new Date(Date.now() - 60_000);
    const [recentReplies, recentComments] = await Promise.all([
      app.prisma.ensembleReply.count({ where: { userId: request.userId, createdAt: { gte: since } } }),
      app.prisma.pageDiscussion.count({ where: { userId: request.userId, authorKind: "ensemble", createdAt: { gte: since } } }),
    ]);
    if (recentReplies + recentComments >= 20) {
      return reply.code(429).send({ error: "Too many Ensemble replies in a minute. Wait and try again." });
    }

    const settings = await loadSettings(app.prisma, request.userId);
    const actAs = body.actAs ?? settings.assistant.actAs;
    const tierName = settings.assistant.defaultTier;
    const tier = settings.models[tierName];
    const context = await loadSurfaceContext(app.prisma, request.userId, body);
    const conversation = await app.prisma.assistantConversation.create({
      data: { userId: request.userId, title: truncateText(body.prompt, 60) || "Ensemble" },
    });
    const row = await app.prisma.ensembleReply.create({
      data: {
        userId: request.userId,
        surface: body.surface,
        anchorKey: context.anchorKey,
        prompt: body.prompt,
        actAs,
        model: tier.model,
        tier: tierName,
        status: "streaming",
      },
    });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // hijack() skips @fastify/cors; the desktop webview calls this cross-origin.
      ...streamCorsHeaders(request.headers.origin, hubCorsPolicy()),
    });
    const send = (event: string, data: unknown) => {
      if (!raw.writableEnded) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("status", { text: "Thinking…", conversationId: conversation.id, replyId: row.id });
    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());
    let text = "";
    try {
      const result = await runAssistantTurn({
        app,
        userId: request.userId,
        modules: request.modules,
        conversationId: conversation.id,
        message: body.prompt,
        page: { path: `/${body.surface}`, label: body.surface },
        settings,
        model: tier.model,
        provider: tier.provider,
        reasoningEffort: tier.effort !== "default" ? tier.effort : undefined,
        preamble: personaBlock(actAs),
        referenceContext: context.facts,
        signal: abort.signal,
        emit(frame) {
          if (frame.type === "delta") text += frame.text;
          send(frame.type, frame);
        },
      });
      text = result.content || text;
      const calls: AssistantToolCall[] = [...result.toolCalls];
      if (!result.interrupted && !calls.some((call) => call.name === "hub_create_watcher")) {
        const draft = parseWatcher(body.prompt, context.scopes);
        if (draft) {
          const call: AssistantToolCall = {
            id: randomUUID(),
            name: "hub_create_watcher",
            area: "reminders",
            input: {
              scopeKind: draft.scopeKind,
              scopeId: draft.scopeId,
              condition: draft.condition,
              ...(draft.daysBefore === null ? {} : { daysBefore: draft.daysBefore }),
              message: draft.message,
              surface: body.surface,
              prompt: truncateText(body.prompt, 500),
            },
            summary: `Watch: ${draft.message}`,
            state: "awaiting_approval",
            isWrite: true,
          };
          calls.push(call);
          send("pending", { type: "pending", call, preview: call.summary });
          if (!text.includes("Nothing has changed yet")) {
            text = `${text}\n\nNothing has changed yet — press Apply.`.trim();
          }
        }
      }
      const cited = citeAnswer(text, context.entities);
      text = cited.text;
      await app.prisma.ensembleReply.update({
        where: { id: row.id },
        data: {
          content: text,
          status: "open",
          toolCalls: calls as never,
          citations: cited.citations as never,
          model: result.model,
        },
      });
      send("done", {
        id: row.id,
        content: text,
        toolCalls: calls,
        citations: cited.citations,
        model: result.model,
        tier: tierName,
        actAs,
        conversationId: conversation.id,
        anchorKey: context.anchorKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ensemble could not answer.";
      await app.prisma.ensembleReply.update({
        where: { id: row.id },
        data: { content: message, status: "open" },
      });
      send("error", { message });
      send("done", { id: row.id, content: "", toolCalls: [], citations: [], model: tier.model, tier: tierName, conversationId: conversation.id });
    }
    raw.end();
  });
}
