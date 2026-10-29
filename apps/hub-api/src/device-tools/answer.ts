/**
 * This computer's side of a node's own tool calls (protocol 6, docs/25 §4.10): a `node.tool.request`
 * from the event stream is resolved against the hard floor, judged by the policy here
 * (device-tools/policy.ts) and run, and the answer goes back like a Code answer. Each call is in the
 * ledger here with its program or action and folder, never its output.
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { GuardError } from "../workspace/guard.js";
import { capabilities } from "../workspace/sandbox/spawn.js";
import type { HostedClient } from "../remote/client.js";
import { NodeToolRequest, type CodeAnswer } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { resolveToolFolder, type ToolFolder } from "./folders.js";
import { checkTarget, runNodeHttp } from "./http.js";
import { runNodeFiles } from "./files.js";
import { runNodeGit } from "./git.js";
import { decide, type PolicyInput } from "./policy.js";
import { runNodeCommand } from "./run.js";
import { captureScope, runNodeCapture } from "./capture.js";
import { BrowserError } from "../browser/broker.js";

type App = Pick<FastifyInstance, "prisma">;

const userId = () => env.ENSEMBLE_DEV_USER_ID;
const answer = (status: number, body: Record<string, unknown>): CodeAnswer => ({ status, body });

/** This computer's sandbox can be relied on for the hard floor (strong or reduced). */
export function weakSandbox(): boolean {
  const caps = capabilities();
  return !caps.osSandbox || caps.strength === "advisory" || caps.strength === "ask";
}

/** Where the call acts, for the policy: a folder's real path, or a web address's origin; null for a call on the operation's own tabs, apps and files. */
async function scopeOf(request: NodeToolRequest): Promise<{ folder: ToolFolder | null; input: Omit<PolicyInput, "mission" | "attended" | "grants"> } | null> {
  if (request.tool === "browser" || request.tool === "capture") return captureScope(request);
  if (request.tool === "http") {
    const { url } = await checkTarget(request.url);
    return { folder: null, input: { capability: "http", target: url.origin, label: url.origin, scope: "origin" } };
  }
  const folder = await resolveToolFolder(request.folder);
  return { folder, input: { capability: request.tool, target: folder.path, label: folder.label, scope: "folder" } };
}

/**
 * The answer to one call. `send` delivers it: a command that goes on in the background answers before
 * it ends. Resolves when the call is over.
 */
export async function nodeToolAnswerFor(app: App, client: HostedClient, request: NodeToolRequest, send: (reply: CodeAnswer) => Promise<void>): Promise<void> {
  let grantsUsed: string[] = [];
  const reply = (status: number, body: Record<string, unknown>) => send(answer(status, { ...body, ...(grantsUsed.length ? { grantsUsed } : {}) }));
  try {
    const where = await scopeOf(request);
    if (where) {
      const settings = loadSettings();
      const verdict = await decide(app.prisma, userId(), { ...where.input, mission: request.mission, attended: request.attended, grants: request.grants }, { weak: weakSandbox(), acceptWeb: settings.acceptWebApprovals });
      if (verdict.kind === "refuse") return reply(verdict.status, { error: verdict.reason });
      grantsUsed = verdict.grantsUsed;
      if (verdict.kind === "ask") {
        await appendLedger({ userId: userId(), actor: "agent", action: "node.tool.ask", payload: { nodeId: request.nodeId, capability: verdict.ask.capability, target: verdict.ask.label } }).catch(() => undefined);
        return reply(428, { ask: verdict.ask });
      }
    }
    if (request.tool === "browser" || request.tool === "capture") return reply(200, (await runNodeCapture(app, client, request, where?.folder ?? null)) as Record<string, unknown>);
    if (!where) return reply(400, { error: "That request could not be read." });
    if (request.tool === "run") return await runNodeCommand(app, client, request, where.folder!, (out) => reply(out.status, (out.body ?? {}) as Record<string, unknown>));
    const done = request.tool === "git" ? await runNodeGit(request, where.folder!) : request.tool === "files" ? await runNodeFiles(request, where.folder!) : await runNodeHttp(request);
    return reply(done.status, done.body);
  } catch (error) {
    if (error instanceof GuardError) return reply(403, { error: error.message });
    // An address the browser never opens (not http or https, not a full URL).
    if (error instanceof BrowserError) return reply(400, { error: error.message });
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return reply(404, { error: "That folder or file is not there." });
    return reply(500, { error: error instanceof Error ? error.message.slice(0, 300) : "This computer could not do that." });
  }
}

/** A `node.tool.request` frame from the event stream: answer it once. A frame without an id cannot be answered. */
export async function answerNodeToolRequest(app: App, client: HostedClient, data: unknown): Promise<void> {
  const parsed = NodeToolRequest.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, answer(400, { error: "That request could not be read. Update Ensemble on this computer." }));
    return;
  }
  let sent = false;
  await nodeToolAnswerFor(app, client, parsed.data, async (reply) => {
    if (sent) return;
    sent = true;
    await client.answerCode(parsed.data.id, reply);
  });
}
