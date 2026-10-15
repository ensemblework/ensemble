import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sseHub } from "../lib/sse.js";
import { CollabError, LIMITS, type CollabCode } from "../pages/collab-core.js";
import { CollabHub, type DocKey, type DocKind } from "../pages/collab.js";
import { readCollabPage, writeCollabPage, type CollabTarget } from "../pages/store.js";

const target = (key: DocKey): CollabTarget => (key.kind === "page" ? { pageId: key.id } : { taskId: key.id });

/** The live documents of this API process (docs/29 §5). */
export const collabHub = new CollabHub(
  {
    read: (key) => readCollabPage(prisma, key.space, target(key)),
    write: (key, decide) => writeCollabPage(prisma, key.space, target(key), decide),
  },
  (space, event, data) => sseHub.publish(space, { event, data }),
);

const STATUS: Record<CollabCode, number> = { COLLAB_BEHIND: 409, COLLAB_RESET: 410, COLLAB_REJECTED: 400, COLLAB_TOO_LARGE: 413 };

const Params = z.object({ id: z.string().uuid() });
const Since = z.object({ epoch: z.string().min(1).max(64), version: z.coerce.number().int().nonnegative() });
const Steps = z.object({
  epoch: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  clientID: z.union([z.string().min(1).max(100), z.number().finite()]),
  steps: z.array(z.record(z.unknown())).max(LIMITS.batch),
  /** Also write the page back now and answer with its stored revision. */
  flush: z.boolean().optional(),
});

async function answer(reply: FastifyReply, kind: DocKind, work: () => Promise<unknown>) {
  try {
    const result = await work();
    if (result === null) return reply.code(404).send({ error: kind === "page" ? "Page not found." : "Task not found." });
    return result;
  } catch (error) {
    if (error instanceof CollabError) return reply.code(STATUS[error.code]).send({ error: error.message, code: error.code, ...(error.batch ?? {}) });
    throw error;
  }
}

/**
 * Live co-editing: `GET` joins (`{epoch, version, doc, revision}`), `GET ?epoch&version` returns
 * the steps since, `POST` sends steps. Everyone's steps also go out as `page.steps` events.
 */
export async function collabRoutes(app: FastifyInstance): Promise<void> {
  collabHub.onError = (error) => app.log.error({ err: error }, "live page write-back failed");
  const stop = sseHub.onFrame(({ userId, frame }) => collabHub.changed(userId, frame.event, frame.data));
  app.addHook("onClose", async () => {
    stop();
    await collabHub.close();
  });

  const routes: Array<[DocKind, string]> = [
    ["page", "/api/pages/:id/collab"],
    ["task", "/api/tasks/:id/page/collab"],
  ];
  for (const [kind, path] of routes) {
    app.get(path, async (request, reply) => {
      const key: DocKey = { space: request.userId, kind, id: Params.parse(request.params).id };
      const query = (request.query ?? {}) as Record<string, unknown>;
      if (query.version === undefined) return answer(reply, kind, () => collabHub.join(key));
      const since = Since.parse(query);
      return answer(reply, kind, () => collabHub.since(key, since.epoch, since.version));
    });

    app.post(path, async (request, reply) => {
      const key: DocKey = { space: request.userId, kind, id: Params.parse(request.params).id };
      const body = Steps.parse(request.body);
      return answer(reply, kind, () => collabHub.post(key, body));
    });
  }
}
