/**
 * The interactive app's view of this computer's Ensemble (the same runtime the desktop app
 * uses): agent runs, Needs me, settings and run profiles, models, and Ensemble Code chat.
 */
import type { RunProfile, SubscriptionAgent } from "@ensemble/shared-types";
import type { Discovery } from "../sidecar.js";

export type JobCard = {
  id: string;
  taskId: string;
  title: string;
  status: string;
  kind: string;
  provider?: string | null;
  model?: string | null;
  progress?: string | null;
  summary?: string | null;
  error?: string | null;
  folder: string;
  position: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  delivery: string;
  unattended: boolean;
  accessMode: string;
  executionMode: string;
  deviceName?: string | null;
};

export type Workspace = {
  root: string;
  paused: boolean;
  maxConcurrent: number;
  queued: JobCard[];
  running: JobCard[];
  waiting: JobCard[];
  stopped: JobCard[];
  completed: JobCard[];
};

export type JobDetail = { job: JobCard & { instructions?: string; sandbox?: { mechanism?: string; effective?: boolean } }; log: string; events: Array<{ id: string; kind: string; data: unknown; at: string }> };

export type Decision = {
  id: string;
  source: string;
  event: string;
  toolName: string;
  title: string;
  detail: {
    command?: string | null;
    options?: string[];
    optionDetails?: Array<{ label: string; description: string }>;
    allowCustom?: boolean;
    multiSelect?: boolean;
    recommended?: string | null;
    jobId?: string;
    deviceName?: string | null;
    confirm?: boolean;
  };
  cwd: string | null;
  status: string;
  requestedAt: string;
  canAnswer?: boolean;
};

/** `code`: why an unavailable row cannot be used ("included_local_only": included models on a computer with no account). */
export type ModelRow = { provider: string; available: boolean; models: string[]; chat: boolean; cheapest: string | null; source: string; error?: string | null; code?: string | null };

export type Settings = {
  runProfiles: RunProfile[];
  defaultRunProfileId: string | null;
  orchestration: { defaultExecution?: string; sandboxNetwork?: boolean; outsideAccess?: string };
  models: Record<string, { provider: string; model: string; effort?: string }>;
  assistant: { writePolicy: string; defaultTier?: string };
};

export type ToolCall = { id: string; name: string; summary?: string; state: string; input: Record<string, unknown>; error?: string; isWrite?: boolean };

export type ChatFrame =
  | { type: "status"; text?: string; conversationId?: string }
  | { type: "delta"; text: string }
  | { type: "tool"; call: ToolCall }
  | { type: "pending"; call: ToolCall; preview: string }
  | { type: "error"; message?: string; error?: string; code?: string; resetsAt?: string | null }
  | { type: "done"; conversationId: string; content: string; model?: string; interrupted?: boolean };

export type CodeSession = { folder: string; engine?: string; profileId?: string | null; runModel?: string | null; outsideAccess?: string };

export class LocalApi {
  constructor(readonly discovery: Discovery) {}

  private url(path: string): string {
    return `http://127.0.0.1:${this.discovery.port}${path}`;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${this.discovery.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `${response.status} ${response.statusText}`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return body as T;
  }

  workspace = () => this.json<Workspace>("/api/workspace");
  job = (id: string) => this.json<JobDetail>(`/api/agent/jobs/${id}`);
  stopJob = (id: string) => this.json<unknown>(`/api/agent/jobs/${id}/stop`, { method: "POST", body: {} });
  retryJob = (id: string) => this.json<{ jobId: string }>(`/api/agent/jobs/${id}/retry`, { method: "POST", body: {} });
  decisions = () => this.json<{ decisions: Decision[] }>("/api/decisions").then((body) => body.decisions);
  decide = (id: string, body: { decision: "allow" | "deny"; scope?: "once" | "session" | "always"; reason?: string; confirmed?: boolean }) =>
    this.json<unknown>(`/api/decisions/${id}/decide`, { method: "POST", body });
  settings = () => this.json<{ settings: Settings }>("/api/settings").then((body) => body.settings);
  patchSettings = (patch: unknown) => this.json<{ settings: Settings }>("/api/settings", { method: "PATCH", body: patch });
  models = () => this.json<{ providers: ModelRow[]; runtime: boolean }>("/api/models");
  setModelKey = (provider: string, apiKey: string) => this.json<{ ok: boolean; models: number }>(`/api/model-keys/${encodeURIComponent(provider)}`, { method: "PUT", body: { apiKey } });
  setModule = (id: string, on: boolean) => this.json<{ modules: string }>("/api/settings/modules", { method: "PUT", body: { id, on } });
  conversations = () => this.json<{ conversations: Array<{ id: string; title: string; updatedAt: string }> }>("/api/assistant/conversations").then((body) => body.conversations);
  messages = (id: string) =>
    this.json<{ messages: Array<{ id: string; role: string; content: string; toolCalls?: ToolCall[] | null }> }>(`/api/assistant/conversations/${id}/messages`).then((body) => body.messages);
  apply = (body: { conversationId?: string; calls: Array<{ name: string; input: Record<string, unknown>; callId?: string }>; code?: CodeSession }) =>
    this.json<{ summary: string }>("/api/assistant/apply", { method: "POST", body });
  stopChat = (id: string) => this.json<unknown>(`/api/assistant/conversations/${id}/stop`, { method: "POST", body: {} });
  trust = (path: string) => this.json<{ id: string; path: string }>("/api/workspace/trust", { method: "POST", body: { path } });
  trusted = () => this.json<{ folders: Array<{ id: string; path: string }> }>("/api/workspace/trust").then((body) => body.folders);
  guard = () => this.json<{ root: string; sandbox: { mechanism: string; osSandbox: boolean; strength: string; reason?: string } }>("/api/workspace/guard");
  agentApps = () => this.json<{ available: boolean; agents: Array<{ id: string; name: string; app: boolean; cli: string | null }> }>("/api/agent/apps");
  modelKeys = () => this.json<{ credentials: Array<{ provider: string; source: string; hint?: string | null }> }>("/api/model-keys");
  /**
   * The coding agents this computer's runtime found, with their sign-in and models (the same check
   * the web's Settings → Models shows). `fresh` checks again instead of using the last answer.
   */
  localAgents = (fresh = false): Promise<SubscriptionAgent[] | null> =>
    fresh
      ? this.json<{ agents?: SubscriptionAgent[] }>("/api/subscriptions/check", { method: "POST", body: { deviceId: "local" } }).then((body) => body.agents ?? null)
      : this.json<{ computers?: Array<{ local?: boolean; agents?: SubscriptionAgent[] }> }>("/api/subscriptions").then((body) => body.computers?.find((computer) => computer.local)?.agents ?? null);

  /** One Ensemble Code turn, streamed: each frame as it comes. Resolves when the turn is done. */
  async chat(body: { conversationId?: string; message: string; model?: string; provider?: string; code: CodeSession }, onFrame: (frame: ChatFrame) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.url("/api/assistant/turn"), {
      method: "POST",
      headers: { authorization: `Bearer ${this.discovery.token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let message = text;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; code?: string };
        message = parsed.message ?? parsed.error ?? text;
        code = typeof parsed.code === "string" ? parsed.code : undefined;
      } catch {
        // plain text
      }
      // The code lets an included refusal show as a notice ("connect this computer").
      throw Object.assign(new Error(message || `${response.status} ${response.statusText}`), code ? { code } : {});
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseSse(block);
        if (frame) onFrame(frame);
      }
    }
  }
}

/** One server-sent event block → a chat frame (its `data` carries the type). */
export function parseSse(block: string): ChatFrame | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    const parsed = JSON.parse(data.join("\n")) as Record<string, unknown>;
    return { ...(parsed as object), type: (parsed.type as string | undefined) ?? event } as ChatFrame;
  } catch {
    return null;
  }
}
