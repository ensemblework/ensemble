import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  AssistantPageContext,
  PageMention,
  type AssistantStreamFrame,
} from "@ensemble/shared-types";
import { withPastScheduleWarning } from "../assistant/schedule.js";
import { toolAllowedFor, catalog, getTool } from "../assistant/registry.js";
import { appendLedger } from "../lib/ledger.js";
import { abortAssistantTurn, runAssistantTurn, type AssistantTurnResult } from "../assistant/agent.js";
import { loadSettings } from "../lib/settings.js";
import { requestCancel } from "../lib/activity.js";
import { sseHub } from "../lib/sse.js";
import { withUndoGroup } from "../lib/undo.js";
import { replyAfterApply, type ReplyCall } from "../assistant/reply.js";
import { friendlyModelError, parseRuntimeBody } from "../lib/model-error.js";
import { ModelQuotaError } from "../lib/model-quota.js";
import { ModelUnreachableError } from "../lib/model-reach.js";
import { recordModelProbe } from "../lib/probes.js";
import { RuntimeError } from "../lib/runtime.js";
import { persistAssistantText, safePublicError, stripLoneSurrogates, truncateText } from "../lib/text.js";
import { env } from "../config.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";

const TurnBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1),
  model: z.string().optional(),
  tier: z.enum(["easy", "medium", "high", "max"]).optional(),
  reasoningEffort: z.string().optional(),
  page: AssistantPageContext.optional(),
  mentions: z.array(PageMention).optional(),
  referenceContext: z.string().optional(),
});

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/assistant/tools", async () => ({ tools: catalog() }));

  app.get("/api/assistant/conversations", async (request) => {
    const conversations = await app.prisma.assistantConversation.findMany({
      where: { userId: request.userId },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { id: true, title: true, updatedAt: true, createdAt: true },
    });
    return { conversations };
  });

  app.post("/api/assistant/conversations", async (request, reply) => {
    const body = z.object({ title: z.string().optional() }).parse(request.body ?? {});
    const conversation = await app.prisma.assistantConversation.create({
      data: { userId: request.userId, title: truncateText(body.title ?? "", 80) || "New chat" },
    });
    return reply.code(201).send({ conversation });
  });

  app.get("/api/assistant/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await app.prisma.assistantConversation.findFirst({
      where: { id, userId: request.userId },
    });
    if (!conversation) return reply.code(404).send({ error: "Conversation not found." });
    const messages = await app.prisma.assistantMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
    });
    return { conversation, messages };
  });

  /** Applies a write the assistant held as a preview. The engineer pressing Apply is the approval. */
  app.post("/api/assistant/apply", async (request, reply) => {
    const body = z
      .object({
        name: z.string().optional(),
        input: z.record(z.unknown()).optional(),
        conversationId: z.string().uuid().optional(),
        callId: z.string().optional(),
        calls: z
          .array(z.object({ name: z.string(), input: z.record(z.unknown()), callId: z.string().optional() }))
          .optional(),
      })
      .parse(request.body);
    const batch =
      body.calls && body.calls.length > 0
        ? body.calls
        : body.name
          ? [{ name: body.name, input: body.input ?? {}, callId: body.callId }]
          : [];
    if (!batch.length) return reply.code(400).send({ error: "Nothing to apply." });
    const settings = await loadSettings(app.prisma, request.userId);
    const planned: Array<{
      call: { name: string; input: Record<string, unknown>; callId?: string };
      tool: NonNullable<ReturnType<typeof getTool>>;
      input: unknown;
    }> = [];
    for (const call of batch) {
      const tool = getTool(call.name);
      if (!tool || !tool.isWrite || !toolAllowedFor(tool, request.modules)) return reply.code(404).send({ error: `There is no write tool called ${call.name}.` });
      if (!settings.assistant.allowedWriteAreas.includes(tool.area)) {
        return reply.code(403).send({ error: `Writes to ${tool.area} are disabled in your assistant settings.` });
      }
      planned.push({ call, tool, input: tool.input.parse(call.input) });
    }
    if (body.conversationId) {
      for (const item of planned) {
        if (!item.call.callId) continue;
        const locked = await app.redis.set(`ensemble:apply:${request.userId}:${body.conversationId}:${item.call.callId}`, "1", "EX", 120, "NX");
        if (locked !== "OK") {
          const existing = await app.prisma.assistantMessage.findFirst({
            where: { conversationId: body.conversationId, userId: request.userId, role: "assistant" },
            orderBy: { createdAt: "desc" },
          });
          const calls = Array.isArray(existing?.toolCalls) ? (existing.toolCalls as Array<Record<string, unknown>>) : [];
          const prior = calls.find((call) => call.id === item.call.callId && call.state === "ok");
          if (prior && planned.length === 1) {
            return { summary: String(prior.summary ?? "Already applied."), href: (prior.href as string) ?? null, undoEntryId: (prior.undoEntryId as string) ?? null, already: true };
          }
          return reply.code(409).send({ error: "That change is already being applied." });
        }
      }
    }
    const { result, undoEntryId } = await app.prisma.$transaction((tx) =>
      withUndoGroup(tx, { userId: request.userId, actor: "agent", subject: planned[0]!.tool.name }, async () => {
        const results = [];
        for (const item of planned) {
          results.push(
            await item.tool.run(
              {
                app,
                prisma: app.prisma,
                tx,
                userId: request.userId,
                actor: "agent",
                conversationId: body.conversationId,
                settings,
                modules: request.modules,
              },
              item.input,
            ),
          );
        }
        return results;
      }),
    );
    const decorated = result.map((row, index) => ({
      ...row,
      summary: withPastScheduleWarning(row.summary, planned[index]!.input, settings.timezone),
    }));
    const summary = decorated.map((row) => row.summary).filter(Boolean).join(" ");
    const href = result.find((row) => row.href)?.href ?? null;
    await appendLedger({
      userId: request.userId,
      actor: "agent",
      action: "assistant.apply",
      payload: { tool: planned.map((item) => item.tool.name).join(","), summary, undoEntryId },
    });
    const replies: Array<{ id: string; content: string; toolCalls: unknown }> = [];
    if (body.conversationId) {
      const messages = await app.prisma.assistantMessage.findMany({
        where: { conversationId: body.conversationId, userId: request.userId, role: "assistant" },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      const applied = new Map(planned.map((item, index) => [item.call.callId ?? "", decorated[index]!]));
      for (const message of messages) {
        const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as Array<Record<string, unknown>>) : [];
        let changed = false;
        const next = calls.map((call) => {
          const id = typeof call.id === "string" ? call.id : "";
          const piece = applied.get(id);
          const named = !body.calls && call.state === "awaiting_approval" && call.name === body.name && (!body.callId || call.id === body.callId);
          if (call.state !== "awaiting_approval" || (!piece && !named)) return call;
          changed = true;
          const chosen = piece ?? decorated[0];
          return { ...call, state: "ok", summary: chosen?.summary ?? summary, undoEntryId, ...(chosen?.href ? { href: chosen.href } : {}) };
        });
        if (!changed) continue;
        const content = replyAfterApply(message.content, next as ReplyCall[]);
        await app.prisma.assistantMessage.update({
          where: { id: message.id },
          data: { toolCalls: next as never, content },
        });
        replies.push({ id: message.id, content, toolCalls: next });
        if (!body.calls) break;
      }
    }
    sseHub.publish(request.userId, {
      event: "assistant.acted",
      data: { tool: planned[0]!.tool.name, keys: result.flatMap((row) => row.invalidate ?? []) },
    });
    return { summary, href, undoEntryId, replies };
  });

  app.post("/api/assistant/conversations/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await app.prisma.assistantConversation.findFirst({ where: { id, userId: request.userId }, select: { id: true } });
    if (!owned) return reply.code(404).send({ error: "Conversation not found." });
    abortAssistantTurn(id);
    await requestCancel(app.redis, request.userId, `assistant:${id}`);
    return reply.code(204).send();
  });

  app.post("/api/assistant/turn", async (request, reply) => {
    const body = TurnBody.parse(request.body);
    const message = stripLoneSurrogates(body.message);
    if (!message.trim()) return reply.code(400).send({ error: "That message could not be read." });
    const settings = await loadSettings(app.prisma, request.userId);
    const conversation = body.conversationId
      ? await app.prisma.assistantConversation.findFirst({
          where: { id: body.conversationId, userId: request.userId },
        })
      : await app.prisma.assistantConversation.create({
          data: { userId: request.userId, title: truncateText(message, 60) || "New chat" },
        });
    if (!conversation) return reply.code(404).send({ error: "Conversation not found." });

    const userMessage = await app.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        userId: request.userId,
        role: "user",
        content: message,
      },
    });

    // Open on the first frame. A quota or unreachable miss after that is an SSE
    // error and is not saved. The frame below is that first frame: the dock
    // needs the conversation id before the model is called, or Stop on a new
    // chat has no turn to cancel. It carries no status text.
    let streamed = false;
    let raw: typeof reply.raw | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    const openStream = () => {
      if (streamed) return;
      streamed = true;
      reply.hijack();
      raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // hijack() skips @fastify/cors; the desktop webview calls this cross-origin.
        ...streamCorsHeaders(request.headers.origin, hubCorsPolicy()),
      });
      ping = setInterval(() => {
        if (raw && !raw.writableEnded) raw.write(`: ping\n\n`);
      }, 15_000);
    };
    const send = (event: string, data: unknown) => {
      openStream();
      if (!raw || raw.writableEnded) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = () => {
      if (ping) clearInterval(ping);
      if (raw && !raw.writableEnded) raw.end();
    };
    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());
    send("status", { conversationId: conversation.id });

    const tierName = body.tier ?? settings.assistant.defaultTier;
    const tierSetting = settings.models[tierName];
    const explicitModel = body.model && body.model !== "auto" ? body.model : null;
    const modelName = explicitModel ?? (tierSetting.model || envDefaultModel());

    let result: AssistantTurnResult;
    try {
      result = await runAssistantTurn({
        provider: explicitModel ? undefined : tierSetting.provider,
        app,
        userId: request.userId,
        modules: request.modules,
        conversationId: conversation.id,
        message,
        page: body.page,
        settings,
        model: modelName,
        reasoningEffort:
          body.reasoningEffort ??
          (tierSetting.effort !== "default" ? tierSetting.effort : settings.assistant.reasoningEffort),
        messageId: userMessage.id,
        mentions: body.mentions,
        referenceContext: body.referenceContext,
        signal: abort.signal,
        emit(frame) {
          send(frame.type, frame);
          sseHub.publish(request.userId, { event: "assistant.frame", data: { conversationId: conversation.id, frame } });
        },
      });
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        result = {
          content: "Stopped.",
          toolCalls: [],
          model: modelName,
          credits: null,
          mutated: false,
          interrupted: true,
        };
        send("status", { text: "Stopped." });
      } else if (error instanceof ModelQuotaError) {
        void recordModelProbe(app.prisma, request.userId, tierSetting.provider, modelName, "quota", error.message).catch(() => undefined);
        if (!streamed) return reply.code(429).send(error.toJSON());
        send("error", error.toJSON());
        finish();
        return;
      } else if (error instanceof ModelUnreachableError) {
        if (!streamed) return reply.code(503).send(error.toJSON());
        send("error", error.toJSON());
        finish();
        return;
      } else {
        const failure = parseRuntimeBody(error instanceof RuntimeError ? error.statusCode : 502, error instanceof Error ? error.message : String(error));
        const shown = safePublicError(error, error instanceof RuntimeError ? error.message : friendlyModelError(failure));
        if (failure.kind === "not_found" || failure.kind === "quota" || failure.kind === "unavailable") {
          void recordModelProbe(app.prisma, request.userId, tierSetting.provider, modelName, failure.kind, shown).catch(() => undefined);
        }
        if (failure.kind === "quota") {
          const quota = { code: "model_quota_exceeded" as const, error: shown, message: shown, model: modelName, status: 429 as const };
          if (!streamed) return reply.code(429).send(quota);
          send("error", quota);
          finish();
          return;
        }
        result = { content: shown, toolCalls: [], model: modelName, credits: null, mutated: false };
        const status = error instanceof RuntimeError ? error.statusCode : failure.status || 502;
        send("error", { message: shown, status });
      }
    }

    const persisted = await saveAssistantReply(app, request.userId, conversation.id, result);
    try {
      await touchConversation(app, conversation.id, conversation.title, message);
    } catch (error) {
      app.log.error({ err: error }, "Could not update the conversation title");
    }
    send("done", {
      conversationId: conversation.id,
      messageId: persisted.id,
      content: persisted.shown,
      toolCalls: result.toolCalls,
      model: result.model,
      tier: tierName,
      interrupted: result.interrupted ?? false,
      ...(persisted.saveFailed ? { saveFailed: true } : {}),
    });
    finish();
  });
}

async function touchConversation(
  app: FastifyInstance,
  conversationId: string,
  title: string,
  message: string,
): Promise<void> {
  await app.prisma.assistantConversation.update({
    where: { id: conversationId },
    data: { title: title === "New chat" ? truncateText(message, 60) || "New chat" : undefined, updatedAt: new Date() },
  });
}

async function saveAssistantReply(
  app: FastifyInstance,
  userId: string,
  conversationId: string,
  result: AssistantTurnResult,
): Promise<{ id: string; shown: string; saveFailed: boolean }> {
  let id = "";
  const persisted = await persistAssistantText(
    async (content) => {
      const row = await app.prisma.assistantMessage.create({
        data: {
          conversationId,
          userId,
          role: "assistant",
          content,
          toolCalls: result.toolCalls as never,
          model: result.model,
          credits: result.credits ?? undefined,
        },
      });
      id = row.id;
    },
    result.content || "The assistant did not produce a reply.",
    (error) => app.log.error({ err: error }, "Could not save the assistant reply"),
  );
  return { id, shown: persisted.shown, saveFailed: persisted.saved !== persisted.shown };
}

function envDefaultModel(): string {
  return process.env.ENSEMBLE_MODEL_CODER ?? process.env.ENSEMBLE_MODEL_PLANNER ?? "gemini-3.5-flash-lite";
}
