import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { sseHub } from "../lib/sse.js";
import { CollabError, type CollabCode } from "../pages/collab-core.js";
import type { DocKey, DocKind } from "../pages/collab.js";
import { collabHub } from "../pages/live.js";

export { collabHub };

const STATUS: Record<CollabCode, number> = {
  COLLAB_BEHIND: 409,
  COLLAB_RESET: 410,
  COLLAB_REJECTED: 400,
  COLLAB_TOO_LARGE: 413,
  COLLAB_UNSAVED: 503,
  PAGE_IN_TRASH: 404,
  COLLAB_REJOIN: 410,
};

/** Editors' client ids start with the account's id, so one person's tab cannot pass as another's on the stream. */
const accountOf = (request: FastifyRequest) => request.accountId ?? request.userId;

/**
 * Client ids are public (on the stream); the token that goes with one is only in its join's
 * answer, so nobody else can send steps as that editor. A restart makes new ones (new epoch).
 */
const SECRET = randomBytes(32);
const tokenFor = (clientID: string) => createHmac("sha256", SECRET).update(clientID).digest("base64url");

/**
 * A request of steps: more than the API's usual 4 MiB, so that one step of the largest kind
 * (1,000,000 characters of JSON, up to 3 bytes each in UTF-8) always fits. Editors send at most
 * 1 MiB of steps at a time otherwise.
 */
const STEPS_BODY_LIMIT = 8 * 1024 * 1024;

const Params = z.object({ id: z.string().uuid() });
const Since = z.object({ epoch: z.string().min(1).max(64), version: z.coerce.number().int().nonnegative() });
const Steps = z.object({
  epoch: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  clientID: z.string().min(1).max(200),
  token: z.string().max(100).optional(),
  steps: z.array(z.record(z.unknown())),
  /** Also write the page back now and answer with its stored revision. */
  flush: z.boolean().optional(),
});

async function answer(reply: FastifyReply, kind: DocKind, work: () => Promise<unknown>) {
  try {
    const result = await work();
    if (result === null || result === undefined) return reply.code(404).send({ error: kind === "page" ? "Page not found." : "Task not found." });
    return result;
  } catch (error) {
    if (error instanceof CollabError) return reply.code(STATUS[error.code]).send({ error: error.message, code: error.code, ...(error.batch ?? {}), ...(error.step === undefined ? {} : { step: error.step }) });
    throw error;
  }
}

/**
 * Live co-editing: `GET` joins (`{epoch, version, doc, revision, saved, clientID, token}`; `?stored=1`
 * adds `stored`, the stored copy and the steps typed since; `?start=1` adds `start`, the
 * document as loaded with the authority that wrote it and the steps since), `GET ?epoch&version`
 * returns the steps since, `POST` sends steps. Everyone's steps also go out as `page.steps`
 * events; `saved` is the last version written back.
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
      if (query.version === undefined) {
        const flag = (name: string) => query[name] === "1" || query[name] === "true";
        return answer(reply, kind, async () => {
          const joined = await collabHub.join(key, { stored: flag("stored"), start: flag("start") });
          const clientID = `${accountOf(request)}/${randomUUID().slice(0, 8)}`;
          return joined && { ...joined, clientID, token: tokenFor(clientID) };
        });
      }
      const since = Since.parse(query);
      return answer(reply, kind, () => collabHub.since(key, since.epoch, since.version));
    });

    app.post(path, { bodyLimit: STEPS_BODY_LIMIT }, async (request, reply) => {
      const key: DocKey = { space: request.userId, kind, id: Params.parse(request.params).id };
      const { token, ...body } = Steps.parse(request.body);
      // Another account's id (a session that expired on a public link) or no valid token: join again.
      const trusted = body.clientID.startsWith(`${accountOf(request)}/`) && token === tokenFor(body.clientID);
      return answer(reply, kind, () => collabHub.post(key, { ...body, trusted, editorAccountId: accountOf(request) }));
    });
  }
}
