/**
 * Bringing files in from connected apps (Drive, Gmail, OneDrive, Outlook, Dropbox, Box),
 * with plain guidance when a connection or permission is missing. Docs: docs/32_FILES.md.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { importFromApp, importSources, IMPORT_KINDS } from "../files/import.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";

const ImportRef = z.object({
  source: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/),
  kind: z.enum(IMPORT_KINDS),
  id: z.string().trim().min(1).max(300),
});

const limiter = new MemoryRateLimiter();
const LIMIT = { limit: 60, windowMs: 10 * 60_000, error: "Too many files brought in at once. Wait a minute and try again." };

export async function fileImportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/documents/import-sources", async (request) => {
    await requireVerifiedUser(request.userId);
    return { sources: await importSources(app.prisma, request.userId) };
  });

  app.post("/api/documents/import", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const ref = ImportRef.parse(request.body ?? {});
    const wait = limiter.take(`file-import:${request.userId}`, LIMIT.limit, LIMIT.windowMs);
    if (wait !== null) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
      return reply.code(429).send({ error: LIMIT.error });
    }
    const { file, existing } = await importFromApp(app.prisma, request.userId, ref);
    return reply.code(existing ? 200 : 201).send({ file });
  });
}
