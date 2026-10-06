/**
 * The Mac's calls to Ensemble on the web. Doc 25 §4.3, and only those routes.
 * The device token stays in this process; it is never written to a child environment.
 */
import { ROUTES, type Outcome, type ResultLink } from "./contract.js";

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
  return fromEnv ? fromEnv.replace(/\/+$/, "") : null;
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
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface HostedClient {
  unpairSelf(): Promise<void>;
  heartbeat(body: { runningJobIds: string[]; appVersion: string; capabilities: unknown }): Promise<{ cancel: string[] }>;
  claim(): Promise<{ status: number; body: unknown }>;
  progress(jobId: string, leaseToken: string, body: { status?: string; progress: string; events: unknown[]; logs?: { seqFrom: number; seqTo: number; text: string } }): Promise<void>;
  ask(jobId: string, leaseToken: string, body: Record<string, unknown>): Promise<{ decisionId: string }>;
  decision(decisionId: string, timeoutSeconds: number, signal: AbortSignal): Promise<unknown>;
  complete(jobId: string, leaseToken: string, body: { outcome: Outcome; summary: string; results: ResultLink[] }): Promise<void>;
  events(onFrame: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void>;
}

async function send(base: string, token: string, method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal,
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

export function hostedClient(base: string, token: string): HostedClient {
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
    async complete(jobId, leaseToken, body) {
      const res = await call("POST", ROUTES.complete(jobId), { ...body, leaseToken });
      if (res.status >= 400) throw new RemoteError(res.status, messageOf(res.body, "The result was refused."));
    },
    events(onFrame, signal) {
      return readEvents(base, token, onFrame, signal);
    },
  };
}

/** Pairing. The code is the credential (§4.3); there is no device token yet. */
export async function registerDevice(base: string, body: { code: string; name: string; platform: string; appVersion: string; capabilities: unknown }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${ROUTES.register}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
  let response: Response;
  try {
    response = await fetch(`${base}${ROUTES.events}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal });
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
