/**
 * The live view of a run's browser tab (docs/35 §8.16, design B10): about every 3 seconds the computer
 * sends a small JPEG of the tab its run's agent uses (`ROUTES.liveFrame`, under the job's lease); the
 * server keeps only the latest, in Redis for five minutes, and tells the owner's Node stream
 * (`node.live {jobId, at, paused?}`) so the website can refresh the run card's thumbnail from
 * `GET /api/node/live/:jobId`. The owner only: the account whose computer runs the job. Nothing is
 * stored in the database. A paused view (a sign-in, a site the owner never captures, a secret on
 * screen) keeps no picture, only why.
 */
import type { Device } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { accountIdOf } from "../lib/auth.js";
import { LiveFramePost } from "../remote/contract.js";
import { publishTo } from "../node/events.js";

type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> };
type Held = { ok: false; status: 404 | 409; message: string } | { ok: true; job: { id: string; userId: string; deviceId: string | null }; now: Date };

export type LiveGate = {
  ownDevice: (app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => Promise<Device | null>;
  holdLease: (app: FastifyInstance, device: Device, jobId: string, leaseToken: string) => Promise<Held>;
};

/** How long the latest frame is kept. */
export const LIVE_TTL_SECONDS = 5 * 60;

const frameKey = (jobId: string) => `ensemble:live:${jobId}`;
const paceKey = (jobId: string) => `ensemble:live:pace:${jobId}`;

type Kept = { at: string; tab: string; url: string; title: string; jpeg?: string; width?: number; height?: number; paused?: string };

export async function liveRoutes(app: FastifyInstance, gate: LiveGate): Promise<void> {
  const redis = app.redis as unknown as Redisish;

  app.post("/api/devices/self/jobs/:id/live", { bodyLimit: 400_000 }, async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const frame = LiveFramePost.parse(request.body);
    const held = await gate.holdLease(app, device, id, frame.leaseToken);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    // At most one frame a second per run, whatever a computer sends.
    if ((await redis.set(paceKey(id), "1", "EX", 1, "NX")) !== "OK") return reply.code(202).send({ ok: true, skipped: true });
    const kept: Kept = { at: frame.at, tab: frame.tab, url: frame.url, title: frame.title, ...(frame.paused ? { paused: frame.paused } : { jpeg: frame.jpeg, width: frame.width, height: frame.height }) };
    await redis.set(frameKey(id), JSON.stringify(kept), "EX", LIVE_TTL_SECONDS);
    publishTo([device.userId], "node.live", { jobId: id, at: frame.at, ...(frame.paused ? { paused: frame.paused } : {}) });
    return { ok: true };
  });

  // The latest picture of a run's tab, for the account whose computer runs it; 204 when there is none or the view is paused.
  app.get("/api/node/live/:jobId", async (request, reply) => {
    const accountId = accountIdOf(request);
    if (request.authVia === "link" || (request.tokenScope && request.tokenScope !== "full")) return reply.code(403).send({ error: "Sign in to see this." });
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = await app.prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { deviceId: true, device: { select: { userId: true } } } });
    if (!job?.device || job.device.userId !== accountId) return reply.code(404).send({ error: "That run is not available." });
    const raw = await redis.get(frameKey(jobId));
    const kept = raw ? (JSON.parse(raw) as Kept) : null;
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (kept) reply.header("X-Ensemble-Live-At", kept.at).header("X-Ensemble-Live-Tab", kept.tab).header("X-Ensemble-Live-Url", encodeURIComponent(kept.url)).header("X-Ensemble-Live-Title", encodeURIComponent(kept.title));
    if (!kept?.jpeg) {
      if (kept?.paused) reply.header("X-Ensemble-Live-Paused", kept.paused);
      return reply.code(204).send();
    }
    if (kept.width) reply.header("X-Ensemble-Live-Width", String(kept.width));
    if (kept.height) reply.header("X-Ensemble-Live-Height", String(kept.height));
    return reply.header("Content-Type", "image/jpeg").send(Buffer.from(kept.jpeg, "base64"));
  });
}
