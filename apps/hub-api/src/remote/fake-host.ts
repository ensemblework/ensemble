/**
 * A minimal hosted API for the desktop tests. It implements the device routes
 * in docs/25 §4.3 and nothing else: pair, heartbeat, claim, progress, ask,
 * the decision long-poll, complete, and the event stream.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { DEVICE_EVENT_KINDS } from "./contract.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Job = {
  id: string;
  status: string;
  deviceId: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  spec: Record<string, unknown>;
  progress: string;
  logs: string;
  events: Array<{ kind: string }>;
  seenSeq: Set<number>;
  complete: { outcome: string; summary: string } | null;
  cancel: boolean;
};

type Decision = {
  id: string;
  jobId: string;
  body: Record<string, unknown>;
  status: "pending" | "decided";
  decision: "allow" | "deny" | null;
  scope: string | null;
  reason: string | null;
  actionHash: string | null;
  /** Returned once, instead of the stored answer. */
  rogue: Record<string, unknown> | null;
  waiters: Array<() => void>;
};

export interface FakeHost {
  origin: string;
  code: string;
  deviceId: string | null;
  enqueue(spec: Record<string, unknown>): string;
  job(id: string): Job;
  asks(): Decision[];
  answer(decisionId: string, body: { decision?: "allow" | "deny"; scope?: string; reason?: string | null; actionHash?: string | null; id?: string }): void;
  rogue(decisionId: string, body: Record<string, unknown>): void;
  /** Inject a device-stream frame. `revoke()` sends `device.revoked` itself. */
  emit(event: string, data?: unknown): void;
  /** True once the desktop's event stream is connected. */
  streaming: boolean;
  /** Next device call is 403, as when the token is not a device token. */
  rejectScope(): void;
  /** End the open device stream. The desktop reconnects at once. */
  closeStream(): void;
  /**
   * The stream ends and the next open is 401. No `device.revoked` frame.
   * The desktop treats that 401 as removal.
   */
  closeThenUnauthorized(): void;
  /** How many event-stream opens were answered 401. */
  unauthorizedEvents: number;
  revoke(): void;
  close(): Promise<void>;
}

const DEVICE_KIND = new Set<string>(DEVICE_EVENT_KINDS);

function validEvents(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 50) return false;
  return value.every((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
    const kind = (row as { kind?: unknown }).kind;
    const data = (row as { data?: unknown }).data;
    if (typeof kind !== "string" || !DEVICE_KIND.has(kind)) return false;
    if (data === undefined) return true;
    return typeof data === "object" && data !== null && !Array.isArray(data);
  });
}

export async function startFakeHost(options: { leaseMs?: number; sweepMs?: number; code?: string } = {}): Promise<FakeHost> {
  const leaseMs = options.leaseMs ?? 120_000;
  const code = options.code ?? "PAIRCODE";
  let token: string | null = null;
  let revoked = false;
  let scopeForbidden = false;
  let unauthorizedEvents = 0;
  let deviceId: string | null = null;
  let deviceName: string | null = null;
  const jobs = new Map<string, Job>();
  const decisions = new Map<string, Decision>();
  const listeners = new Set<ServerResponse>();

  const publish = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(frame);
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (!["claimed", "running", "waiting_approval"].includes(job.status)) continue;
      if (job.leaseUntil && job.leaseUntil < now) {
        job.status = "interrupted";
        publish("job.cancel", { id: job.id });
      }
    }
  }, options.sweepMs ?? 1000);
  sweep.unref();

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => resolve(raw));
    });

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, text ? { "content-type": "application/json" } : {});
    res.end(text);
  };

  // Same split as #47 ownDevice: wrong caller is 403, a missing or revoked device is 401.
  const authed = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (scopeForbidden) {
      send(res, 403, { error: "Only the paired computer can call this." });
      return false;
    }
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || presented !== token || revoked) {
      send(res, 401, { error: "This computer is no longer paired." });
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const raw = req.method === "GET" ? "" : await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (req.method === "POST" && path === "/api/devices/register") {
      const presented = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (presented !== code.trim().toUpperCase()) return send(res, 401, { error: "That pairing code is not valid." });
      token = `ens_d_${randomBytes(18).toString("base64url")}`;
      revoked = false;
      scopeForbidden = false;
      deviceId = randomUUID();
      deviceName = typeof body.name === "string" ? body.name : "Mac";
      return send(res, 201, { token, device: { id: deviceId, name: deviceName } });
    }

    if (path === "/api/devices/self/events" && req.method === "GET") {
      if (!authed(req, res)) {
        unauthorizedEvents += 1;
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(":\n\n");
      listeners.add(res);
      const ping = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        listeners.delete(res);
      });
      return;
    }

    if (!path.startsWith("/api/devices/self")) return send(res, 404, { error: "No such route." });
    if (!authed(req, res)) return;

    if (req.method === "POST" && path === "/api/devices/self/heartbeat") {
      const ids = Array.isArray(body.runningJobIds) ? body.runningJobIds.filter((id): id is string => typeof id === "string") : [];
      const cancel: string[] = [];
      for (const id of ids) {
        const job = jobs.get(id);
        if (!job || job.deviceId !== deviceId) continue;
        if (job.cancel) cancel.push(id);
        if (["claimed", "running", "waiting_approval"].includes(job.status)) job.leaseUntil = Date.now() + leaseMs;
      }
      return send(res, 200, { cancel });
    }

    if (req.method === "POST" && path === "/api/devices/self/claim") {
      const next = [...jobs.values()].find((job) => job.status === "queued" && job.deviceId === deviceId);
      if (!next) return send(res, 204);
      next.status = "claimed";
      next.leaseToken = randomBytes(16).toString("hex");
      next.leaseUntil = Date.now() + leaseMs;
      return send(res, 200, { ...next.spec, id: next.id, leaseToken: next.leaseToken });
    }

    const progress = /^\/api\/devices\/self\/jobs\/([^/]+)\/progress$/.exec(path);
    const ask = /^\/api\/devices\/self\/jobs\/([^/]+)\/ask$/.exec(path);
    const complete = /^\/api\/devices\/self\/jobs\/([^/]+)\/complete$/.exec(path);
    const decision = /^\/api\/devices\/self\/decisions\/([^/]+)$/.exec(path);
    const jobOf = (id: string) => jobs.get(id);

    if (progress && req.method === "POST") {
      const job = jobOf(decodeURIComponent(progress[1]!));
      if (!job || job.leaseToken !== body.leaseToken || job.leaseUntil < Date.now() || job.status === "interrupted") return send(res, 409, { error: "The lease is not held." });
      if (body.status !== undefined && body.status !== "running") return send(res, 400, { error: "status must be running." });
      if (body.progress !== undefined && (typeof body.progress !== "string" || body.progress.length > 200)) return send(res, 400, { error: "progress is too long." });
      if (body.events !== undefined && !validEvents(body.events)) return send(res, 400, { error: "events must be records." });
      const logs = body.logs as { seqFrom?: number; text?: string } | undefined;
      if (logs && typeof logs.text === "string" && Buffer.byteLength(logs.text) > 64 * 1024) return send(res, 413, { error: "log chunk is over 64 KB." });
      if (body.status === "running") job.status = "running";
      if (typeof body.progress === "string") job.progress = body.progress;
      if (Array.isArray(body.events)) {
        for (const row of body.events) {
          if (typeof row === "object" && row !== null && typeof (row as { kind?: unknown }).kind === "string") job.events.push({ kind: (row as { kind: string }).kind });
        }
      }
      if (logs && typeof logs.seqFrom === "number" && typeof logs.text === "string" && !job.seenSeq.has(logs.seqFrom)) {
        job.seenSeq.add(logs.seqFrom);
        job.logs += logs.text;
      }
      job.leaseUntil = Date.now() + leaseMs;
      return send(res, 200, { ok: true });
    }

    if (ask && req.method === "POST") {
      const job = jobOf(decodeURIComponent(ask[1]!));
      if (!job || job.leaseToken !== body.leaseToken || job.leaseUntil < Date.now()) return send(res, 409, { error: "The lease is not held." });
      if (typeof body.title !== "string" || body.title.length < 1 || body.title.length > 300) return send(res, 400, { error: "title is required." });
      if ("command" in body && typeof body.command !== "string") return send(res, 400, { error: "command must be a string." });
      if (body.tier !== undefined && body.tier !== "ordinary" && body.tier !== "run_branch_push" && body.tier !== "high_risk") return send(res, 400, { error: "tier is not valid." });
      const row: Decision = {
        id: randomUUID(),
        jobId: job.id,
        body,
        status: "pending",
        decision: null,
        scope: null,
        reason: null,
        actionHash: typeof body.actionHash === "string" ? body.actionHash : null,
        rogue: null,
        waiters: [],
      };
      decisions.set(row.id, row);
      if (job.status === "running" || job.status === "claimed") job.status = "waiting_approval";
      job.leaseUntil = Date.now() + leaseMs;
      publish("decision.answered", { id: row.id });
      return send(res, 201, { decisionId: row.id });
    }

    if (decision && req.method === "GET") {
      const row = decisions.get(decodeURIComponent(decision[1]!));
      if (!row) return send(res, 404, { error: "Decision not found." });
      const timeout = Math.min(55, Math.max(1, Number(url.searchParams.get("timeout") ?? 25)));
      const ready = () => row.rogue !== null || row.status !== "pending";
      if (!ready()) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout * 1000);
        row.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (row.rogue) {
        const rogue = row.rogue;
        row.rogue = null;
        return send(res, 200, rogue);
      }
      return send(res, 200, { id: row.id, status: row.status, decision: row.decision, scope: row.scope, reason: row.reason, actionHash: row.actionHash });
    }

    if (complete && req.method === "POST") {
      const job = jobOf(decodeURIComponent(complete[1]!));
      if (!job || job.leaseToken !== body.leaseToken || job.leaseUntil < Date.now()) return send(res, 409, { error: "The lease is not held." });
      if (["interrupted", "succeeded", "failed", "cancelled", "blocked"].includes(job.status) && job.complete) return send(res, 409, { error: "Already finished." });
      const outcome = body.outcome;
      if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled" && outcome !== "blocked") return send(res, 400, { error: "outcome is not valid." });
      const links = Array.isArray(body.results) ? (body.results as Array<{ url?: unknown }>) : [];
      if (links.some((link) => typeof link.url !== "string" || !link.url.startsWith("https://"))) return send(res, 400, { error: "Result links must be https." });
      job.status = outcome;
      job.complete = { outcome, summary: typeof body.summary === "string" ? body.summary : "" };
      return send(res, 204);
    }

    return send(res, 404, { error: "No such route." });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    code,
    get deviceId() {
      return deviceId;
    },
    enqueue(spec) {
      if (!deviceId) throw new Error("Pair before queueing a remote task.");
      const id = typeof spec.id === "string" ? spec.id : randomUUID();
      jobs.set(id, {
        id,
        status: "queued",
        deviceId,
        leaseToken: null,
        leaseUntil: 0,
        spec,
        progress: "",
        logs: "",
        events: [],
        seenSeq: new Set(),
        complete: null,
        cancel: false,
      });
      publish("job.queued", { id });
      return id;
    },
    job(id) {
      const job = jobs.get(id);
      if (!job) throw new Error(`no hosted job ${id}`);
      return job;
    },
    asks: () => [...decisions.values()],
    answer(decisionId, patch) {
      const row = decisions.get(decisionId);
      if (!row) throw new Error(`no decision ${decisionId}`);
      row.status = "decided";
      row.decision = patch.decision ?? "allow";
      row.scope = patch.scope ?? "once";
      row.reason = patch.reason ?? null;
      row.actionHash = patch.actionHash === undefined ? row.actionHash : patch.actionHash;
      if (patch.id) row.id = patch.id;
      for (const wake of row.waiters) wake();
      row.waiters = [];
      publish("decision.answered", { id: row.id });
    },
    rogue(decisionId, body) {
      const row = decisions.get(decisionId);
      if (!row) throw new Error(`no decision ${decisionId}`);
      row.rogue = body;
      for (const wake of row.waiters) wake();
      row.waiters = [];
    },
    emit(event, data = {}) {
      publish(event, data);
    },
    get streaming() {
      return listeners.size > 0;
    },
    rejectScope() {
      scopeForbidden = true;
    },
    closeStream() {
      for (const res of [...listeners]) res.end();
    },
    closeThenUnauthorized() {
      revoked = true;
      for (const res of [...listeners]) res.end();
    },
    get unauthorizedEvents() {
      return unauthorizedEvents;
    },
    revoke() {
      // Frame, then close, then 401. The flag is set after the frame is written
      // and before end(), so this open still carries the frame and the next open is 401.
      publish("device.revoked", { deviceId, reason: "revoked" });
      revoked = true;
      for (const res of [...listeners]) res.end();
    },
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweep);
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
