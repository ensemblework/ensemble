import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { includedUsage, reserveIncluded, settleIncluded } from "../included/budget.js";
import { IncludedLimitError } from "../included/errors.js";
import { assertInternal } from "./internal.js";

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

  app.get("/api/metrics/credits", async (request) => includedUsage(request.userId));
}
