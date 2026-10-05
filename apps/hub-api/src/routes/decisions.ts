import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { publicApiUrl } from "../connectors/oauth.js";
import { publishDevice } from "../devices/publish.js";
import { decisionBus, expireStale, matchingRule, normalize, publicDecision, waitFor, type Source } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { resolveWorkFolder, within, workspaceRoot } from "../workspace/guard.js";
import { OUTSIDE_TOOL, RUN_RULE_SOURCE } from "../workspace/tools.js";
import { PATH_RULE_SOURCE, PATH_RULE_TOOL } from "../workspace/trust.js";

const HOOK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/ensemble-hook.mjs");

const Decide = z.object({
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "session", "always"]).default("once"),
  reason: z.string().max(500).optional(),
});

/**
 * The one way a Needs me card is answered, from the Mac or from a phone answer
 * the Mac has already accepted. First pending card to leave `pending` wins.
 */
export async function applyAnswer(
  app: FastifyInstance,
  userId: string,
  id: string,
  body: z.infer<typeof Decide>,
  actor: "me" | "system",
) {
  const { prisma } = app;
  const row = await prisma.agentDecision.findFirst({ where: { id, userId } });
  if (!row) throw new AnswerError(404, "Decision not found.");
  if (row.status !== "pending") {
    throw new AnswerError(409, row.status === "expired" ? "The tool stopped waiting. It showed its own prompt instead." : "Already answered.");
  }
  const detail = (row.detail ?? {}) as { deviceId?: unknown; command?: string | null; tier?: unknown; deviceName?: unknown; options?: unknown };
  const deviceId = typeof detail.deviceId === "string" && detail.deviceId.length > 0 ? detail.deviceId : null;
  let scope = body.scope;
  let reason = body.reason;
  if (deviceId) {
    if (detail.tier === "run_branch_push") {
      const name = typeof detail.deviceName === "string" && detail.deviceName.trim() ? detail.deviceName.trim() : "your computer";
      throw new AnswerError(403, `Approve this on ${name}.`);
    }
    if (body.scope !== "once") throw new AnswerError(400, "A phone answer is once only. Change trust on your computer.");
    const offered = offeredOptions(detail.options);
    const picked = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : null;
    if (row.event !== "question" && picked) throw new AnswerError(400, "A permission answer cannot include a note.");
    if (picked !== null && !offered.includes(picked)) throw new AnswerError(400, "Pick one of the offered answers.");
    if (body.decision === "allow" && offered.length > 0 && picked === null) throw new AnswerError(400, "Pick one of the offered answers.");
    scope = "once";
    reason = picked ?? undefined;
  } else if (row.source === "ensemble") {
    await saveEnsembleAnswer(app, userId, row, body);
  }
  const updated = await prisma.agentDecision.update({
    where: { id },
    data: { status: "decided", decision: body.decision, scope, reason: deviceId ? (reason ?? null) : body.reason, decidedAt: new Date() },
  });
  if (!deviceId && body.scope !== "once" && row.source !== "ensemble") {
    const command = (row.detail as { command?: string | null }).command ?? null;
    await prisma.decisionRule.create({
      data: {
        userId,
        source: row.source,
        toolName: row.toolName,
        pattern: command ?? "*",
        decision: body.decision,
        sessionId: body.scope === "session" ? row.sessionId : null,
      },
    });
  }
  decisionBus.emit(id);
  if (deviceId) {
    publishDevice(deviceId, "decision.answered", id, { decision: body.decision, scope, reason: updated.reason });
  }
  await appendLedger({
    userId,
    actor,
    action: `decision.${body.decision}`,
    payload: { source: row.source, tool: row.toolName, title: row.title, scope, via: actor === "system" ? "remote" : "mac" },
  });
  sseHub.publish(userId, { event: "decision", data: publicDecision(updated) });
  return updated;
}

const Ask = z.object({
  source: z.enum(["cursor", "claude", "copilot", "codex", "other"]),
  event: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
  /** How long the hook will hold the tool call open. */
  waitSeconds: z.number().int().min(5).max(3600).default(600),
});

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  /** Called by the hook script. Answers at once when a rule matches; otherwise opens a card. */
  app.post("/api/decisions", async (request, reply) => {
    const body = Ask.parse(request.body);
    const call = normalize(body.source as Source, body.event, body.payload);
    const rule = await matchingRule(request.userId, call);
    if (rule) {
      await appendLedger({
        userId: request.userId,
        actor: "system",
        action: `decision.rule.${rule.decision}`,
        payload: { source: call.source, tool: call.toolName, command: call.command, rule: rule.id },
      });
      return { id: null, status: "decided", decision: rule.decision, reason: `Matched your "${rule.sessionId ? "this session" : "always"}" rule.` };
    }
    const row = await prisma.agentDecision.create({
      data: {
        userId: request.userId,
        source: call.source,
        event: call.event,
        toolName: call.toolName,
        title: call.title,
        detail: { ...call.detail, command: call.command } as never,
        sessionId: call.sessionId,
        cwd: call.cwd,
        expiresAt: new Date(Date.now() + body.waitSeconds * 1000),
      },
    });
    await prisma.notification.create({
      data: { userId: request.userId, kind: "decision", title: `${label(call.source)} is waiting: ${call.title}`, body: call.cwd ?? "", urgent: true, url: "/needs-me" },
    });
    sseHub.publish(request.userId, { event: "decision", data: publicDecision(row) });
    return reply.code(202).send({ id: row.id, status: "pending" });
  });

  /** Long poll. The hook calls this until the status leaves pending or it gives up. */
  app.get("/api/decisions/:id/wait", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { timeout } = z.object({ timeout: z.coerce.number().int().min(1).max(55).default(25) }).parse(request.query);
    const owned = await prisma.agentDecision.findFirst({ where: { id, userId: request.userId }, select: { id: true } });
    if (!owned) return reply.code(404).send({ error: "Decision not found." });
    const row = await waitFor(id, timeout * 1000);
    if (row && row.status === "pending" && row.expiresAt < new Date()) {
      const expired = await prisma.agentDecision.update({ where: { id }, data: { status: "expired" } });
      return publicDecision(expired);
    }
    return publicDecision(row!);
  });

  /** The hook gave up (its own timeout, or the editor cancelled the tool call). */
  app.post("/api/decisions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.agentDecision.updateMany({ where: { id, userId: request.userId, status: "pending" }, data: { status: "expired" } });
    sseHub.publish(request.userId, { event: "decision", data: { id, status: "expired" } });
    return reply.code(204).send();
  });

  app.get("/api/decisions", async (request) => {
    const { status } = z.object({ status: z.enum(["pending", "recent"]).default("pending") }).parse(request.query);
    await expireStale(request.userId);
    const rows = await prisma.agentDecision.findMany({
      where: {
        userId: request.userId,
        ...(status === "pending" ? { status: "pending" } : { requestedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }),
      },
      orderBy: { requestedAt: status === "pending" ? "asc" : "desc" },
      take: 100,
    });
    return { decisions: rows.map(publicDecision) };
  });

  app.post("/api/decisions/:id/decide", async (request) => {
    const { id } = request.params as { id: string };
    const body = Decide.parse(request.body);
    const updated = await applyAnswer(app, request.userId, id, body, "me");
    return { decision: publicDecision(updated) };
  });

  /** What the Settings page needs to show a copy-paste install command. */
  app.get("/api/editors/setup", async () => ({
    node: process.execPath,
    script: HOOK_SCRIPT,
    apiUrl: publicApiUrl(),
  }));

  app.get("/api/decision-rules", async (request) => ({
    rules: await prisma.decisionRule.findMany({ where: { userId: request.userId }, orderBy: { createdAt: "desc" } }),
  }));

  app.delete("/api/decision-rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.decisionRule.deleteMany({ where: { id, userId: request.userId } });
    return reply.code(204).send();
  });
}

class AnswerError extends Error {
  readonly expose = true;
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AnswerError";
    this.statusCode = statusCode;
  }
}

/**
 * A Ensemble job's answer. "For this run" is a rule only this job reads.
 * "Always" trusts the job's folder, and only a folder `resolveWorkFolder`
 * accepts; it never turns a command or a path into a folder rule. A push and
 * a path outside the folder are confirmed each time.
 */
async function saveEnsembleAnswer(
  app: FastifyInstance,
  userId: string,
  row: { toolName: string; sessionId: string | null; cwd: string | null; event: string; detail: unknown },
  body: { decision: "allow" | "deny"; scope: "once" | "session" | "always" },
): Promise<void> {
  if (row.event === "question" || body.scope === "once") return;
  if (row.toolName === "git push") throw new AnswerError(400, "A push is confirmed each time. Choose Allow once.");
  if (row.toolName === OUTSIDE_TOOL && body.scope === "always") {
    throw new AnswerError(400, "A path outside the folder can be allowed once or for this run, not always.");
  }
  const command = (row.detail as { command?: string | null }).command ?? "*";
  if (body.scope === "session" || body.decision === "deny") {
    if (!row.sessionId) throw new AnswerError(400, "This request did not come from a run.");
    await app.prisma.decisionRule.create({
      data: { userId, source: RUN_RULE_SOURCE, toolName: row.toolName, pattern: command, decision: body.decision, sessionId: row.sessionId },
    });
    return;
  }
  if (!row.cwd) throw new AnswerError(400, "This request has no folder to trust.");
  const base = await workspaceRoot();
  const folder = within(base, row.cwd) ? row.cwd : await resolveWorkFolder(row.cwd);
  const existing = await app.prisma.decisionRule.findFirst({
    where: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: folder, decision: "allow", sessionId: null },
  });
  if (!existing) {
    await app.prisma.decisionRule.create({
      data: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: folder, decision: "allow", sessionId: null },
    });
  }
}

/** Strings the computer offered. A device answer has to be one of these, exactly. */
function offeredOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function label(source: string): string {
  return { cursor: "Cursor", claude: "Claude Code", copilot: "VS Code Copilot", codex: "Codex" }[source] ?? "An agent";
}
