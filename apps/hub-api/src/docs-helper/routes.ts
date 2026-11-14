import type { FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { z } from "zod";
import { documentationIndex } from "./grounding.js";
import { answerQuestion, callIncludedDocs } from "./answer.js";
import { admitDocs, docsAddress } from "./limits.js";

export const DOCS_ASK_PATH = "/api/docs/ask";
export const docsCors: FastifyCorsOptions = { origin: "https://docs.ensemblework.com", credentials: false, methods: ["POST"], allowedHeaders: ["Content-Type"], exposedHeaders: ["Retry-After"] };
const Question = z.object({ question: z.string().trim().min(1).max(500) }).strict();
export type DocsDependencies = { index: ReturnType<typeof documentationIndex>; call: typeof callIncludedDocs; admit: (address: string) => Promise<number> };
export async function docsHelperRoutes(app: FastifyInstance, options: { dependencies?: DocsDependencies } = {}) {
  const deps = options.dependencies ?? { index: documentationIndex(), call: callIncludedDocs, admit: (address: string) => admitDocs(app.redis, address) };
  app.post(DOCS_ASK_PATH, { bodyLimit: 2048 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = Question.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ask a question using 1 to 500 characters." });
    try {
      const wait = await deps.admit(docsAddress(request));
      if (wait > 0) return reply.header("Retry-After", String(wait)).code(429).send({ error: "The docs helper has reached its limit. Please try again later or use search." });
      return await answerQuestion(parsed.data.question, await deps.index(), deps.call);
    } catch {
      return reply.code(503).send({ error: "The docs helper could not answer. Try again or use search." });
    }
  });
}
