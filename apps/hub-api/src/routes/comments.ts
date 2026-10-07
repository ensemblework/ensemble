/**
 * Text comments and inline @ensemble replies.
 * Humans cannot reply to a comment. The only nested row is Ensemble.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { ActAs, PageDocument, PageMention, documentMentions, personaBlock } from "@ensemble/shared-types";
import { pageText as documentText } from "../pages/markdown.js";
import { runAssistantTurn } from "../assistant/agent.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { truncateText } from "../lib/text.js";
import { assertOwned } from "../services/records.js";

const Body = z.object({
  type: z.literal("doc").optional(),
  content: z.array(z.unknown()).optional(),
  text: z.string().optional(),
});

async function assertCommentPage(prisma: Prisma.TransactionClient, userId: string, kind: string, id: string): Promise<void> {
  if (kind === "task" || kind === "project" || kind === "deliverable") {
    await assertOwned(prisma, userId, kind, id);
    return;
  }
  if (kind === "page") {
    const page = await prisma.taskPage.findFirst({ where: { id, userId, taskId: null }, select: { id: true } });
    if (!page) throw Object.assign(new Error("Page not found."), { statusCode: 404 });
    return;
  }
  throw Object.assign(new Error("Unsupported comment page kind."), { statusCode: 400 });
}

async function withCommentPage<T>(
  prisma: FastifyInstance["prisma"],
  userId: string,
  kind: string,
  id: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (kind === "page") {
      await tx.$queryRaw`SELECT id FROM task_pages WHERE id = ${id} AND user_id = ${userId} AND task_id IS NULL FOR UPDATE`;
    } else if (kind === "task") {
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL FOR UPDATE`;
    }
    await assertCommentPage(tx, userId, kind, id);
    return write(tx);
  });
}

export async function commentPageText(prisma: FastifyInstance["prisma"], userId: string, kind: string, id: string, live?: PageDocument): Promise<string> {
  const text = (content: unknown, notes: string) => {
    const doc = live ?? (content ? PageDocument.parse(content) : null);
    const references = doc ? documentMentions(doc).slice(0, 40).map((mention) => `${mention.kind}:${mention.id} (${mention.label.slice(0, 200)})`).join("\n") : "";
    return [references ? `Page references:\n${references}` : "", documentText(doc, notes)].filter(Boolean).join("\n\n");
  };
  if (kind === "page") {
    const page = await prisma.taskPage.findFirst({ where: { id, userId, taskId: null }, select: { title: true, content: true, notesSnapshot: true } });
    return page ? [page.title, text(page.content, page.notesSnapshot)].join("\n\n").slice(0, 24_000) : "";
  }
  if (kind === "task") {
    const [task, page] = await Promise.all([
      prisma.task.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true, description: true, notes: true } }),
      prisma.taskPage.findFirst({ where: { taskId: id, userId }, select: { content: true } }),
    ]);
    return [task?.title, task?.description, text(page?.content, task?.notes ?? "")]
      .filter((part) => part && part.trim())
      .join("\n")
      .slice(0, 24_000);
  }
  if (kind === "project") {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { name: true, summary: true, content: true },
    });
    return [project?.name, project?.summary, live ? documentText(live, "") : textOf((project?.content ?? {}) as { text?: string; content?: unknown[] })]
      .filter((part) => part && part.trim())
      .join("\n")
      .slice(0, 24_000);
  }
  if (kind === "deliverable") {
    const deliverable = await prisma.deliverable.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true, notes: true } });
    return deliverable ? [deliverable.title, live ? documentText(live, "") : deliverable.notes].join("\n\n").slice(0, 24_000) : "";
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
    await assertCommentPage(app.prisma, request.userId, kind, id);
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
    await assertCommentPage(app.prisma, request.userId, kind, id);
    const row = await withCommentPage(app.prisma, request.userId, kind, id, (tx) => tx.pageDiscussion.create({
      data: {
        userId: request.userId,
        pageKind: kind,
        pageId: id,
        sourceKind: kind,
        sourceId: id,
        taskId: kind === "task" ? id : null,
        projectId: kind === "project" ? id : null,
        deliverableId: kind === "deliverable" ? id : null,
        kind: "comment",
        authorKind: "human",
        markId: body.markId,
        quote: body.quote,
        anchor: { markId: body.markId, quote: body.quote, ...(body.anchor ?? {}) },
        body: body.body as never,
        mentions: (body.mentions ?? []) as never,
      },
    }));
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
    const abort = new AbortController();
    reply.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
    if (reply.raw.destroyed) abort.abort();
    const body = z
      .object({
        prompt: z.string().min(1).max(4000),
        content: PageDocument.optional(),
        mentions: z.array(PageMention).max(40).optional(),
        parentId: z.string().uuid().optional(),
        markId: z.string().optional(),
        quote: z.string().optional(),
        tier: z.enum(["easy", "medium", "high", "max"]).optional(),
        actAs: ActAs.optional(),
      })
      .parse(request.body);
    await assertCommentPage(app.prisma, request.userId, kind, id);
    if (body.parentId) {
      const parent = await app.prisma.pageDiscussion.findFirst({
        where: { id: body.parentId, userId: request.userId, pageKind: kind, pageId: id, deletedAt: null },
      });
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
    const row = await withCommentPage(app.prisma, request.userId, kind, id, (tx) => tx.pageDiscussion.create({
      data: {
        userId: request.userId,
        pageKind: kind,
        pageId: id,
        sourceKind: kind,
        sourceId: id,
        taskId: kind === "task" ? id : null,
        projectId: kind === "project" ? id : null,
        deliverableId: kind === "deliverable" ? id : null,
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
    }));

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
    send("status", { text: "Thinking…", id: row.id, conversationId: conversation.id });
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
        preamble: `${personaBlock(body.actAs ?? settings.assistant.actAs)}\nThis is an inline page request. For a requested diagram or plot, create the artifact using the appropriate tool; the page attaches it below your answer. New diagrams and plots are authorized immediately, but other writes still follow the configured approval policy. For plots, read the mentioned dataset's actual columns with hub_get_dataset; never invent data.`,
        inlineArtifacts: true,
        mentions: [...new Map([...(body.mentions ?? []), ...(body.content ? documentMentions(body.content) : [])].map((mention) => [JSON.stringify([mention.kind, mention.id]), mention])).values()].slice(0, 40),
        referenceContext: [
          await commentPageText(app.prisma, request.userId, kind, id, body.content),
          body.quote ? `Selected text:\n${body.quote}` : "",
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 28_000) || undefined,
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
