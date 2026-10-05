/**
 * Text comments and inline @ensemble replies.
 * Humans cannot reply to a comment. The only nested row is Ensemble.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ActAs, PageMention, personaBlock } from "@ensemble/shared-types";
import { runAssistantTurn } from "../assistant/agent.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { truncateText } from "../lib/text.js";

const Body = z.object({
  type: z.literal("doc").optional(),
  content: z.array(z.unknown()).optional(),
  text: z.string().optional(),
});

async function pageText(prisma: FastifyInstance["prisma"], userId: string, kind: string, id: string): Promise<string> {
  if (kind === "task") {
    const [task, page] = await Promise.all([
      prisma.task.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true, description: true, notes: true } }),
      prisma.taskPage.findFirst({ where: { taskId: id, userId }, select: { content: true } }),
    ]);
    return [task?.title, task?.description, task?.notes, textOf((page?.content ?? {}) as { text?: string; content?: unknown[] })]
      .filter((part) => part && part.trim())
      .join("\n")
      .slice(0, 6000);
  }
  if (kind === "project") {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { name: true, summary: true, content: true },
    });
    return [project?.name, project?.summary, textOf((project?.content ?? {}) as { text?: string; content?: unknown[] })]
      .filter((part) => part && part.trim())
      .join("\n")
      .slice(0, 6000);
  }
  return "";
}

function textOf(body: { text?: string; content?: unknown[] }): string {
  if (body.text) return body.text;
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: string; content?: unknown[] };
    if (record.text) parts.push(record.text);
    for (const child of record.content ?? []) walk(child);
  };
  for (const node of body.content ?? []) walk(node);
  return parts.join(" ").trim();
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pages/:kind/:id/comments", async (request) => {
    const { kind, id } = request.params as { kind: string; id: string };
    const rows = await app.prisma.pageDiscussion.findMany({
      where: { userId: request.userId, pageKind: kind, pageId: id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return { comments: rows };
  });

  app.post("/api/pages/:kind/:id/comments", async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    const body = z
      .object({
        markId: z.string().min(1).optional(),
        quote: z.string().default(""),
        body: Body,
        mentions: z.array(PageMention).optional(),
        anchor: z.record(z.unknown()).optional(),
      })
      .parse(request.body);
    const row = await app.prisma.pageDiscussion.create({
      data: {
        userId: request.userId,
        pageKind: kind,
        pageId: id,
        sourceKind: kind,
        sourceId: id,
        taskId: kind === "task" ? id : null,
        projectId: kind === "project" ? id : null,
        kind: "comment",
        authorKind: "human",
        markId: body.markId,
        quote: body.quote,
        anchor: { markId: body.markId, quote: body.quote, ...(body.anchor ?? {}) },
        body: body.body as never,
        mentions: (body.mentions ?? []) as never,
      },
    });
    return reply.code(201).send({ comment: row });
  });

  app.patch("/api/comments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        body: Body.optional(),
        status: z.enum(["open", "resolved"]).optional(),
      })
      .parse(request.body);
    const existing = await app.prisma.pageDiscussion.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Comment not found." });
    if (existing.authorKind !== "human" && body.body) return reply.code(403).send({ error: "You can only edit your own comments." });
    const row = await app.prisma.pageDiscussion.update({
      where: { id },
      data: {
        body: body.body as never,
        status: body.status,
        resolved: body.status === "resolved" ? true : body.status === "open" ? false : undefined,
      },
    });
    return { comment: row };
  });

  app.delete("/api/comments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.pageDiscussion.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Comment not found." });
    if (existing.authorKind !== "human") return reply.code(403).send({ error: "You can only delete your own comments." });
    await app.prisma.pageDiscussion.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });

  app.post("/api/comments/:id/reply", async (request, reply) => {
    return reply.code(400).send({ error: "People can't reply to a comment. Ask @ensemble if you want a reply." });
  });

  app.post("/api/pages/:kind/:id/ensemble", async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    const body = z
      .object({
        prompt: z.string().min(1),
        parentId: z.string().uuid().optional(),
        markId: z.string().optional(),
        quote: z.string().optional(),
        tier: z.enum(["easy", "medium", "high", "max"]).optional(),
        actAs: ActAs.optional(),
      })
      .parse(request.body);
    if (body.parentId) {
      const parent = await app.prisma.pageDiscussion.findFirst({ where: { id: body.parentId, userId: request.userId } });
      if (!parent) return reply.code(404).send({ error: "Comment not found." });
      if (parent.authorKind === "human" && parent.kind === "comment") {
        // allowed: ensemble replies to a human comment
      }
    }
    const since = new Date(Date.now() - 60_000);
    const recent = await app.prisma.pageDiscussion.count({
      where: { userId: request.userId, authorKind: "ensemble", createdAt: { gte: since } },
    });
    if (recent >= 20) return reply.code(429).send({ error: "Too many Ensemble replies in a minute. Wait and try again." });

    const settings = await loadSettings(app.prisma, request.userId);
    const tierName = body.tier ?? settings.assistant.defaultTier;
    const tier = settings.models[tierName];
    const conversation = await app.prisma.assistantConversation.create({
      data: { userId: request.userId, title: truncateText(body.prompt, 60) || "Comment" },
    });
    const row = await app.prisma.pageDiscussion.create({
      data: {
        userId: request.userId,
        pageKind: kind,
        pageId: id,
        sourceKind: kind,
        sourceId: id,
        taskId: kind === "task" ? id : null,
        projectId: kind === "project" ? id : null,
        kind: "ensemble",
        authorKind: "ensemble",
        parentId: body.parentId,
        markId: body.markId,
        quote: body.quote ?? "",
        anchor: { markId: body.markId, quote: body.quote ?? "" },
        body: { text: "" },
        status: "streaming",
        model: tier.model,
        tier: tierName,
        conversationId: conversation.id,
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
    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());
    let text = "";
    let lastFlush = 0;
    try {
      const result = await runAssistantTurn({
        app,
        userId: request.userId,
        modules: request.modules,
        conversationId: conversation.id,
        message: body.prompt,
        page: { path: `/${kind}s/${id}`, taskId: kind === "task" ? id : undefined, projectId: kind === "project" ? id : undefined, label: "this page" },
        settings,
        model: tier.model,
        provider: tier.provider,
        reasoningEffort: tier.effort !== "default" ? tier.effort : undefined,
        preamble: personaBlock(body.actAs ?? settings.assistant.actAs),
        referenceContext: [
          await pageText(app.prisma, request.userId, kind, id),
          body.quote ? `Selected text:\n${body.quote}` : "",
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 8000) || undefined,
        signal: abort.signal,
        emit(frame) {
          if (frame.type === "delta") {
            text += frame.text;
            const now = Date.now();
            if (now - lastFlush > 150) {
              lastFlush = now;
              void app.prisma.pageDiscussion.update({ where: { id: row.id }, data: { body: { text } } }).catch(() => undefined);
            }
          }
          send(frame.type, frame);
        },
      });
      text = result.content || text;
      await app.prisma.pageDiscussion.update({
        where: { id: row.id },
        data: { body: { text }, status: "open", toolCalls: result.toolCalls as never, model: result.model },
      });
      send("done", { id: row.id, content: text, toolCalls: result.toolCalls, model: result.model, tier: tierName, conversationId: conversation.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ensemble could not answer.";
      await app.prisma.pageDiscussion.update({
        where: { id: row.id },
        data: { body: { text: message }, status: "open", error: message },
      });
      send("error", { message });
      send("done", { id: row.id, content: message, toolCalls: [], model: tier.model, tier: tierName });
    }
    sseHub.publish(request.userId, { event: "page", data: { pageId: id } });
    raw.end();
  });
}
