/**
 * The interaction log (docs/07 §1.3): what people do in the Hub, kept for the operator's own analysis
 * of how Ensemble is used. The web sends batches of events to POST /api/telemetry; nothing here is
 * content. A route keeps only its known shape (ids become `:id`, anything else is dropped), actions
 * and prop names must be short identifiers, and prop values are numbers, booleans or short words.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { accountIdOf } from "../lib/auth.js";

export const MAX_BATCH = 50;
/** One screen counted at most this long per event; a tab left open overnight is not "use". */
export const MAX_VIEW_MS = 30 * 60_000;
const MAX_PROPS = 12;
/** Events the browser held too long are dropped rather than back-dated. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_SKEW_MS = 5 * 60_000;
export const DEFAULT_RETENTION_DAYS = 730;

/** First path segment → the area of the Hub it belongs to. */
const SURFACES: Record<string, string> = {
  "": "home",
  today: "today",
  start: "today",
  welcome: "onboarding",
  "morning-brief": "brief",
  recap: "brief",
  board: "board",
  tasks: "tasks",
  completed: "tasks",
  "needs-me": "needs-me",
  projects: "projects",
  pages: "pages",
  meetings: "meetings",
  files: "files",
  plots: "plots",
  diagrams: "diagrams",
  context: "context",
  connect: "connections",
  code: "code",
  workspace: "workspace",
  runs: "runs",
  skills: "skills",
  metrics: "metrics",
  marketplace: "marketplace",
  settings: "settings",
  spaces: "spaces",
  shared: "sharing",
  "shared-by-me": "sharing",
  trash: "trash",
};
/** Second segments that are part of the screen, not an id. */
const FIXED_CHILDREN = new Set(["review", "new"]);

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;
const WORD = /^[A-Za-z0-9_.:-]{0,40}$/;

/** `/pages/5f1c…?x=1#y` → `{ route: "/pages/:id", surface: "pages" }`. Unknown screens keep only their area. */
export function routeShape(path: string): { route: string; surface: string } {
  const clean = path.split(/[?#]/, 1)[0] ?? "";
  const parts = clean.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const surface = SURFACES[head];
  if (surface === undefined) return { route: "/:other", surface: "other" };
  const route = parts.slice(0, 3).map((part, index) => (index === 0 ? part : FIXED_CHILDREN.has(part) ? part : ID.test(part) ? ":id" : null));
  return { route: `/${route.filter((part) => part !== null).join("/")}`, surface };
}

/** Only short named values: numbers, booleans and identifier-like words. Others are dropped. */
export function cleanProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (Object.keys(out).length >= MAX_PROPS || !NAME.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && WORD.test(value)) out[key] = value;
  }
  return out;
}

const Event = z.object({
  kind: z.enum(["view", "action", "session"]),
  path: z.string().max(2000),
  action: z.string().regex(NAME).optional(),
  at: z.number().int().positive(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
  props: z.record(z.unknown()).optional(),
});
export const TelemetryBatch = z.object({
  sessionKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  client: z.enum(["web", "desktop"]).default("web"),
  viewport: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  events: z.array(Event).max(MAX_BATCH),
});

export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.ENSEMBLE_INTERACTION_RETENTION_DAYS);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

/** Deletes events older than the retention window. Returns how many. */
export async function purgeInteractionEvents(db: PrismaClient, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - retentionDays() * 86_400_000);
  return (await db.interactionEvent.deleteMany({ where: { at: { lt: cutoff } } })).count;
}

export function rowsFor(userId: string, body: z.infer<typeof TelemetryBatch>, now = Date.now()): Prisma.InteractionEventCreateManyInput[] {
  const rows: Prisma.InteractionEventCreateManyInput[] = [];
  for (const event of body.events) {
    if (event.at < now - MAX_AGE_MS || event.at > now + MAX_SKEW_MS) continue;
    if (event.kind === "action" && !event.action) continue;
    const { route, surface } = routeShape(event.path);
    rows.push({
      userId,
      sessionKey: body.sessionKey,
      at: new Date(event.at),
      kind: event.kind,
      surface,
      route,
      action: event.kind === "action" ? event.action! : null,
      durationMs: event.kind === "view" ? Math.min(event.durationMs ?? 0, MAX_VIEW_MS) : null,
      props: cleanProps(event.props),
      client: body.client,
      viewport: body.viewport ?? null,
    });
  }
  return rows;
}

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/telemetry", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    // Only a person signed in to the Hub: no API tokens, no visitors on a shared item or link.
    if (request.authVia !== "session" || request.access?.kind === "share" || request.access?.kind === "link") return reply.code(204).send();
    const parsed = TelemetryBatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "That is not a telemetry batch." });
    const rows = rowsFor(accountIdOf(request), parsed.data);
    if (rows.length) await app.prisma.interactionEvent.createMany({ data: rows });
    return reply.code(204).send();
  });
}
