import { installEditorHook } from "../workspace/editor-hooks.js";
/**
 * Handing a task to an agent's own app on this computer, and the agents found here
 * (workspace/handoff.ts). Only the runtime on the person's computer opens apps.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { declareModule } from "../lib/module-gate.js";
import { sseHub } from "../lib/sse.js";
import { GuardError, resolveWorkFolder, within, workspaceRoot } from "../workspace/guard.js";
import { grantedFolderOf } from "../workspace/agent.js";
import { codexBinary } from "../workspace/engines/codex.js";
import { agentPresence, bundledCodex, HANDOFF_APPS, handoffOpen, handoffPrompt, handoffTargets, isCliHandoff, newMarker, openLink, type HandoffApp } from "../workspace/handoff.js";
import { hostExecutable } from "../workspace/policy.js";

/** The tool's own command line on this computer (Codex: the CLI, else the ChatGPT app's copy). */
async function cliProgram(app: Extract<HandoffApp, `${string}-cli`>): Promise<string> {
  const found = app === "codex-cli" ? await codexBinary() : await hostExecutable({ "claude-cli": "claude", "cursor-cli": "cursor-agent", "copilot-cli": "copilot" }[app]).catch(() => null);
  if (!found) throw new GuardError(`${HANDOFF_APPS[app].name} is not on this computer.`);
  return found;
}

const Handoff = z.object({
  taskId: z.string().uuid(),
  app: z.enum(["claude", "codex", "cursor", "vscode", "claude-cli", "codex-cli", "cursor-cli", "copilot-cli"]),
  /** A folder of the person's own. Without one: an earlier task's folder, or a new empty one in the workspace. */
  folder: z.string().max(1000).optional(),
  continueFromJobId: z.string().uuid().optional(),
  instructions: z.string().max(8000).default(""),
});

const local = () => process.env.ENSEMBLE_DESKTOP === "1";

export async function handoffRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  declareModule(app, "workspace");

  app.get("/api/agent/apps", async () => {
    if (!local()) return { available: false, agents: [], targets: [] };
    const agents = await agentPresence();
    return { available: true, agents, targets: handoffTargets(agents, bundledCodex() !== null) };
  });

  app.post("/api/agent/handoff", async (request, reply) => {
    if (!local()) return reply.code(409).send({ error: "Ensemble opens an agent's app on your own computer. Use the desktop app or `ensemble`." });
    const body = Handoff.parse(request.body);
    const task = await prisma.task.findFirst({ where: { id: body.taskId, userId: request.userId, deletedAt: null } });
    if (!task) return reply.code(404).send({ error: "Task not found." });
    const base = await workspaceRoot();
    let folder: string;
    if (body.folder?.trim()) folder = await resolveWorkFolder(body.folder);
    else if (body.continueFromJobId) {
      const previous = await prisma.workspaceJob.findFirst({ where: { id: body.continueFromJobId, userId: request.userId }, select: { externalRoot: true, repoPath: true, continueFromJobId: true } });
      const grant = previous?.externalRoot ?? (previous ? await grantedFolderOf(prisma, previous.continueFromJobId) : null);
      const granted = grant ? await resolveWorkFolder(grant) : null;
      const external = Boolean(granted && (!previous?.repoPath || previous.repoPath === granted));
      const found = external ? granted : previous?.repoPath;
      if (!found) throw new GuardError("That earlier task never got a folder.");
      folder = found;
      if (!external && !within(base, folder)) throw new GuardError("The earlier task's folder is outside the workspace.");
    } else {
      folder = join(base, "runs", `app-${task.id.slice(0, 8)}-${Date.now().toString(36)}`);
      await mkdir(folder, { recursive: true });
    }
    const target = body.app === "copilot-cli" ? "copilot-cli" : body.app.replace(/-cli$/, "");
    await installEditorHook(prisma, request.userId, target, { project: folder });
    const marker = newMarker();
    const prompt = handoffPrompt({ title: task.title, description: task.description, instructions: body.instructions, marker });
    const handoff = await prisma.agentHandoff.create({ data: { userId: request.userId, taskId: task.id, app: body.app, folder, marker } });
    const program = isCliHandoff(body.app) ? await cliProgram(body.app) : "";
    const link = handoffOpen(body.app, folder, prompt, program);
    let opened = true;
    await openLink(link).catch((error: unknown) => {
      opened = false;
      request.log.warn({ err: error, app: body.app }, "could not open the agent's app");
    });
    if (task.owner !== "agent") {
      await prisma.task.update({ where: { id: task.id }, data: { owner: "agent" } });
      await prisma.taskTransition.create({
        data: { userId: request.userId, taskId: task.id, fromStatus: task.status, toStatus: task.status, fromOwner: task.owner, toOwner: "agent", actor: "me", reason: `Opened in ${HANDOFF_APPS[body.app].name}` },
      });
    }
    await appendLedger({ userId: request.userId, actor: "me", action: "task.handoff", taskId: task.id, payload: { app: body.app, folder, handoffId: handoff.id } });
    sseHub.publish(request.userId, { event: "task", data: { id: task.id, action: "handoff" } });
    return reply.code(201).send({ id: handoff.id, marker, folder, opened, url: link.url, prompt });
  });

  app.get("/api/agent/handoffs", async (request) => {
    const query = z.object({ taskId: z.string().uuid().optional() }).parse(request.query);
    const rows = await prisma.agentHandoff.findMany({
      where: { userId: request.userId, ...(query.taskId ? { taskId: query.taskId } : { status: { in: ["open", "finished"] } }) },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { task: { select: { title: true } } },
    });
    return {
      handoffs: rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        taskTitle: row.task.title,
        app: row.app as HandoffApp,
        appName: HANDOFF_APPS[row.app as HandoffApp]?.name ?? row.app,
        folder: row.folder,
        status: row.status,
        linked: row.sessions.length > 0,
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/agent/handoffs/:id/close", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.agentHandoff.updateMany({ where: { id, userId: request.userId }, data: { status: "closed" } });
    if (!result.count) return reply.code(404).send({ error: "Not found." });
    sseHub.publish(request.userId, { event: "workspace", data: { id } });
    return reply.code(204).send();
  });
}
