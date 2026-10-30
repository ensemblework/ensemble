/**
 * This computer's side of a node's own tool calls (protocol 6, docs/25 §4.10): a `node.tool.request`
 * from the event stream is resolved against the hard floor, judged by the policy here
 * (device-tools/policy.ts) and run, and the answer goes back like a Code answer. A call that names no
 * folder works in the node's own folder (nodeTools 2). Each call is in the ledger here with its
 * program or action and folder, never its output.
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { GuardError } from "../workspace/guard.js";
import { capabilities } from "../workspace/sandbox/spawn.js";
import type { HostedClient } from "../remote/client.js";
import { NodeToolRequest, type CodeAnswer } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { toolFolderFor, type ToolFolder } from "./folders.js";
import { checkTarget, runNodeHttp } from "./http.js";
import { runNodeFiles } from "./files.js";
import { runNodeGit } from "./git.js";
import { decide, type PolicyInput } from "./policy.js";
import { runNodeCommand } from "./run.js";
import { nodeSecretHttp } from "../credentials/node-tool.js";
import { captureScope, runNodeCapture } from "./capture.js";
import { BrowserError } from "../browser/broker.js";
import { dangerousCommand, dangerousMessage, type DangerousHit } from "./dangerous.js";
import { runNodeTerminal } from "./terminal.js";
import { runNodeSudo, SUDO_WINDOWS } from "./sudo.js";
import { runNodeShare } from "./share.js";

type App = Pick<FastifyInstance, "prisma">;

const userId = () => env.ENSEMBLE_DEV_USER_ID;
const answer = (status: number, body: Record<string, unknown>): CodeAnswer => ({ status, body });

/** This computer's sandbox can be relied on for the hard floor (strong or reduced). */
export function weakSandbox(): boolean {
  const caps = capabilities();
  return !caps.osSandbox || caps.strength === "advisory" || caps.strength === "ask";
}

/** The command a call would start, for the hard floor's list of dangerous commands; null for a call that starts none. */
function floorHit(request: NodeToolRequest): DangerousHit | null {
  if (request.tool === "run" || request.tool === "terminal") return dangerousCommand(request.command);
  if (request.tool === "sudo") return dangerousCommand(request.command, { root: true });
  if (request.tool === "capture" && request.name === "capture_app_start" && typeof request.input.command === "string") return dangerousCommand(request.input.command);
  return null;
}

/**
 * Where the call acts, for the policy: a folder's real path, or a web address's origin (`input` null
 * when the policy has nothing to judge); null for a call on the operation's own tabs, apps and files.
 */
async function scopeOf(request: Exclude<NodeToolRequest, { tool: "secret_http" }>): Promise<{ folder: ToolFolder | null; input: Omit<PolicyInput, "mission" | "attended" | "grants"> | null } | null> {
  if (request.tool === "browser" || request.tool === "capture") return captureScope(request);
  if (request.tool === "http") {
    const { url } = await checkTarget(request.url);
    return { folder: null, input: { capability: "http", target: url.origin, label: url.origin, scope: "origin" } };
  }
  const folder = await toolFolderFor(request);
  // A command as the administrator was approved, with its exact text, on its own card: no folder answer covers it.
  if (request.tool === "sudo") return { folder, input: null };
  const capability = request.tool === "terminal" ? "run" : request.tool === "files" && request.action === "share" ? "read" : request.tool;
  return { folder, input: { capability, target: folder.path, label: folder.label, scope: "folder", own: folder.own } };
}

/**
 * The answer to one call. `send` delivers it: a command that goes on in the background answers before
 * it ends. Resolves when the call is over.
 */
export async function nodeToolAnswerFor(app: App, client: HostedClient, request: NodeToolRequest, send: (reply: CodeAnswer) => Promise<void>): Promise<void> {
  let grantsUsed: string[] = [];
  const reply = (status: number, body: Record<string, unknown>) => send(answer(status, { ...body, ...(grantsUsed.length ? { grantsUsed } : {}) }));
  try {
    // A saved secret used by reference: its allowed destinations are the owner's answer (credentials/node-tool.ts).
    if (request.tool === "secret_http") {
      const done = await nodeSecretHttp(app, request);
      return reply(done.status, done.body);
    }
    // The hard floor's dangerous commands: refused before anything else, whatever anyone answered.
    const hit = floorHit(request);
    if (hit) {
      await appendLedger({ userId: userId(), actor: "agent", action: "node.tool.refused", payload: { nodeId: request.nodeId, tool: request.tool, rule: hit.id } }).catch(() => undefined);
      return reply(403, { error: dangerousMessage(hit) });
    }
    if (request.tool === "sudo" && process.platform === "win32") return reply(409, { error: SUDO_WINDOWS });
    const where = await scopeOf(request);
    if (where?.input) {
      const settings = loadSettings();
      const verdict = await decide(app.prisma, userId(), { ...where.input, mission: request.mission, attended: request.attended, grants: request.grants }, { weak: weakSandbox(), acceptWeb: settings.acceptWebApprovals, askBeforeBrowsing: settings.askBeforeBrowsing || request.askBeforeBrowsing === true });
      if (verdict.kind === "refuse") return reply(verdict.status, { error: verdict.reason });
      grantsUsed = verdict.grantsUsed;
      if (verdict.kind === "ask") {
        await appendLedger({ userId: userId(), actor: "agent", action: "node.tool.ask", payload: { nodeId: request.nodeId, capability: verdict.ask.capability, target: verdict.ask.label } }).catch(() => undefined);
        return reply(428, { ask: verdict.ask });
      }
    }
    if (request.tool === "browser" || request.tool === "capture") return reply(200, (await runNodeCapture(app, client, request, where?.folder ?? null)) as Record<string, unknown>);
    const folder = where?.folder;
    if (!folder) return reply(400, { error: "That request could not be read." });
    if (request.tool === "run") return await runNodeCommand(app, client, request, folder, (out) => reply(out.status, (out.body ?? {}) as Record<string, unknown>));
    if (request.tool === "sudo") return await runNodeSudo(app, client, request, folder, (out) => reply(out.status, (out.body ?? {}) as Record<string, unknown>));
    if (request.tool === "terminal") return reply(200, (await runNodeTerminal(app, client, request, folder)) as Record<string, unknown>);
    if (request.tool === "files" && request.action === "share") {
      if (!request.operation || !request.uploadId) return reply(400, { error: "Sharing a file needs the node's operation and upload id. Update Ensemble on the web." });
      return reply(200, (await runNodeShare(app, client, request, folder)) as Record<string, unknown>);
    }
    const done = request.tool === "git" ? await runNodeGit(request, folder) : request.tool === "files" ? await runNodeFiles(request, folder) : await runNodeHttp(request);
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
