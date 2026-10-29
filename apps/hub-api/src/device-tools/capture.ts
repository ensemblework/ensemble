/**
 * A node's browser and capture tools on this computer (protocol 7, docs/25 §4.10 and §10): the same
 * tool layer a coding agent's run uses, for the node's tool operation (`node:<nodeId>:<mission>`: one
 * per node and mission or conversation, so its tabs and apps last across its turns, each use renewing
 * their leases). What the tools write lands in that operation's evidence folder and is the node's
 * evidence at once (evidence/captures.ts): sent to the web under the call's upload id, or kept here
 * (upload off) or held for the owner's preview, with only its description sent.
 *
 * Whether a call runs is the policy's (device-tools/policy.ts), like the node's other tools: opening
 * or capturing a page asks once per address (`browse`), starting an app once per folder (`run`, in
 * the OS sandbox, capture/sandbox.ts); calls on the operation's own tabs, apps and files do not ask.
 */
import { mkdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { browserBroker, runningBroker } from "../browser/index.js";
import { checkUrl } from "../browser/broker.js";
import { isBrowserTool, runBrowserTool } from "../browser/tools.js";
import { captureService } from "../capture/index.js";
import { isCaptureTool, runCaptureTool } from "../capture/tools.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { PROTOCOL, type NodeCaptureAnswer, type NodeToolRequest } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { capturedFiles, finishedFiles, recordCaptures } from "../evidence/captures.js";
import { operationEvidenceDir } from "../evidence/files.js";
import { evidencePayload } from "../evidence/upload.js";
import type { PolicyInput } from "./policy.js";
import { resolveToolFolder, type ToolFolder } from "./folders.js";

export type CaptureRequest = Extract<NodeToolRequest, { tool: "browser" | "capture" }>;

/** The tools that take a page address: opening or capturing it asks once per address. */
const URL_TOOLS = new Set(["browser_open", "capture_screenshot", "capture_video", "capture_check"]);

/**
 * What a call acts on, for the policy: a page's origin, the folder an app starts in, or nothing
 * (the operation's own tabs, apps and files). Throws for an address or folder the floor refuses.
 */
export async function captureScope(request: CaptureRequest): Promise<{ folder: ToolFolder | null; input: Omit<PolicyInput, "mission" | "attended" | "grants"> } | null> {
  const url = typeof request.input.url === "string" && URL_TOOLS.has(request.name) ? request.input.url : null;
  if (url) {
    const origin = new URL(checkUrl(url)).origin;
    return { folder: null, input: { capability: "browse", target: origin, label: origin, scope: "origin" } };
  }
  if (request.name === "capture_app_start") {
    const folder = await resolveToolFolder(String(request.input.cwd ?? ""));
    return { folder, input: { capability: "run", target: folder.path, label: folder.label, scope: "folder" } };
  }
  return null;
}

/** Runs one browser or capture call for the node's operation, keeps what it wrote, and answers. */
export async function runNodeCapture(app: Pick<FastifyInstance, "prisma">, client: HostedClient, request: CaptureRequest, folder: ToolFolder | null): Promise<NodeCaptureAnswer> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const operation = request.operation;
  const evidenceDir = operationEvidenceDir(operation);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const input = folder && request.name === "capture_app_start" ? { ...request.input, cwd: folder.path } : request.input;
  // The node's run profile with the internet off: its browser opens only this computer's own addresses.
  const loopbackOnly = !request.network;
  const result = isBrowserTool(request.name)
    ? await runBrowserTool(browserBroker(), request.name, input, { operation, evidenceDir, loopbackOnly })
    : isCaptureTool(request.name)
      ? await runCaptureTool(await captureService(), request.name, input, { operation, evidenceDir, network: request.network, loopbackOnly })
      : { ok: false as const, error: { code: "bad_input", message: `Unknown tool ${request.name}.` } };
  const files = [...(result.ok ? capturedFiles(result.result) : []), ...finishedFiles(runningBroker()?.takeFinished(operation) ?? [])];
  const secrets = await savedSecretValues(app.prisma, userId).catch(() => [] as string[]);
  const recorded = files.length ? await recordCaptures(app.prisma, { userId, nodeId: request.nodeId, operation }, files, secrets) : { rows: [], refused: [] };
  const upload = loadSettings().evidenceUpload;
  const evidence: NodeCaptureAnswer["evidence"] = [];
  for (const row of recorded.rows) {
    const payload = await evidencePayload(row, { upload, protocol: PROTOCOL, secrets });
    const sent = client.uploadEvidenceFile ? await client.uploadEvidenceFile(request.uploadId, payload.meta, payload.bytes).catch(() => null) : null;
    if (sent?.result !== "stored") {
      recorded.refused.push({ name: row.name, reason: sent?.error ?? "The web did not take it." });
      continue;
    }
    evidence.push({ id: row.id, name: row.name, kind: row.kind, held: row.held, holdReason: row.holdReason, local: payload.meta.local, variantOf: row.variantOf });
  }
  await appendLedger({ userId, actor: "agent", action: `node.tool.${request.tool}`, payload: { nodeId: request.nodeId, name: request.name, operation, files: evidence.length, ...(request.operationId ? { operationId: request.operationId } : {}) } }).catch(() => undefined);
  if (!result.ok) return { ok: false, error: { code: result.error.code.slice(0, 40), message: result.error.message.slice(0, 2000) }, evidence, refused: recorded.refused };
  return { ok: true, summary: result.summary, result: result.result, evidence, refused: recorded.refused };
}
