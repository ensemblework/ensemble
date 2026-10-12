/**
 * A coding agent's hook asking about one tool call in an engine run (Claude
 * Code started by Ensemble). Authenticated by that run's own secret, not a
 * person's token, so it lives outside the workspace module gate. The request
 * stays open until the run's rules or the person on Needs me decide.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { CHAT_TOOLS, runChatTool } from "../workspace/engines/chat-tools.js";
import { engineRunFor, judge } from "../workspace/engines/registry.js";
import { isChatTurn } from "../workspace/trust.js";

export async function engineRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/engine/ask", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).send({ decision: "deny", message: "Engine runs are local." });
    const header = request.headers["x-ensemble-run"];
    const run = engineRunFor(Array.isArray(header) ? header[0] : header);
    if (!run) return reply.code(401).send({ decision: "deny", message: "This run has ended." });
    const body = z.object({ tool_name: z.string().max(200).default(""), tool_input: z.record(z.string(), z.unknown()).default({}) }).passthrough().parse(request.body);
    try {
      return await judge(run, { tool: body.tool_name, input: body.tool_input });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { decision: "deny", message: "The run was stopped." };
      request.log.error({ err: error }, "engine call could not be judged");
      return { decision: "deny", message: "Ensemble could not check this call, so it was not run." };
    }
  });

  // The person's board for their own agent in Chat: the same run secret, chat turns only.
  app.post("/api/engine/tool", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) return reply.code(403).send({ error: "Engine runs are local." });
    const header = request.headers["x-ensemble-run"];
    const run = engineRunFor(Array.isArray(header) ? header[0] : header);
    if (!run) return reply.code(401).send({ error: "This run has ended." });
    if (!isChatTurn(run.ctx.job.context)) return reply.code(403).send({ error: "Ensemble's board tools are for Chat." });
    const body = z.object({ name: z.enum(CHAT_TOOLS), input: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    try {
      return { text: await runChatTool(run.ctx, body.name, body.input) };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      request.log.error({ err: error }, "chat tool failed");
      return reply.code(500).send({ error: error instanceof Error ? error.message : "The tool failed." });
    }
  });
}
