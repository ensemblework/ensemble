/**
 * The Mac's calls to Ensemble on the web. Doc 25 §4.1, and only those routes.
 * The device token stays in this process; it is never written to a child environment.
 */
import { EVIDENCE_HEADERS, ROUTES, type CodeAnswer, type EvidenceMeta, type FileAnswer, type Outcome, type ResultLink, type RunTotals, type TerminalChunk, type UploadedFile, type UploadedStep } from "./contract.js";
import { cliApiBase } from "@ensemble/shared-types";
import { hideSecretsDeep } from "../lib/redact.js";

function channelBase(base: string): string {
  const channel = process.env.ENSEMBLE_CLI_CHANNEL;
  if (channel !== "testing" && channel !== "production") return base;
  try { return cliApiBase(base, channel); }
  catch (error) { throw new RemoteError(400, error instanceof Error ? error.message : "This server belongs to another CLI channel."); }
}

export class RemoteError extends Error {
  readonly expose = true;
  readonly statusCode: number;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
    this.statusCode = status || 502;
  }
}

export function remoteApiBase(): string | null {
  const fromEnv = process.env.ENSEMBLE_REMOTE_API?.trim();
  return fromEnv ? channelBase(fromEnv.replace(/\/+$/, "")) : null;
}

/** A base the person typed, or the ENSEMBLE_REMOTE_API override. http(s) only. */
export function checkApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RemoteError(400, "Give the address of Ensemble on the web, starting with https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RemoteError(400, "The address has to start with https://.");
  if (url.username || url.password) throw new RemoteError(400, "The address cannot contain a password.");
  return channelBase(url.origin + url.pathname.replace(/\/+$/, ""));
}

export interface HostedClient {
  unpairSelf(): Promise<void>;
  heartbeat(body: { runningJobIds: string[]; appVersion: string; capabilities: unknown }): Promise<{ cancel: string[] }>;
  claim(): Promise<{ status: number; body: unknown }>;
  progress(jobId: string, leaseToken: string, body: { status?: string; progress: string; events: unknown[]; logs?: { seqFrom: number; seqTo: number; text: string }; steps?: UploadedStep[] }): Promise<void>;
  ask(jobId: string, leaseToken: string, body: Record<string, unknown>): Promise<{ decisionId: string }>;
  decision(decisionId: string, timeoutSeconds: number, signal: AbortSignal): Promise<unknown>;
  /** Answered here: the card on the web closes with the same answer. Older servers answer 404. */
  closeDecision(decisionId: string, body: { decision: "allow" | "deny" | "expired"; reason: string | null }): Promise<void>;
  complete(jobId: string, leaseToken: string, body: { outcome: Outcome; summary: string; results: ResultLink[]; totals?: RunTotals; report?: unknown }): Promise<void>;
  /**
   * One file the run's worker attached (protocol 6), its bytes as the body, before complete. "stored" or
   * "refused" (the server said no to this file: not sent again); "unsupported" for a server without the route.
   */
  uploadEvidence?(jobId: string, leaseToken: string, meta: EvidenceMeta, bytes: Uint8Array): Promise<{ result: "stored" | "refused" | "unsupported"; error?: string }>;
  /** Protocol 5: a new lease for a run this computer still has after its lease ran out, or why not. */
  reattach?(jobId: string, body: { leaseToken: string; status: "running" | "waiting_approval" | "finished" }): Promise<{ leaseToken: string } | { refused: string }>;
  /** Protocol 5: carry on a run this computer lost by restarting; the new run comes with the next claim. */
  resume?(jobId: string, body: { leaseToken: string; reason: string }): Promise<{ jobId: string } | { refused: string }>;
  downloadAttachment?(jobId: string, leaseToken: string, fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** The text of files the run changed (protocol 3), before complete. */
  uploadFiles(jobId: string, leaseToken: string, files: UploadedFile[]): Promise<void>;
  /** The answer to a `files.request`. */
  answerFiles(requestId: string, answer: FileAnswer): Promise<void>;
  /** The answer to a `code.request` or `terminal.request` (protocol 4). */
  answerCode(requestId: string, answer: CodeAnswer): Promise<void>;
  /** One chunk of a web terminal command's output, in order. False: the web stopped listening. */
  terminalOutput(runId: string, chunk: TerminalChunk): Promise<boolean>;
  events(onFrame: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void>;
  /** An assistant turn the web handed this computer; null when it has already ended. */
  assistantTurn(turnId: string): Promise<unknown | null>;
  /** A file attached to the turn's message, at most `maxBytes`; null when the turn ended or the file is gone. */
  assistantFile(turnId: string, fileId: string, options: { maxBytes: number; signal: AbortSignal }): Promise<Uint8Array | null>;
  assistantTool(turnId: string, body: { name: string; input: unknown }): Promise<unknown>;
  /** Reply text in order. `stop`: the person stopped the turn, or it ended. */
  assistantStream(turnId: string, body: { seq: number; text: string }): Promise<{ stop: boolean }>;
  assistantDone(turnId: string, body: unknown): Promise<void>;
}

async function send(base: string, token: string, method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  channelBase(base);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      // A saved run secret's value never leaves the computer, whatever a run printed (lib/run-secrets.ts).
      body: json === undefined ? undefined : JSON.stringify(hideSecretsDeep(json)),
      signal,
      ...(process.env.ENSEMBLE_CLI_CHANNEL === "testing" ? { redirect: "error" } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RemoteError(0, "Ensemble on the web is not reachable.");
  }
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  // 401: the computer was removed. 403: the caller is not the paired computer.
  // Either one is final; the loop must not wait for the next heartbeat.
  if (response.status === 401 || response.status === 403) throw authError(response.status, body);
  return { status: response.status, body };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
  return fallback;
}

/** A device route refused the token. 401 is removal; 403 is the wrong caller. */
export function authRejected(error: unknown): error is RemoteError {
  return error instanceof RemoteError && (error.status === 401 || error.status === 403);
}

function authError(status: number, body: unknown): RemoteError {
  const fallback = status === 403 ? "Only the paired computer can call this." : "This computer is no longer paired.";
  return new RemoteError(status, messageOf(body, fallback));
}

/** `device.revoked` is the frame the server writes before it closes the stream. */
export function deviceRemovedEvent(event: string): boolean {
  return event === "device.removed" || event === "device.revoked" || event === "revoke" || event === "device.revoke";
}

export type AccountKey = { provider: string; secret: string; hint: string; updatedAt: string };

/** The keys saved on the account, for this computer (docs/26 §4). An older server answers 404: none. */
export async function fetchAccountKeys(base: string, token: string, signal?: AbortSignal): Promise<{ shared: boolean; keys: AccountKey[] }> {
  const res = await send(base, token, "GET", ROUTES.modelKeys, undefined, signal ?? AbortSignal.timeout(8_000));
  if (res.status === 404) return { shared: false, keys: [] };
  if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The account's model keys could not be read."));
  const body = res.body as { shared?: unknown; keys?: unknown } | null;
  const keys = (Array.isArray(body?.keys) ? body.keys : []).flatMap((row) => {
    const item = row as Partial<AccountKey>;
    return typeof item.provider === "string" && typeof item.secret === "string" && item.secret
      ? [{ provider: item.provider, secret: item.secret, hint: typeof item.hint === "string" ? item.hint : "", updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "" }]
      : [];
  });
  return { shared: body?.shared !== false, keys };
}

export function hostedClient(base: string, token: string): HostedClient {
  channelBase(base);
  const call = (method: string, path: string, json?: unknown, signal?: AbortSignal) => send(base, token, method, path, json, signal);
  return {
    async unpairSelf() {
      const res = await call("DELETE", ROUTES.self);
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "Unpair was refused."));
    },
    async heartbeat(body) {
      const res = await call("POST", ROUTES.heartbeat, body);
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The heartbeat was refused."));
      const cancel = (res.body as { cancel?: unknown } | null)?.cancel;
      return { cancel: Array.isArray(cancel) ? cancel.filter((id): id is string => typeof id === "string") : [] };
    },
    claim() {
      return call("POST", ROUTES.claim, {});
    },
    async progress(jobId, leaseToken, body) {
      const res = await call("POST", ROUTES.progress(jobId), { ...body, leaseToken });
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "Progress was refused."));
    },
    async ask(jobId, leaseToken, body) {
      const res = await call("POST", ROUTES.ask(jobId), { ...body, leaseToken });
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The question was refused."));
      const decisionId = (res.body as { decisionId?: unknown } | null)?.decisionId;
      if (typeof decisionId !== "string" || !decisionId) throw new RemoteError(502, "Ensemble on the web did not return a decision id.");
      return { decisionId };
    },
    async decision(decisionId, timeoutSeconds, signal) {
      const res = await call("GET", `${ROUTES.decision(decisionId)}?timeout=${timeoutSeconds}`, undefined, signal);
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The answer could not be read."));
      return res.body;
    },
    async closeDecision(decisionId, body) {
      const res = await call("POST", ROUTES.closeDecision(decisionId), body);
      if (res.status >= 400 && res.status !== 404 && res.status !== 409) throw new RemoteError(res.status, messageOf(res.body, "The answer could not be shared."));
    },
    async complete(jobId, leaseToken, body) {
      const res = await call("POST", ROUTES.complete(jobId), { ...body, leaseToken });
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The result was refused."));
    },
    async reattach(jobId, body) {
      const res = await call("POST", ROUTES.reattach(jobId), body);
      const lease = (res.body as { leaseToken?: unknown } | null)?.leaseToken;
      if (res.status < 300 && typeof lease === "string" && lease) return { leaseToken: lease };
      if (res.status >= 500 || res.status === 0) throw new RemoteError(res.status, messageOf(res.body, "Reconnecting the run failed."));
      return { refused: messageOf(res.body, "Ensemble on the web did not take the run back.") };
    },
    async resume(jobId, body) {
      const res = await call("POST", ROUTES.resume(jobId), body);
      const id = (res.body as { jobId?: unknown } | null)?.jobId;
      if (res.status < 300 && typeof id === "string" && id) return { jobId: id };
      if (res.status >= 500 || res.status === 0) throw new RemoteError(res.status, messageOf(res.body, "Carrying the run on failed."));
      return { refused: messageOf(res.body, "Ensemble on the web did not carry the run on.") };
    },
    async downloadAttachment(jobId, leaseToken, fileId, maxBytes) {
      const response = await fetch(`${base}${ROUTES.attachment(jobId, fileId)}`, { headers: { authorization: `Bearer ${token}`, "x-ensemble-job-lease": leaseToken }, signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!response.ok) throw new RemoteError(response.status, "The attached file could not be downloaded.");
      const reader = response.body?.getReader();
      if (!reader) throw new RemoteError(502, "The attached file has no content.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new RemoteError(413, "The attached file exceeds its download limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return new Uint8Array(Buffer.concat(chunks));
    },
    async uploadFiles(jobId, leaseToken, files) {
      const res = await call("POST", ROUTES.files(jobId), { leaseToken, files });
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The changed files were refused."));
    },
    async answerFiles(requestId, answer) {
      const res = await call("POST", ROUTES.fileAnswer(requestId), answer);
      // The web stopped waiting (410) or never asked this computer (404): nothing to do.
      if (res.status >= 400 && res.status !== 404 && res.status !== 410) throw new RemoteError(res.status, messageOf(res.body, "The answer was refused."));
    },
    async answerCode(requestId, answer) {
      const res = await call("POST", ROUTES.codeAnswer(requestId), answer);
      if (res.status >= 400 && res.status !== 404 && res.status !== 410) throw new RemoteError(res.status, messageOf(res.body, "The answer was refused."));
    },
    async terminalOutput(runId, chunk) {
      const res = await call("POST", ROUTES.terminalOutput(runId), chunk);
      if (res.status === 404 || res.status === 410) return false;
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The output was refused."));
      return true;
    },
    async uploadEvidence(jobId, leaseToken, meta, bytes) {
      channelBase(base);
      let response: Response;
      try {
        // Raw bytes, never through the JSON path: a file holding a saved secret value was refused before this.
        response = await fetch(`${base}${ROUTES.evidence(jobId)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
            [EVIDENCE_HEADERS.lease]: leaseToken,
            [EVIDENCE_HEADERS.meta]: Buffer.from(JSON.stringify(hideSecretsDeep(meta))).toString("base64url"),
          },
          body: bytes.byteLength ? Buffer.from(bytes) : undefined,
          signal: AbortSignal.timeout(10 * 60_000),
          redirect: "error",
        });
      } catch {
        throw new RemoteError(0, "Ensemble on the web is not reachable.");
      }
      const text = await response.text();
      const body = text ? safeJson(text) : null;
      if (response.status === 401 || response.status === 403) throw authError(response.status, body);
      if (response.status === 404 && !(body as { error?: unknown } | null)?.error?.toString().startsWith("Job")) return { result: "unsupported" };
      if (response.status === 409 && messageOf(body, "") === "Lease rejected.") throw new RemoteError(409, "Lease rejected.");
      if (response.status >= 500) throw new RemoteError(response.status, messageOf(body, "The file could not be stored."));
      if (response.status >= 400) return { result: "refused", error: messageOf(body, `Refused (${response.status}).`) };
      return { result: "stored" };
    },
    events(onFrame, signal) {
      return readEvents(base, token, onFrame, signal);
    },
    async assistantTurn(turnId) {
      const res = await call("GET", ROUTES.assistantTurn(turnId));
      if (res.status === 404 || res.status === 410) return null;
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The turn could not be read."));
      return res.body;
    },
    async assistantFile(turnId, fileId, options) {
      let response: Response;
      try {
        response = await fetch(`${base}${ROUTES.assistantFile(turnId, fileId)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
          redirect: "error",
        });
      } catch (error) {
        if (options.signal.aborted) throw error;
        throw new RemoteError(0, "Ensemble on the web is not reachable.");
      }
      if (response.status === 401 || response.status === 403) {
        const text = await response.text();
        throw authError(response.status, text ? safeJson(text) : null);
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) throw new RemoteError(response.status, "The attached file could not be downloaded.");
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > options.maxBytes) throw new RemoteError(413, "The attached file is larger than the turn said.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
    async assistantTool(turnId, body) {
      const res = await call("POST", ROUTES.assistantTool(turnId), body);
      if (res.status === 404 || res.status === 410) return { text: "This turn has ended.", isError: true };
      if (res.status >= 400) return { text: messageOf(res.body, `Ensemble refused the tool call (${res.status}).`), isError: true };
      return res.body;
    },
    async assistantStream(turnId, body) {
      const res = await call("POST", ROUTES.assistantStream(turnId), body);
      if (res.status === 404 || res.status === 410) return { stop: true };
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The reply was refused."));
      return { stop: (res.body as { stop?: unknown } | null)?.stop === true };
    },
    async assistantDone(turnId, body) {
      const res = await call("POST", ROUTES.assistantDone(turnId), body);
      if (res.status >= 400 && res.status !== 404 && res.status !== 410) throw new RemoteError(res.status, messageOf(res.body, "The answer was refused."));
    },
  };
}

/** Pairing. The code is the credential (§4.3); there is no device token yet. */
export async function registerDevice(base: string, body: { code: string; name: string; platform: string; appVersion: string; capabilities: unknown }): Promise<unknown> {
  channelBase(base);
  let response: Response;
  try {
    response = await fetch(`${base}${ROUTES.register}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(process.env.ENSEMBLE_CLI_CHANNEL === "testing" ? { redirect: "error" } : {}),
    });
  } catch {
    throw new RemoteError(0, "Ensemble on the web is not reachable.");
  }
  const text = await response.text();
  const parsed = text ? safeJson(text) : null;
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
    throw new RemoteError(response.status, "That pairing code was not accepted. Ask Ensemble on the web for a new one.");
  }
  if (response.status >= 400) throw new RemoteError(response.status, messageOf(parsed, "Pairing failed."));
  return parsed;
}

async function readEvents(base: string, token: string, onFrame: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
  channelBase(base);
  let response: Response;
  try {
    response = await fetch(`${base}${ROUTES.events}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal, ...(process.env.ENSEMBLE_CLI_CHANNEL === "testing" ? { redirect: "error" as const } : {}) });
  } catch (error) {
    if (signal.aborted) return;
    throw new RemoteError(0, "Ensemble on the web is not reachable.");
  }
  if (response.status === 401 || response.status === 403) {
    const text = await response.text();
    throw authError(response.status, text ? safeJson(text) : null);
  }
  if (!response.ok || !response.body) throw new RemoteError(response.status, "The event stream closed.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Abort has to win even when the server closes this socket in the same turn.
  // Waiting only on reader.read() can stall, and the revoke is then never noticed.
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        emitFrame(buffer.slice(0, split), onFrame);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function emitFrame(raw: string, onFrame: (event: string, data: unknown) => void): void {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length || event === "ping") return;
  onFrame(event, safeJson(data.join("\n")));
}
