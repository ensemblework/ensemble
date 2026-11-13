/**
 * A coding agent's hook asking about one tool call in an engine run (Claude
 * Code started by Ensemble). Authenticated by that run's own secret, not a
 * person's token, so it lives outside the workspace module gate. The request
 * stays open until the run's rules or the person on Needs me decide.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { bridgeFor, callThroughBridge } from "../subscriptions/bridge.js";
import { CHAT_TOOLS, runChatTool } from "../workspace/engines/chat-tools.js";
import { RUN_TOOLS, RunToolError, runRunTool } from "../evidence/run-tools.js";
import { CREDENTIAL_TOOLS, runCredentialTool } from "../credentials/run-tools.js";
import { SecretUseError } from "../credentials/secret-http.js";
import { gitCredentialAnswer } from "../credentials/git-credential.js";
import { engineRunFor, judge } from "../workspace/engines/registry.js";
import { hookCall, judgeFloor } from "../workspace/engines/judge.js";
import { isChatTurn } from "../workspace/trust.js";
import { CONTEXT_TOOLS, isContextTool, isRunActionTool, RUN_ACTION_TOOLS, runContextTool, runRunAction } from "../workspace/context-tools.js";
import { GraphError } from "../context/graph/neighbors.js";

export async function engineRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/engine/ask", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).send({ decision: "deny", message: "Engine runs are local." });
    const header = request.headers["x-ensemble-run"];
    const run = engineRunFor(Array.isArray(header) ? header[0] : header);
    if (!run) return reply.code(401).send({ decision: "deny", message: "This run has ended." });
    const body = z.object({ tool_name: z.string().max(200).default(""), tool_input: z.record(z.string(), z.unknown()).default({}) }).passthrough().parse(request.body);
    // The agent's ask tool hangs up when the agent stops waiting (its call timed out or was cancelled).
    const gone = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    try {
      return await judge(run, { tool: body.tool_name, input: body.tool_input, signal: gone.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { decision: "deny", message: "The run was stopped." };
      request.log.error({ err: error }, "engine call could not be judged");
      return { decision: "deny", message: "Ensemble could not check this call, so it was not run." };
    }
  });

  // An assistant turn on the person's own subscription (subscriptions/agents.ts): its tools, by the turn's own secret.
  const turnBridge = (request: { ip: string; headers: Record<string, string | string[] | undefined> }) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return { ok: false as const, status: 403, error: "Assistant turns are local." };
    const header = request.headers["x-ensemble-turn"];
    const bridge = bridgeFor(Array.isArray(header) ? header[0] : header);
    return bridge ? { ok: true as const, bridge } : { ok: false as const, status: 401, error: "This turn has ended." };
  };
  app.get("/api/engine/assistant/tools", async (request, reply) => {
    const found = turnBridge(request);
    if (!found.ok) return reply.code(found.status).send({ error: found.error });
    return { tools: found.bridge.tools };
  });
  // The agent's own tool calls in such a turn (its hook: scripts/ensemble-hook.mjs --chat): the hard floor, nothing else.
  app.post("/api/engine/assistant/ask", async (request, reply) => {
    const found = turnBridge(request);
    if (!found.ok) return reply.code(found.status).send({ decision: "deny", message: found.error });
    if (!found.bridge.folder) return { decision: "deny", message: "This turn's agent has only Ensemble's tools." };
    const body = z.object({ tool_name: z.string().max(200).default(""), tool_input: z.record(z.string(), z.unknown()).default({}) }).passthrough().parse(request.body);
    try {
      const verdict = await judgeFloor(found.bridge.folder, hookCall(body.tool_name, body.tool_input));
      // Calls that ran are logged with their output by the turn's driver; a refusal is logged here.
      if (verdict.decision !== "allow") found.bridge.log({ kind: "agent.tool", name: body.tool_name, input: body.tool_input, ok: false, output: verdict.message ?? "Refused.", meta: { refused: true } });
      return verdict;
    } catch (error) {
      request.log.error({ err: error }, "assistant turn tool call could not be judged");
      return { decision: "deny", message: "Ensemble could not check this call, so it was not run." };
    }
  });
  app.post("/api/engine/assistant/tool", async (request, reply) => {
    const found = turnBridge(request);
    if (!found.ok) return reply.code(found.status).send({ text: found.error, isError: true });
    const body = z.object({ name: z.string().min(1).max(200), input: z.unknown().default({}) }).parse(request.body);
    try {
      return await callThroughBridge(found.bridge, body.name, body.input);
    } catch (error) {
      request.log.warn({ err: error }, "assistant tool call failed");
      return { text: error instanceof Error ? error.message : "The tool failed.", isError: true };
    }
  });

  // The browser and capture tools a task run's MCP server offers (evidence/capture-tools.ts): listed by this computer.
  app.get("/api/engine/tools", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).send({ error: "Engine runs are local." });
    const header = request.headers["x-ensemble-run"];
    const run = engineRunFor(Array.isArray(header) ? header[0] : header);
    if (!run) return reply.code(401).send({ error: "This run has ended." });
    if (isChatTurn(run.ctx.job.context)) return { tools: [] };
    const { runCaptureToolList } = await import("../evidence/capture-tools.js");
    return { tools: runCaptureToolList() };
  });

  // The person's board for their own agent in Chat, a task run's report and evidence (evidence/run-tools.ts), and its browser and capture tools: the same run secret.
  app.post("/api/engine/tool", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).send({ error: "Engine runs are local." });
    const header = request.headers["x-ensemble-run"];
    const run = engineRunFor(Array.isArray(header) ? header[0] : header);
    if (!run) return reply.code(401).send({ error: "This run has ended." });
    // Loaded on the computer only: the hosted server never runs a browser.
    const { CAPTURE_RUN_TOOLS, isRunCaptureTool, runRunCaptureTool } = await import("../evidence/capture-tools.js");
    const known = new Set<string>([...CHAT_TOOLS, ...RUN_TOOLS, ...CREDENTIAL_TOOLS, ...CAPTURE_RUN_TOOLS, ...CONTEXT_TOOLS, ...RUN_ACTION_TOOLS]);
    const body = z.object({ name: z.string().refine((name) => known.has(name), "Unknown tool."), input: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const chat = isChatTurn(run.ctx.job.context);
    // The person's records around the task; in Chat, ensemble_search stays the board's own search.
    if (isContextTool(body.name) && (body.name === "ensemble_context" || !chat)) {
      try {
        const space = await app.prisma.user.findUnique({ where: { id: run.ctx.userId }, select: { moduleSet: true } });
        return { text: await runContextTool({ prisma: app.prisma, userId: run.ctx.userId, taskId: run.ctx.taskId, jobContext: run.ctx.job.context, modules: space?.moduleSet ?? null }, body.name, body.input) };
      } catch (error) {
        if (error instanceof GraphError) return reply.code(400).send({ error: error.message });
        request.log.error({ err: error }, "context tool failed");
        return reply.code(500).send({ error: "The context tool failed." });
      }
    }
    // Ensemble actions around the task (bridge/actions.ts): task runs only; Chat has the board's own tools.
    if (isRunActionTool(body.name)) {
      if (chat) return reply.code(403).send({ error: "Ensemble actions are for task runs, not Chat." });
      try {
        const space = await app.prisma.user.findUnique({ where: { id: run.ctx.userId }, select: { moduleSet: true } });
        return { text: await runRunAction({ app, userId: run.ctx.userId, jobContext: run.ctx.job.context, modules: space?.moduleSet ?? null }, body.name, body.input) };
      } catch (error) {
        request.log.error({ err: error }, "Ensemble action failed");
        return reply.code(500).send({ error: "The action failed." });
      }
    }
    // A saved secret used by reference (credentials/secret-http.ts), in task runs and Chat alike.
    if ((CREDENTIAL_TOOLS as readonly string[]).includes(body.name)) {
      try {
        return { text: await runCredentialTool(run.ctx, body.name as (typeof CREDENTIAL_TOOLS)[number], body.input) };
      } catch (error) {
        if (error instanceof SecretUseError) return reply.code(error.statusCode).send({ error: error.message });
        request.log.error({ err: error }, "credential tool failed");
        return reply.code(500).send({ error: "The tool failed." });
      }
    }
    if (isRunCaptureTool(body.name)) {
      if (chat) return reply.code(403).send({ error: "The browser and capture tools are for task runs, not Chat." });
      try {
        const done = await runRunCaptureTool(run.ctx, body.name, body.input);
        return done.ok ? { text: done.text } : reply.code(400).send({ error: done.text });
      } catch (error) {
        request.log.error({ err: error }, "browser or capture tool failed");
        return reply.code(500).send({ error: error instanceof Error ? error.message : "The tool failed." });
      }
    }
    if ((RUN_TOOLS as readonly string[]).includes(body.name)) {
      if (chat) return reply.code(403).send({ error: "report_result and attach_evidence are for task runs, not Chat." });
      try {
        return { text: await runRunTool(run.ctx, body.name as (typeof RUN_TOOLS)[number], body.input) };
      } catch (error) {
        if (error instanceof RunToolError) return reply.code(400).send({ error: error.message });
        request.log.error({ err: error }, "run tool failed");
        return reply.code(500).send({ error: error instanceof Error ? error.message : "The tool failed." });
      }
    }
    if (!chat) return reply.code(403).send({ error: "Ensemble's board tools are for Chat." });
    try {
      return { text: await runChatTool(run.ctx, body.name as (typeof CHAT_TOOLS)[number], body.input) };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      request.log.error({ err: error }, "chat tool failed");
      return reply.code(500).send({ error: error instanceof Error ? error.message : "The tool failed." });
    }
  });

  // git's credential helper in a run that may use a secret by reference (credentials/git-credential.ts):
  // the run's own token, on loopback, on the computer only. The answer is git's format, or empty.
  app.post("/api/engine/git-credential", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).type("text/plain").send("");
    const header = request.headers["x-ensemble-git"];
    const token = Array.isArray(header) ? header[0] : header;
    const body = typeof request.body === "string" ? request.body.slice(0, 4096) : "";
    const answer = await gitCredentialAnswer(app.prisma, token, body, async (jobId) => (await app.prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { status: true } }))?.status ?? null);
    return reply.header("cache-control", "no-store").type("text/plain").send(answer);
  });
}
