import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import { actorFor, keysFor } from "../sharing/context.js";
import {
  AssistantPageContext,
  PageMention,
  type AssistantStreamFrame,
} from "@ensemble/shared-types";
import { withPastScheduleWarning } from "../assistant/schedule.js";
import { toolAllowedFor, catalog } from "../assistant/registry.js";
import { resolveTool, writeRefusal } from "../assistant/apps.js";
import { applyHeldCalls, isOutsideWrite, type AppliedBatch } from "../assistant/apply.js";
import { ToolBlockedError, type AnyHubTool, type CodeSession } from "../assistant/types.js";
import { codeTool } from "../assistant/tools/code.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { appendLedger } from "../lib/ledger.js";
import { abortAssistantTurn, runAssistantTurn, type AssistantTurnResult } from "../assistant/agent.js";
import { resolveTypedMentions } from "../assistant/mentions.js";
import { loadSettings } from "../lib/settings.js";
import { requestCancel } from "../lib/activity.js";
import { sseHub } from "../lib/sse.js";
import { replyAfterApply, type ReplyCall } from "../assistant/reply.js";
import { friendlyModelError, parseRuntimeBody } from "../lib/model-error.js";
import { ModelChoiceError, providerForModel } from "../lib/model-choice.js";
import { ModelQuotaError } from "../lib/model-quota.js";
import { INCLUDED_PROVIDER } from "@ensemble/shared-types";
import { assertIncludedOpen } from "../included/budget.js";
import { IncludedLimitError } from "../included/errors.js";
import { ModelUnreachableError } from "../lib/model-reach.js";
import { recordModelProbe } from "../lib/probes.js";
import { RuntimeError } from "../lib/runtime.js";
import { persistAssistantText, safePublicError, stripLoneSurrogates, truncateText } from "../lib/text.js";
import { env } from "../config.js";
import { assistantHeaders } from "../assistant/request.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";

/** Ensemble Code (the CLI's Chat tab): only the runtime on the person's own computer accepts it. */
const CodeBody = z.object({
  folder: z.string().min(1).max(1000),
  engine: z.enum(["ensemble", "claude-code", "codex", "cursor-agent"]).optional(),
  profileId: z.string().max(40).nullish(),
  runModel: z.string().max(240).nullish(),
  outsideAccess: z.enum(["none", "read", "read-write"]).optional(),
});

/** The code session for a request, or a 409 reason when this is not the person's own computer. */
async function codeSession(body: z.infer<typeof CodeBody> | undefined): Promise<CodeSession | undefined> {
  if (!body) return undefined;
  if (process.env.ENSEMBLE_DESKTOP !== "1") throw Object.assign(new Error("Ensemble Code runs on your own computer: open `ensemble` there."), { statusCode: 409 });
  const folder = await realpath(isAbsolute(body.folder) ? body.folder : resolve(body.folder)).catch(() => {
    throw Object.assign(new Error("That folder does not exist."), { statusCode: 400 });
  });
  return { folder, engine: body.engine, profileId: body.profileId ?? null, runModel: body.runModel ?? null, outsideAccess: body.outsideAccess };
}

const TurnBody = z.object({
  conversationId: z.string().uuid().optional(),
  code: CodeBody.optional(),
  message: z.string().min(1),
  model: z.string().optional(),
  /** With `model`: whose model it is (the CLI's model picker). */
  provider: z.string().max(40).optional(),
  tier: z.enum(["easy", "medium", "high", "max"]).optional(),
  reasoningEffort: z.string().optional(),
  page: AssistantPageContext.optional(),
  mentions: z.array(PageMention).optional(),
  referenceContext: z.string().optional(),
});

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/assistant/tools", async () => ({ tools: catalog() }));

  app.get("/api/assistant/conversations", async (request) => {
    // `?chats=1`: the dock's chats only. Inline @ensemble answers and comment replies keep conversation rows without messages.
    const chats = (request.query as { chats?: string } | undefined)?.chats === "1";
    const conversations = await app.prisma.assistantConversation.findMany({
      // Each person's chats are their own, even in a shared space. Ensemble Node's working
      // conversations (startedOn "node") belong to its rooms, not to this list.
      where: {
        userId: request.userId,
        accountId: actorFor(request.userId),
        OR: [{ startedOn: null }, { startedOn: { not: "node" } }],
        ...(chats ? { messages: { some: {} } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: chats ? 20 : 40,
      select: { id: true, title: true, updatedAt: true, createdAt: true },
    });
    return { conversations };
  });

  app.post("/api/assistant/conversations", async (request, reply) => {
    const body = z.object({ title: z.string().optional() }).parse(request.body ?? {});
    const conversation = await app.prisma.assistantConversation.create({
      data: { userId: request.userId, accountId: actorFor(request.userId), title: truncateText(body.title ?? "", 80) || "New chat" },
    });
    return reply.code(201).send({ conversation });
  });

  app.get("/api/assistant/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await app.prisma.assistantConversation.findFirst({
      where: { id, userId: request.userId, accountId: actorFor(request.userId) },
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
        code: CodeBody.optional(),
      })
      .parse(request.body);
    const code = await codeSession(body.code);
    if (body.conversationId) {
      const owned = await app.prisma.assistantConversation.findFirst({
        where: { id: body.conversationId, userId: request.userId, accountId: actorFor(request.userId) },
        select: { id: true },
      });
      if (!owned) return reply.code(404).send({ error: "Conversation not found." });
    }
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
      tool: AnyHubTool;
      input: unknown;
    }> = [];
    for (const call of batch) {
      const tool = (code ? codeTool(call.name) : undefined) ?? (await resolveTool({ prisma: app.prisma, userId: request.userId }, call.name));
      if (!tool || !tool.isWrite || !toolAllowedFor(tool, request.modules)) return reply.code(404).send({ error: `There is no write tool called ${call.name}.` });
      const refusal = writeRefusal(tool, settings);
      if (refusal) return reply.code(403).send({ error: refusal });
      planned.push({ call, tool, input: tool.input.parse(call.input) });
    }
    // A call this conversation already applied never runs again: not on a resend, and not after its lock expires.
    const stored = body.conversationId ? await storedCalls(app, request.userId, body.conversationId) : new Map<string, Record<string, unknown>>();
    for (const item of planned.filter(row => row.tool.name === "hub_run_workflow")) {
      const original = item.call.callId ? stored.get(item.call.callId) : undefined;
      if (!original || original.name !== item.tool.name || !isDeepStrictEqual(item.tool.input.parse(original.input), item.input)) {
        return reply.code(409).send({ error: "This workflow does not match its saved proposal. Ask the assistant to propose the changed plan." });
      }
    }
    const done = planned.filter((item) => item.call.callId && stored.get(item.call.callId)?.state === "ok");
    const pending = planned.filter((item) => !done.includes(item));
    if (!pending.length) {
      const prior = done.map((item) => stored.get(item.call.callId!)!);
      const first = (key: string) => (prior.find((call) => typeof call[key] === "string")?.[key] as string | undefined) ?? null;
      return {
        summary: prior.map((call) => String(call.summary ?? "")).filter(Boolean).join(" ") || "Already applied.",
        href: first("href"),
        undoEntryId: first("undoEntryId"),
        already: true,
      };
    }
    const locks: Array<{ callId: string; key: string }> = [];
    const release = async (keys: string[]) => {
      if (keys.length) await app.redis.del(...keys);
    };
    if (body.conversationId) {
      for (const item of pending) {
        if (!item.call.callId) continue;
        const key = `ensemble:apply:${request.userId}:${body.conversationId}:${item.call.callId}`;
        const locked = await app.redis.set(key, "1", "EX", 120, "NX");
        if (locked !== "OK") {
          await release(locks.map((lock) => lock.key));
          return reply.code(409).send({ error: "That change is already being applied." });
        }
        locks.push({ callId: item.call.callId, key });
      }
    }
    // Hub writes share one transaction and undo entry; connected-app writes run after it, outside any transaction.
    let batchResult: AppliedBatch;
    try {
      batchResult = await applyHeldCalls(
        app,
        { app, prisma: app.prisma, userId: request.userId, actor: "agent", conversationId: body.conversationId, settings, modules: request.modules, requestHeaders: assistantHeaders(request), ...(code ? { code } : {}) },
        pending,
      );
    } catch (error) {
      // Nothing ran, so the same Apply can be pressed again straight away.
      await release(locks.map((lock) => lock.key));
      // A refusal (a folder Ensemble may not use, a missing trust) is the person's to act on: say why.
      if (error instanceof ToolBlockedError) return reply.code(400).send({ error: error.remedy ? `${error.message} ${error.remedy}` : error.message });
      throw error;
    }
    const { outcomes, undoEntryId, partial } = batchResult;
    const pieces: AppliedPiece[] = outcomes.map((outcome, index) => {
      const item = pending[index]!;
      if (!outcome.ok) return { state: "failed", error: outcome.error, attempted: outcome.attempted };
      return {
        state: "ok",
        summary: withPastScheduleWarning(outcome.result.summary, item.input, settings.timezone),
        href: outcome.result.href ?? null,
        // An outside write cannot be undone; only Hub writes share the batch's undo entry.
        undoEntryId: isOutsideWrite(item.tool) ? null : undoEntryId,
        invalidate: outcome.result.invalidate ?? [],
      };
    });
    const landed = pieces.filter((piece): piece is Extract<AppliedPiece, { state: "ok" }> => piece.state === "ok");
    const failed = pending.flatMap((item, index) => {
      const piece = pieces[index]!;
      return piece.state === "failed" ? [{ callId: item.call.callId ?? null, name: item.tool.name, error: piece.error, attempted: piece.attempted }] : [];
    });
    const summary = landed.map((piece) => piece.summary).filter(Boolean).join(" ");
    const href = landed.find((piece) => piece.href)?.href ?? null;
    const notApplied = failed.map((row) => ({ name: row.name, state: "failed", error: row.error, isWrite: true }));
    const mark = (call: Record<string, unknown>, piece: AppliedPiece): Record<string, unknown> =>
      piece.state === "ok"
        ? { ...call, state: "ok", summary: piece.summary, undoEntryId: piece.undoEntryId, ...(piece.href ? { href: piece.href } : {}) }
        : { ...call, state: "failed", error: piece.error, summary: piece.error };
    // Recorded before anything else, so a later failure cannot leave a landed call looking unapplied.
    const replies: Array<{ id: string; content: string; toolCalls: unknown }> = [];
    if (body.conversationId) {
      const messages = await app.prisma.assistantMessage.findMany({
        where: { conversationId: body.conversationId, userId: request.userId, role: "assistant" },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      const applied = new Map(pending.map((item, index) => [item.call.callId ?? "", pieces[index]!]));
      for (const message of messages) {
        const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as Array<Record<string, unknown>>) : [];
        let changed = false;
        const failedHere: typeof notApplied = [];
        const next = calls.map((call) => {
          const id = typeof call.id === "string" ? call.id : "";
          const piece = applied.get(id);
          const named = !body.calls && call.state === "awaiting_approval" && call.name === body.name && (!body.callId || call.id === body.callId);
          // A call that failed on an earlier Apply can be applied again by id.
          const open = call.state === "awaiting_approval" || (piece !== undefined && call.state === "failed");
          if (!open || (!piece && !named)) return call;
          changed = true;
          const chosen = piece ?? pieces[0]!;
          if (chosen.state === "failed") failedHere.push({ name: String(call.name ?? ""), state: "failed", error: chosen.error, isWrite: true });
          return mark(call, chosen);
        });
        if (!changed) continue;
        const content = replyAfterApply(message.content, next as ReplyCall[], failedHere);
        await app.prisma.assistantMessage.update({
          where: { id: message.id },
          data: { toolCalls: next as never, content },
        });
        replies.push({ id: message.id, content, toolCalls: next });
        if (!body.calls) break;
      }
      const discussions = await app.prisma.pageDiscussion.findMany({
        where: { userId: request.userId, conversationId: body.conversationId, authorKind: "ensemble", deletedAt: null },
      });
      for (const discussion of discussions) {
        const calls = Array.isArray(discussion.toolCalls) ? discussion.toolCalls as Array<Record<string, unknown>> : [];
        let changed = false;
        const failedHere: typeof notApplied = [];
        const next = calls.map((call) => {
          const piece = applied.get(typeof call.id === "string" ? call.id : "");
          if (!piece || (call.state !== "awaiting_approval" && call.state !== "failed")) return call;
          changed = true;
          if (piece.state === "failed") failedHere.push({ name: String(call.name ?? ""), state: "failed", error: piece.error, isWrite: true });
          return mark(call, piece);
        });
        if (!changed) continue;
        const savedBody = discussion.body && typeof discussion.body === "object" && !Array.isArray(discussion.body) ? discussion.body : {};
        const text = typeof savedBody.text === "string" ? savedBody.text : "";
        await app.prisma.pageDiscussion.update({
          where: { id: discussion.id },
          data: { toolCalls: next as never, body: { ...savedBody, text: replyAfterApply(text, next as ReplyCall[], failedHere) } },
        });
      }
    }
    // Failed and unsent calls may be applied again; landed ones keep their lock and are now recorded as ok.
    await release(locks.filter((lock) => failed.some((row) => row.callId === lock.callId)).map((lock) => lock.key));
    try {
      await appendLedger({
        userId: request.userId,
        actor: "agent",
        action: "assistant.apply",
        payload: {
          tool: pending.filter((_item, index) => pieces[index]!.state === "ok").map((item) => item.tool.name).join(","),
          summary,
          undoEntryId,
          ...(partial ? { partial: true, failed: failed.map((row) => ({ tool: row.name, error: row.error, attempted: row.attempted })) } : {}),
        },
      });
    } catch (error) {
      // The changes already happened and are recorded on the reply; failing now would invite a second Apply.
      request.log.error({ err: error }, "Could not ledger an assistant Apply");
    }
    sseHub.publish(request.userId, {
      event: "assistant.acted",
      data: { tool: pending[0]!.tool.name, keys: landed.flatMap((piece) => piece.invalidate) },
    });
    return { summary, href, undoEntryId, replies, ...(partial ? { partial: true, failed } : {}) };
  });

  app.post("/api/assistant/conversations/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await app.prisma.assistantConversation.findFirst({ where: { id, userId: request.userId, accountId: actorFor(request.userId) }, select: { id: true } });
    if (!owned) return reply.code(404).send({ error: "Conversation not found." });
    abortAssistantTurn(id);
    await requestCancel(app.redis, request.userId, `assistant:${id}`);
    return reply.code(204).send();
  });

  app.post("/api/assistant/turn", async (request, reply) => {
    const body = TurnBody.parse(request.body);
    const code = await codeSession(body.code);
    const message = stripLoneSurrogates(body.message);
    if (!message.trim()) return reply.code(400).send({ error: "That message could not be read." });
    const settings = await loadSettings(app.prisma, request.userId);
    const conversation = body.conversationId
      ? await app.prisma.assistantConversation.findFirst({
          where: { id: body.conversationId, userId: request.userId, accountId: actorFor(request.userId) },
        })
      : await app.prisma.assistantConversation.create({
          data: { userId: request.userId, accountId: actorFor(request.userId), title: truncateText(message, 60) || "New chat" },
        });
    if (!conversation) return reply.code(404).send({ error: "Conversation not found." });

    // `@people:Mira Chen` typed without an id (by hand, pasted, from the terminal app) gets one when it names one record here.
    // Saved on the message, so the dock shows these exact mentions after a reload.
    const mentions = await resolveTypedMentions(app.prisma, request.userId, request.modules, message, body.mentions);
    const userMessage = await app.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        userId: request.userId,
        role: "user",
        content: message,
        mentions: mentions as never,
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
    send("status", { conversationId: conversation.id, userMessageId: userMessage.id });

    const tierName = body.tier ?? settings.assistant.defaultTier;
    const tierSetting = settings.models[tierName];
    const explicitModel = body.model && body.model !== "auto" ? body.model : null;
    // A model picked here keeps its own provider; a tier without a model is said, never filled with a Gemini default.
    let callProvider: string = tierSetting.provider;
    let refused: string | null = null;
    try {
      if (explicitModel) callProvider = providerForModel(settings, explicitModel, body.provider);
    } catch (error) {
      if (!(error instanceof ModelChoiceError)) throw error;
      refused = error.message;
    }
    const modelName = explicitModel ?? tierSetting.model;
    if (!refused && !modelName) refused = `No model is set for the ${tierName} tier. Pick one in Settings → Models.`;
    if (!refused && callProvider === INCLUDED_PROVIDER) {
      // No credits or the shared budget used up: say so before any model work starts.
      try {
        await assertIncludedOpen(keysFor(request.userId), modelName);
      } catch (error) {
        if (!(error instanceof IncludedLimitError)) throw error;
        send("error", error.toJSON());
        finish();
        return;
      }
    }

    let result: AssistantTurnResult;
    if (refused) {
      result = { failed: true, content: refused, toolCalls: [], model: modelName, credits: null, mutated: false };
      send("error", { message: refused, status: 400 });
    } else try {
      result = await runAssistantTurn({
        requestHeaders: assistantHeaders(request),
        provider: callProvider,
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
          (tierSetting.effort !== "default" ? tierSetting.effort : callProvider === INCLUDED_PROVIDER ? undefined : settings.assistant.reasoningEffort),
        messageId: userMessage.id,
        mentions,
        referenceContext: body.referenceContext,
        ...(code ? { code } : {}),
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
      } else if (error instanceof IncludedLimitError) {
        if (!streamed) return reply.code(error.statusCode).send(error.toJSON());
        send("error", error.toJSON());
        finish();
        return;
      } else if (error instanceof ModelQuotaError) {
        void recordModelProbe(app.prisma, request.userId, callProvider, modelName, "quota", error.message).catch(() => undefined);
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
        const shown = safePublicError(error, error instanceof RuntimeError ? error.message : friendlyModelError(failure, modelName, callProvider));
        if (failure.kind === "not_found" || failure.kind === "quota" || failure.kind === "unavailable") {
          void recordModelProbe(app.prisma, request.userId, callProvider, modelName, failure.kind, shown).catch(() => undefined);
        }
        if (failure.kind === "quota") {
          const quota = { code: "model_quota_exceeded" as const, error: shown, message: shown, model: modelName, status: 429 as const };
          if (!streamed) return reply.code(429).send(quota);
          send("error", quota);
          finish();
          return;
        }
        result = { failed: true, content: shown, toolCalls: [], model: modelName, credits: null, mutated: false };
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
      credentialSource: result.credentialSource,
      tier: tierName,
      interrupted: result.interrupted ?? false,
      failed: result.failed ?? false,
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
          role: result.failed ? "error" : "assistant",
          content,
          toolCalls: result.toolCalls as never,
          model: result.failed ? null : result.model,
          credentialSource: result.credentialSource,
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

type AppliedPiece =
  | { state: "ok"; summary: string; href: string | null; undoEntryId: string | null; invalidate: string[] }
  | { state: "failed"; error: string; attempted: boolean };

/** Tool calls saved on this conversation's replies and page answers, by call id; an "ok" copy wins. */
async function storedCalls(app: FastifyInstance, userId: string, conversationId: string): Promise<Map<string, Record<string, unknown>>> {
  const [messages, discussions] = await Promise.all([
    app.prisma.assistantMessage.findMany({
      where: { conversationId, userId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { toolCalls: true },
    }),
    app.prisma.pageDiscussion.findMany({
      where: { userId, conversationId, authorKind: "ensemble", deletedAt: null },
      select: { toolCalls: true },
    }),
  ]);
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...messages, ...discussions]) {
    const calls = Array.isArray(row.toolCalls) ? (row.toolCalls as Array<Record<string, unknown>>) : [];
    for (const call of calls) {
      if (!call || typeof call.id !== "string") continue;
      if (!byId.has(call.id) || call.state === "ok") byId.set(call.id, call);
    }
  }
  return byId;
}
