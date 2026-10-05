/**
 * A model host that cannot be contacted is its own error.
 * The sentence names the cause. Raw socket text, stacks, and server paths stay in the log.
 */
import { RuntimeError } from "./runtime-error.js";
import { looksInternal } from "./text.js";

export const MODEL_UNREACHABLE = "model_unreachable" as const;

export type UnreachableReason = "refused" | "dns" | "down";

export type ConnectClass = "drop" | "refused" | "dns" | "other";

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  mistral: "Mistral",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  ollama: "Ollama",
};

const DROP_NAMES = new Set([
  "RemoteProtocolError",
  "ReadError",
  "ProtocolError",
  "WriteError",
  "CloseError",
  "ConnectionDropped",
]);

const DROP_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const DROP_PHRASE =
  /peer closed connection|incomplete chunked read|socket hang up|other side closed|closed before headers|und_err_socket|econnreset|connection reset|\bepipe\b|server disconnected without sending/i;
const REFUSED_PHRASE = /econnrefused|connection refused/i;
const DNS_PHRASE =
  /enotfound|getaddrinfo|name or service not known|nodename nor servname|temporary failure in name resolution|name resolution|unknown host|err_invalid_url/i;

type ChainPart = { name: string; message: string; code: string };

function chain(error: unknown): ChainPart[] {
  const out: ChainPart[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    out.push({
      name: typeof record.name === "string" ? record.name : "",
      message: typeof record.message === "string" ? record.message : "",
      code: typeof record.code === "string" ? record.code : "",
    });
    current = record.cause;
  }
  return out;
}

/**
 * `drop` means a connection was established and then died.
 * `refused` and `dns` mean it never connected. Drop wins when both appear in the cause chain.
 */
export function classifyConnectFailure(error: unknown): ConnectClass {
  const parts = chain(error);
  if (parts.length === 0) return "other";
  const blob = parts.map((part) => `${part.name} ${part.code} ${part.message}`).join("\n");
  const codes = new Set(parts.map((part) => part.code).filter(Boolean));
  const names = new Set(parts.map((part) => part.name).filter(Boolean));
  if (
    [...codes].some((code) => DROP_CODES.has(code)) ||
    [...names].some((name) => DROP_NAMES.has(name)) ||
    parts.some((part) => part.message.trim().toLowerCase() === "terminated") ||
    DROP_PHRASE.test(blob)
  ) {
    return "drop";
  }
  if ([...codes].some((code) => REFUSED_CODES.has(code)) || REFUSED_PHRASE.test(blob)) return "refused";
  if ([...codes].some((code) => DNS_CODES.has(code)) || DNS_PHRASE.test(blob)) return "dns";
  return "other";
}

function safeToken(value: string, allowUrl: boolean): string {
  const cleaned = value.replace(/\s+/g, "").slice(0, 200);
  if (/^[A-Za-z0-9._:-]+$/.test(cleaned)) return cleaned;
  if (allowUrl && /^https?:\/\/[A-Za-z0-9._:-]+$/.test(cleaned)) return cleaned;
  return "the model host";
}

export function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host) return "the model host";
    const port = parsed.port;
    if (port && port !== "80" && port !== "443") return safeToken(`${host}:${port}`, false);
    return safeToken(host, false);
  } catch {
    return "the model host";
  }
}

export function originLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol || !parsed.hostname) return "the model host";
    const origin = parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : parsed.origin;
    return safeToken(origin, true);
  } catch {
    return "the model host";
  }
}

export function providerLabel(provider: string): string {
  if (PROVIDER_NAMES[provider]) return PROVIDER_NAMES[provider];
  if (/^[A-Za-z0-9._-]{1,40}$/.test(provider)) return provider;
  return "the provider";
}

export function unreachableMessage(
  provider: string,
  url: string,
  kind: "refused" | "dns",
): { message: string; reason: UnreachableReason; host: string } {
  if (provider === "ollama" && kind === "refused") {
    const host = originLabel(url);
    return { message: `Couldn't reach Ollama at ${host}. Is it running?`, reason: "down", host };
  }
  if (kind === "dns") {
    const host = hostLabel(url);
    return { message: `${host} couldn't be found. Check the model URL.`, reason: "dns", host };
  }
  const host = hostLabel(url);
  return {
    message: `Couldn't reach ${providerLabel(provider)} at ${host}: connection refused`,
    reason: "refused",
    host,
  };
}

export function isUnreachableNotice(content: string): boolean {
  const text = content.trim();
  if (text.startsWith("Couldn't reach ") && (text.endsWith("Is it running?") || text.endsWith(": connection refused"))) return true;
  return text.endsWith("couldn't be found. Check the model URL.");
}

export type ModelUnreachableBody = {
  code: typeof MODEL_UNREACHABLE;
  error: string;
  message: string;
  provider: string;
  model: string;
  host: string;
  reason: UnreachableReason;
  kind: "unreachable";
  status: 503;
};

export class ModelUnreachableError extends RuntimeError {
  readonly code = MODEL_UNREACHABLE;
  readonly provider: string;
  readonly model: string;
  readonly host: string;
  readonly reason: UnreachableReason;

  constructor(args: { message: string; provider: string; model: string; host: string; reason: UnreachableReason }) {
    super(args.message, 503);
    this.name = "ModelUnreachableError";
    this.provider = args.provider;
    this.model = args.model;
    this.host = args.host;
    this.reason = args.reason;
  }

  toJSON(): ModelUnreachableBody {
    return {
      code: this.code,
      error: this.message,
      message: this.message,
      provider: this.provider,
      model: this.model,
      host: this.host,
      reason: this.reason,
      kind: "unreachable",
      status: 503,
    };
  }
}

export function transportFailure(
  error: unknown,
  context: { provider: string; model: string; url: string },
): ModelUnreachableError | null {
  if (error instanceof ModelUnreachableError) return error;
  const kind = classifyConnectFailure(error);
  if (kind !== "refused" && kind !== "dns") return null;
  const built = unreachableMessage(context.provider, context.url, kind);
  return new ModelUnreachableError({
    message: built.message,
    provider: context.provider,
    model: context.model,
    host: built.host,
    reason: built.reason,
  });
}

function safeNotice(message: string, fallback: string): string {
  if (!message || message.length > 300 || /[\r\n]/.test(message) || looksInternal(message) || !isUnreachableNotice(message)) {
    return fallback;
  }
  return message;
}

export function unreachableFromFrame(
  data: { message?: string; provider?: string; model?: string; host?: string; reason?: string },
  model: string,
): ModelUnreachableError {
  const reason: UnreachableReason = data.reason === "dns" || data.reason === "down" || data.reason === "refused" ? data.reason : "refused";
  const provider = typeof data.provider === "string" ? data.provider : "";
  const host = typeof data.host === "string" ? safeToken(data.host, true) : "the model host";
  const fallback =
    reason === "dns"
      ? `${host} couldn't be found. Check the model URL.`
      : reason === "down"
        ? `Couldn't reach Ollama at ${host}. Is it running?`
        : `Couldn't reach ${providerLabel(provider)} at ${host}: connection refused`;
  const message = typeof data.message === "string" ? safeNotice(data.message, fallback) : fallback;
  return new ModelUnreachableError({
    message,
    provider,
    model: typeof data.model === "string" && data.model ? data.model : model,
    host,
    reason,
  });
}
