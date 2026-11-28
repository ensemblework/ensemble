/**
 * The human-only terminal (docs/16 §5).
 *
 * Who: a person in their own signed-in browser session, on the Hub's own page at localhost. No agent,
 * API key, bridge or device token, desktop token or internal call is a browser session; they are
 * refused before anything else is checked (`humanOnlyRefusal`).
 *
 * What: an allow-list, one argv at a time, run under the same Seatbelt profile as agent commands,
 * confined to the folder the terminal is in: its own roots, or any folder Open a folder accepts
 * (`workspace/terminal-exec.ts`). The ledger records the command, folder and exit code, never the output.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config.js";
import { requireHostTerminal } from "../lib/hosted-access.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { declareModule } from "../lib/module-gate.js";
import { humanOnlyRefusal } from "../lib/terminal-human.js";
import { GuardError, workspaceRoot } from "../workspace/guard.js";
import { killGroup, runCommand } from "../workspace/runner.js";
import { prepareRun, resolveCd, terminalRoots } from "../workspace/terminal-exec.js";

function origins(): string[] {
  const base = env.HUB_WEB_ORIGIN.replace(/\/$/, "");
  return [base, base.replace("127.0.0.1", "localhost")];
}

/** Refuses anything that is not a person in the Hub's own browser tab. */
function humanOnly(request: FastifyRequest): void {
  const refusal = humanOnlyRefusal({ authVia: request.authVia, origin: request.headers.origin, webOrigins: origins() });
  if (refusal) throw new GuardError(refusal);
}

/** The person's commands, so Ctrl+C stops what they started. */
const group = (userId: string) => `term:${userId}`;

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "code");
  app.addHook("preHandler", async (request) => requireHostTerminal(request.userId));
  const { prisma } = app;

  app.get("/api/terminal/status", async (request) => {
    const settings = await loadSettings(prisma, request.userId);
    return { enabled: settings.terminal.enabled, roots: await terminalRoots(prisma, request.userId), home: await workspaceRoot() };
  });

  app.post("/api/terminal/kill", async (request) => {
    humanOnly(request);
    return { killed: killGroup(group(request.userId)) };
  });

  /** Resolves `cd` to a folder the terminal may use (`resolveCd`). */
  app.post("/api/terminal/cd", async (request) => {
    humanOnly(request);
    const body = z.object({ cwd: z.string(), path: z.string().default("") }).parse(request.body);
    return resolveCd(await terminalRoots(prisma, request.userId), body.cwd, body.path);
  });

  app.post("/api/terminal/run", async (request: FastifyRequest, reply: FastifyReply) => {
    humanOnly(request);
    const settings = await loadSettings(prisma, request.userId);
    if (!settings.terminal.enabled) throw new GuardError("The terminal is turned off in Settings.");
    const body = z.object({ cwd: z.string(), line: z.string().min(1).max(4000), confirmed: z.boolean().default(false) }).parse(request.body);
    const prepared = await prepareRun({ allowed: await terminalRoots(prisma, request.userId), cwd: body.cwd, line: body.line, confirmed: body.confirmed });
    if (prepared.kind === "confirm") return reply.code(428).send({ confirm: prepared.message });
    const { argv, full, cwd, scope, sandboxed } = prepared;

    reply.hijack();
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    };
    Object.assign(headers, streamCorsHeaders(request.headers.origin, hubCorsPolicy()));
    reply.raw.writeHead(200, headers);
    let closed = false;
    const controller = new AbortController();
    reply.raw.on("close", () => {
      closed = true;
      controller.abort();
    });
    try {
      const result = await runCommand({
        userId: request.userId,
        argv: full,
        cwd,
        root: scope,
        sandboxed,
        network: true,
        useCredentials: true,
        who: "human",
        timeoutMs: 15 * 60_000,
        signal: controller.signal,
        group: group(request.userId),
        onChunk: (text) => {
          if (!closed) reply.raw.write(text);
        },
      });
      if (!closed) reply.raw.write(`${result.timedOut ? "\n[stopped after 15 minutes]" : ""}\n\u0000${result.exitCode}`);
      await appendLedger({ userId: request.userId, actor: "me", action: "terminal.run", payload: { argv: argv.slice(0, 20), cwd, exitCode: result.exitCode } });
    } catch (error) {
      if (!closed) reply.raw.write(`${error instanceof Error ? error.message : String(error)}\n\u0000127`);
    } finally {
      reply.raw.end();
    }
  });
}
