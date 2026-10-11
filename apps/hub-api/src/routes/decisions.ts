import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireBrowserSession } from "../bridge/auth.js";
import { newApiToken, sha256 } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { publicApiUrl } from "../connectors/oauth.js";
import { publishDevice } from "../devices/publish.js";
import { decisionBus, expireStale, matchingRule, normalize, publicDecision, waitFor, type Source } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { resolveWorkFolder, within, workspaceRoot } from "../workspace/guard.js";
import { OUTSIDE_TOOL, RUN_RULE_SOURCE } from "../workspace/tools.js";
import { PATH_RULE_SOURCE, PATH_RULE_TOOL } from "../workspace/trust.js";
import { trustChanged } from "../workspace/trust-share.js";
import { handoffFor } from "../workspace/handoff.js";
import { loadSettings } from "../lib/settings.js";
import { hookScriptPath } from "../workspace/engines/registry.js";
import { actorFor } from "../sharing/context.js";
import { ownsOpenSpace } from "../lib/auth.js";

// In the repository, or copied into the packaged sidecar (scripts/assemble-desktop-sidecar.mjs).
const HOOK_SCRIPT = hookScriptPath();

const Decide = z.object({
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "session", "always"]).default("once"),
  reason: z.string().max(500).optional(),
  /** The person confirmed a risky allow (a push, a path outside the folder, trusting a folder). */
  confirmed: z.boolean().optional(),
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
    throw new AnswerError(
      409,
      row.status === "expired" ? "The tool stopped waiting. It showed its own prompt instead." : row.status === "settled" ? (row.reason ?? "Already answered in the tool.") : "Already answered.",
    );
  }
  const detail = (row.detail ?? {}) as { deviceId?: unknown; command?: string | null; tier?: unknown; deviceName?: unknown; options?: unknown; runnerAccountId?: unknown; allowCustom?: unknown; confirm?: unknown };
  const deviceId = typeof detail.deviceId === "string" && detail.deviceId.length > 0 ? detail.deviceId : null;
  // In a shared space: a run's question is answered by the person whose computer runs it;
  // anything else (editor hooks, hosted runs) by the space's owner. Others only see it.
  const runner = typeof detail.runnerAccountId === "string" && detail.runnerAccountId ? detail.runnerAccountId : null;
  const me = actorFor(userId);
  if (runner ? me !== runner : me !== null) {
    const who = runner ? await prisma.user.findUnique({ where: { id: runner }, select: { name: true } }) : null;
    const first = who?.name.trim().split(/\s+/)[0];
    throw new AnswerError(403, runner ? `Only ${first || "the person running it"} can answer this. It runs on their computer.` : "Only the space's owner can answer this.");
  }
  let scope = body.scope;
  let reason = body.reason;
  if (deviceId) {
    if ((detail.tier === "run_branch_push" || detail.tier === "high_risk") && actor === "me") {
      // That computer answers this kind only on itself ("Accept approvals from the web" is off there).
      const name = typeof detail.deviceName === "string" && detail.deviceName.trim() ? detail.deviceName.trim() : "your computer";
      throw new AnswerError(403, `Approve this on ${name}.`);
    }
    if (detail.confirm === true && body.decision === "allow" && actor === "me" && body.confirmed !== true) {
      throw new AnswerError(400, "Confirm this before allowing it.");
    }
    if (body.scope !== "once") throw new AnswerError(400, "A phone answer is once only. Change trust on your computer.");
    const offered = offeredOptions(detail.options);
    const picked = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : null;
    if (row.event !== "question" && picked) throw new AnswerError(400, "A permission answer cannot include a note.");
    if (picked !== null && !offered.includes(picked) && !(row.event === "question" && detail.allowCustom === true)) throw new AnswerError(400, "Pick one of the offered answers.");
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
  sseHub.publish(userId, { event: "decision", data: decisionFrame(updated), ownerOnly: updated.source !== "ensemble" });
  return updated;
}

const Ask = z.object({
  source: z.enum(["cursor", "claude", "copilot", "codex", "other"]),
  event: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
  /** How long the hook will hold the tool call open. */
  waitSeconds: z.number().int().min(5).max(3600).default(600),
});

const Activity = z.object({
  source: z.enum(["cursor", "claude", "copilot", "codex", "other"]),
  event: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
});

/** Events after which nothing from that session's earlier turn can still be waiting on the person. */
const SESSION_TURN_EVENTS = new Set(["Stop", "stop", "SessionEnd", "sessionEnd", "UserPromptSubmit", "userPromptSubmitted", "beforeSubmitPrompt"]);

/** A tool call that ran (or failed) is the one a pending card asked about: same tool, same input. */
function sameCall(row: { toolName: string; event: string; detail: unknown }, call: { toolName: string; detail: Record<string, unknown> }): boolean {
  if (row.toolName !== call.toolName) return false;
  // One card per question: the tool ran once all of them were answered.
  if (row.event === "question") return true;
  const asked = (row.detail as { input?: unknown } | null)?.input;
  return JSON.stringify(asked ?? {}) === JSON.stringify(call.detail.input ?? {});
}

/** What the live stream carries: enough for a toast, and who may answer it. */
function decisionFrame(row: { id: string; status: string; title: string; source: string; detail: unknown }) {
  const detail = row.detail && typeof row.detail === "object" ? (row.detail as { runnerAccountId?: unknown }) : {};
  return { id: row.id, status: row.status, title: row.title, source: row.source, runnerAccountId: typeof detail.runnerAccountId === "string" ? detail.runnerAccountId : null };
}

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  /** Called by the hook script. Answers at once when a rule matches; otherwise opens a card. */
  app.post("/api/decisions", async (request, reply) => {
    const body = Ask.parse(request.body);
    const call = normalize(body.source as Source, body.event, body.payload);
    // Only tasks Ensemble opened in the tool, unless the person chose every session in Settings.
    const handoff = await handoffFor(prisma, request.userId, call);
    if (!handoff && (await loadSettings(prisma, request.userId)).orchestration.editorRequests !== "all") {
      return { id: null, status: "skipped", reason: "Not a task Ensemble opened, so the tool asks you itself." };
    }
    if (handoff) call.detail = { ...call.detail, handoffId: handoff.id, taskId: handoff.taskId };
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
    // From the owner's own editors: their commands and folders, never shown to people they share with.
    sseHub.publish(request.userId, { event: "decision", data: decisionFrame(row), ownerOnly: true });
    return reply.code(202).send({ id: row.id, status: "pending" });
  });

  /**
   * What happened in the tool's own session, from its other hooks: the prompt that names a hand-off
   * (links the session), a tool that ran or failed, a turn that ended. A card still pending for a
   * call the person already answered in the tool is closed as answered there, and the hook that
   * was waiting on it lets go.
   */
  app.post("/api/decisions/activity", async (request) => {
    const body = Activity.parse(request.body);
    const call = normalize(body.source as Source, body.event, body.payload);
    const prompt = typeof body.payload.prompt === "string" ? body.payload.prompt : null;
    const handoff = await handoffFor(prisma, request.userId, call, prompt);
    let settled = 0;
    if (call.sessionId) {
      const pending = await prisma.agentDecision.findMany({ where: { userId: request.userId, sessionId: call.sessionId, source: call.source, status: "pending" } });
      const done = SESSION_TURN_EVENTS.has(call.event) ? pending : pending.filter((row) => sameCall(row, call));
      if (done.length) {
        const where = { id: { in: done.map((row) => row.id) }, status: "pending" };
        settled = (await prisma.agentDecision.updateMany({ where, data: { status: "settled", reason: `Answered in ${label(call.source)}.`, decidedAt: new Date() } })).count;
        for (const row of done) {
          decisionBus.emit(row.id);
          sseHub.publish(request.userId, { event: "decision", data: { id: row.id, status: "settled" }, ownerOnly: true });
        }
      }
    }
    if (handoff) {
      const ended = call.event === "Stop" || call.event === "stop" || call.event === "SessionEnd";
      const summary = typeof body.payload.last_assistant_message === "string" ? body.payload.last_assistant_message.slice(0, 4000) : null;
      const status = ended ? "finished" : call.event === "UserPromptSubmit" || call.event === "beforeSubmitPrompt" ? "open" : handoff.status;
      if (status !== handoff.status || summary) {
        await prisma.agentHandoff.update({ where: { id: handoff.id }, data: { status, ...(summary ? { summary } : {}) } });
        sseHub.publish(request.userId, { event: "task", data: { id: handoff.taskId, action: "handoff" } });
      }
    }
    return { linked: Boolean(handoff), settled };
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
    const found = await prisma.agentDecision.findFirst({ where: { id, userId: request.userId }, select: { id: true } });
    if (!found) return reply.code(404).send({ error: "Decision not found." });
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
        // People a space is shared with see its runs' questions, not the owner's own editors.
        ...(ownsOpenSpace(request) ? {} : { source: "ensemble" }),
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
    /** This runtime is on the person's computer, so it can connect a tool itself. */
    local: process.env.ENSEMBLE_DESKTOP === "1",
    connected: process.env.ENSEMBLE_DESKTOP === "1" ? await connectedTargets() : [],
  }));

  /**
   * On the person's computer: installs (or removes) Ensemble's hook in one tool, signed in with a
   * `hooks` key that can only ask, never answer. The key is made once and reused.
   */
  app.post("/api/editors/connect", async (request, reply) => {
    requireBrowserSession(request);
    if (process.env.ENSEMBLE_DESKTOP !== "1") {
      return reply.code(409).send({ error: "Connect a tool from Ensemble on the computer it runs on (the desktop app, or `ensemble` there)." });
    }
    const body = z.object({ target: z.enum(["claude", "codex", "copilot-cli", "cursor"]), remove: z.boolean().default(false) }).parse(request.body);
    const args = [HOOK_SCRIPT, body.remove ? "uninstall" : "install", "--target", body.target];
    if (!body.remove && !(await hookKeyStillValid(request.userId))) {
      const { token, hash, prefix } = newApiToken();
      await prisma.apiToken.create({ data: { userId: request.userId, name: "Agent hooks (this computer)", tokenHash: hash, prefix, scope: "hooks" } });
      await appendLedger({ userId: request.userId, actor: "me", action: "token.create", payload: { name: "Agent hooks", prefix, scope: "hooks" } });
      // The default address lets the hook follow this runtime's port through its discovery file.
      args.push("--token", token, "--url", "http://127.0.0.1:4000");
    }
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
    if (result.status !== 0) return reply.code(500).send({ error: (result.stderr || result.stdout || "Could not change the tool's hooks.").trim() });
    return { ok: true, message: result.stdout.trim(), connected: await connectedTargets() };
  });

  app.get("/api/decision-rules", async (request) => ({
    rules: await prisma.decisionRule.findMany({ where: { userId: request.userId }, orderBy: { createdAt: "desc" } }),
  }));

  app.delete("/api/decision-rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.decisionRule.deleteMany({ where: { id, userId: request.userId } });
    if (!result.count) return reply.code(404).send({ error: "Rule not found." });
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
    trustChanged(app.prisma, app.log);
  }
}

/** The tools whose user-level hook file already runs Ensemble's hook. */
async function connectedTargets(): Promise<string[]> {
  const hooks = (await import(pathToFileURL(HOOK_SCRIPT).href)) as { hookFile: (target: string) => string };
  const found: string[] = [];
  for (const target of ["claude", "codex", "copilot-cli", "cursor"]) {
    const text = await readFile(hooks.hookFile(target), "utf8").catch(() => "");
    if (text.includes("ensemble-hook.mjs")) found.push(target);
  }
  return found;
}

/** The hook's saved key is a live `hooks` key of this person's. */
async function hookKeyStillValid(userId: string): Promise<boolean> {
  const saved = await readFile(join(homedir(), ".ensemble", "hook.json"), "utf8").then((text) => JSON.parse(text) as { token?: unknown }).catch(() => null);
  if (typeof saved?.token !== "string") return false;
  const row = await prisma.apiToken.findFirst({ where: { tokenHash: sha256(saved.token), userId, revokedAt: null } });
  return Boolean(row);
}

/** Strings the computer offered. A device answer has to be one of these, exactly. */
function offeredOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function label(source: string): string {
  return { cursor: "Cursor", claude: "Claude Code", copilot: "VS Code Copilot", codex: "Codex" }[source] ?? "An agent";
}
