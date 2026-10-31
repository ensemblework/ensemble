/**
 * A node's browser and capture tools on this computer (protocol 7, docs/25 §4.10 and §10): the same
 * tool layer a coding agent's run uses, for the node's tool operation (`node:<nodeId>:<mission>`: one
 * per node and mission or conversation, so its tabs and apps last across its turns, each use renewing
 * their leases). What the tools write lands in that operation's evidence folder and is the node's
 * evidence at once (evidence/captures.ts): sent to the web under the call's upload id, or kept here
 * (upload off) or held for the owner's preview, with only its description sent.
 *
 * Whether a call runs is the policy's (device-tools/policy.ts), like the node's other tools: opening
 * or capturing a public page does not ask (unless the owner turned `askBeforeBrowsing` on); this
 * computer's own or its network's addresses ask once per address (`browse`); starting an app asks
 * once per folder (`run`, in the OS sandbox, capture/sandbox.ts), never in the node's own folder;
 * calls on the operation's own tabs, apps and files do not ask.
 */
import { mkdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { browserBroker, runningBroker } from "../browser/index.js";
import { checkUrl } from "../browser/broker.js";
import { isBrowserTool, runBrowserTool } from "../browser/tools.js";
import { genericRecipe, recipeFor } from "../browser/shop/recipes.js";
import { captureService } from "../capture/index.js";
import { isCaptureTool, runCaptureTool } from "../capture/tools.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { PROTOCOL, type NodeCaptureAnswer, type NodeToolRequest } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { capturedFiles, finishedFiles, recordCaptures, type CapturedFile } from "../evidence/captures.js";
import { operationEvidenceDir } from "../evidence/files.js";
import { evidencePayload } from "../evidence/upload.js";
import type { PolicyInput } from "./policy.js";
import { toolFolderFor, type ToolFolder } from "./folders.js";
import { publicWebAddress } from "./http.js";
import type { LoginInfo } from "../logins/requests.js";

export type CaptureRequest = Extract<NodeToolRequest, { tool: "browser" | "capture" }>;

/** The tools that take a page address: opening or capturing it asks once per address. */
const URL_TOOLS = new Set(["browser_open", "browser_view", "browser_fetch", "browser_extract", "capture_screenshot", "capture_video", "capture_check"]);

/** The sites a browser_shop call searches: the known stores' and any shop named by its address. */
function shopOrigins(input: Record<string, unknown>): string[] {
  const stores = Array.isArray(input.stores) ? input.stores.filter((store): store is string => typeof store === "string") : [];
  const origins: string[] = [];
  for (const store of stores) {
    const recipe = recipeFor(store) ?? genericRecipe(store);
    if (recipe && !origins.includes(recipe.origin)) origins.push(recipe.origin);
  }
  return origins;
}

/**
 * What a call acts on, for the policy: a page's origin, the folder an app starts in, or nothing
 * (the operation's own tabs, apps and files). Throws for an address or folder the floor refuses.
 */
export async function captureScope(request: CaptureRequest): Promise<{ folder: ToolFolder | null; input: Omit<PolicyInput, "mission" | "attended" | "grants"> } | null> {
  const url = typeof request.input.url === "string" && URL_TOOLS.has(request.name) ? request.input.url : null;
  if (url) {
    const origin = new URL(checkUrl(url)).origin;
    return { folder: null, input: { capability: "browse", target: origin, label: origin, scope: "origin", publicWeb: await publicWebAddress(origin) } };
  }
  if (request.name === "browser_shop") {
    // The known stores are public sites; a shop named by its address is judged like any page.
    const named = shopOrigins(request.input);
    for (const origin of named) {
      if (!(await publicWebAddress(origin))) return { folder: null, input: { capability: "browse", target: origin, label: origin, scope: "origin", publicWeb: false } };
    }
    return null;
  }
  if (request.name === "capture_app_start") {
    // No cwd: the app starts in the node's own folder.
    const folder = await toolFolderFor({ folder: typeof request.input.cwd === "string" ? request.input.cwd : undefined, nodeId: request.nodeId, nodeSlug: request.nodeSlug });
    return { folder, input: { capability: "run", target: folder.path, label: folder.label, scope: "folder", own: folder.own } };
  }
  return null;
}

/** Who kept files belong to, and where they go. */
type KeepFor = { nodeId: string; operation: string; uploadId: string };

/**
 * Records files a node's tool wrote in its operation's evidence folder as its evidence (each checked
 * where it lies), and sends each to the web under the call's upload id: its bytes, or only its
 * description when upload is off here or it is held for the owner. What was not kept says why.
 */
export async function keepEvidence(app: Pick<FastifyInstance, "prisma">, client: HostedClient, keep: KeepFor, files: readonly CapturedFile[]): Promise<Pick<NodeCaptureAnswer, "evidence" | "refused">> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  if (!files.length) return { evidence: [], refused: [] };
  const secrets = await savedSecretValues(app.prisma, userId).catch(() => [] as string[]);
  const recorded = await recordCaptures(app.prisma, { userId, nodeId: keep.nodeId, operation: keep.operation }, files, secrets);
  const upload = loadSettings().evidenceUpload;
  const evidence: NodeCaptureAnswer["evidence"] = [];
  for (const row of recorded.rows) {
    const payload = await evidencePayload(row, { upload, protocol: PROTOCOL, secrets });
    const sent = client.uploadEvidenceFile ? await client.uploadEvidenceFile(keep.uploadId, payload.meta, payload.bytes).catch(() => null) : null;
    if (sent?.result !== "stored") {
      recorded.refused.push({ name: row.name, reason: sent?.error ?? "The web did not take it." });
      continue;
    }
    evidence.push({ id: row.id, name: row.name, kind: row.kind, held: row.held, holdReason: row.holdReason, local: payload.meta.local, variantOf: row.variantOf });
  }
  return { evidence, refused: recorded.refused };
}

/**
 * browser_shop's result as the web reads it: its files' local paths left out, and each store's
 * screenshot named by its evidence id once kept (by the file's name, which is unique in the folder).
 */
export function withEvidenceIds(result: unknown, evidence: NodeCaptureAnswer["evidence"]): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray((result as { stores?: unknown }).stores)) return result;
  const { files: _files, ...rest } = result as Record<string, unknown> & { stores: unknown[] };
  const idFor = (name: unknown) => (typeof name === "string" ? evidence.find((item) => item.name === name && !item.variantOf)?.id : undefined);
  return {
    ...rest,
    stores: rest.stores.map((store) => {
      if (!store || typeof store !== "object") return store;
      const { screenshot, ...other } = store as Record<string, unknown>;
      const id = idFor(screenshot);
      return id ? { ...other, screenshot: id } : other;
    }),
  };
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
  const { evidence, refused } = await keepEvidence(app, client, { nodeId: request.nodeId, operation, uploadId: request.uploadId }, files);
  await appendLedger({ userId, actor: "agent", action: `node.tool.${request.tool}`, payload: { nodeId: request.nodeId, name: request.name, operation, files: evidence.length, ...(request.operationId ? { operationId: request.operationId } : {}) } }).catch(() => undefined);
  if (!result.ok) return { ok: false, error: { code: result.error.code.slice(0, 40), message: result.error.message.slice(0, 2000) }, evidence, refused };
  // The tab waits for the owner to sign in (B11): the server raises the card and wakes the node when it ends.
  const login = (result.result as { login?: LoginInfo } | undefined)?.login;
  return { ok: true, summary: result.summary, result: withEvidenceIds(result.result, evidence), evidence, refused, ...(login ? { login } : {}) };
}
