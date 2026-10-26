import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ownDevice } from "../devices/routes.js";
import { includedUsage, reserveIncluded, settleIncluded } from "../included/budget.js";
import { includedCatalogEntry } from "../included/catalog.js";
import { deviceCredits, INCLUDED_STATUS_ROUTE, INCLUDED_TURN_ROUTE, onDevice } from "../included/device.js";
import { IncludedLimitError } from "../included/errors.js";
import { includedTurn } from "../runtime/included.js";
import { assertInternal } from "./internal.js";

const Message = z.record(z.string(), z.unknown());

/** One included call from a connected computer: the request its runtime built, without the account. */
const DeviceTurn = z.object({
  model: z.string().min(1).max(80),
  messages: z.array(Message).max(4000),
  items: z.array(z.unknown()).max(8000).nullish(),
  jsonMode: z.boolean().optional(),
  reasoningEffort: z.string().max(20).nullish(),
  chatTools: z.array(Message).max(400).nullish(),
  responsesTools: z.array(Message).max(400).nullish(),
  purpose: z.string().max(80).nullish(),
});

/**
 * A long conversation with tool output can pass the default 4 MB, and attachments (up to 32 MB of
 * them, files/model-input.ts) travel as base64; a Responses model's history comes once, as `items`.
 */
const DEVICE_TURN_BODY_LIMIT = 64 * 1024 * 1024;

const Tokens = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});

export async function includedRoutes(app: FastifyInstance): Promise<void> {
  // agent-runtime holds the Azure key and asks here before and after each included call.
  app.post("/api/internal/included/reserve", async (request, reply) => {
    assertInternal(request);
    const body = z
      .object({
        model: z.string().min(1).max(80),
        inputTokens: z.number().int().nonnegative(),
        maxOutputTokens: z.number().int().positive().max(200_000),
        purpose: z.string().max(80).nullish(),
      })
      .parse(request.body);
    try {
      return await reserveIncluded({ userId: request.userId, ...body });
    } catch (error) {
      if (error instanceof IncludedLimitError) return reply.code(error.statusCode).send(error.toJSON());
      throw error;
    }
  });

  app.post("/api/internal/included/settle", async (request) => {
    assertInternal(request);
    const body = z.object({ id: z.string().uuid(), usage: Tokens.nullable(), answeredBy: z.string().max(200).nullish() }).parse(request.body);
    return settleIncluded(body);
  });

  // In the desktop app and the CLI, the account's credits as Ensemble on the web counts them.
  app.get("/api/metrics/credits", async (request) => (onDevice() ? deviceCredits() : includedUsage(request.userId)));

  // A computer connected to this account (the desktop app or the CLI) holds no Azure key and no
  // ledger: it reads the account's included models and credits here, and its included calls run
  // here, on the account's credits and under the same monthly ceiling as the web (included/device.ts).
  app.get(INCLUDED_STATUS_ROUTE, async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    return { catalog: includedCatalogEntry(), usage: await includedUsage(device.userId) };
  });

  app.post(INCLUDED_TURN_ROUTE, { bodyLimit: DEVICE_TURN_BODY_LIMIT }, async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const body = DeviceTurn.parse(request.body);
    // The computer stopped the turn or went away: stop the model call too.
    const stop = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) stop.abort();
    });
    try {
      const turn = await includedTurn(
        { userId: device.userId, reasoningEffort: body.reasoningEffort ?? null, chatTools: body.chatTools ?? null, responsesTools: body.responsesTools ?? null, purpose: body.purpose ?? null },
        body.model,
        body.messages,
        { items: body.items ?? null, jsonMode: body.jsonMode, signal: stop.signal, timeoutMs: body.jsonMode ? 120_000 : 300_000 },
      );
      return { turn };
    } catch (error) {
      if (error instanceof IncludedLimitError) return reply.code(error.statusCode).send(error.toJSON());
      throw error;
    }
  });
}
