/**
 * `secret_http` (B12, docs/35 §8.7): a request made on this computer with a saved secret put in where
 * `{{NAME}}` appears in a header or the body, so the caller (a coding agent through its run's MCP
 * server, or a node through `node.tool.request`) uses the secret without ever seeing it. It goes only to
 * the origins the owner allowed for that secret (`ensemble secrets allow NAME <origin>`), over https (or
 * http on this computer itself), never in the address, never following a redirect, and the answer comes
 * back with the value hidden, as written and in its common encodings. Each use is in the ledger with the
 * name and the origin, never the value.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { inScope, savedSecret, secretNameProblem, type SecretScope } from "../lib/run-secrets.js";

export const SECRET_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const BODY_BYTES = 64 * 1024;
const ANSWER_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

export const SecretHttpInput = z
  .object({
    ref: z.string().min(2).max(80),
    url: z.string().min(1).max(2000),
    method: z.enum(SECRET_HTTP_METHODS).default("GET"),
    headers: z.record(z.string().min(1).max(100), z.string().max(8000)).optional(),
    body: z.string().max(BODY_BYTES).optional(),
  })
  .strict();
export type SecretHttpInput = z.input<typeof SecretHttpInput>;

/** A request by reference that was refused: the reason is for the caller, and never holds the value. */
export class SecretUseError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 = 403,
  ) {
    super(message);
    this.name = "SecretUseError";
  }
}

export type SecretHttpResult = { status: number; url: string; headers: Record<string, string>; body: string; truncated: boolean; binary: boolean; note?: string };

/** The secret's name from `NAME`, `$NAME`, `{{NAME}}` or `secret://NAME`. */
export function refName(ref: string): string {
  return ref
    .trim()
    .replace(/^secret:\/\//i, "")
    .replace(/^\{\{\s*|\s*\}\}$/g, "")
    .replace(/^\$/, "")
    .toUpperCase();
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the request sets itself, or that would change where or how it goes. */
const FIXED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "expect", "proxy-authorization", "proxy-connection", "forwarded", "x-forwarded-for", "x-forwarded-host"]);
/** Answer headers worth passing on. Cookies are never passed on. */
const KEEP = /^(content-type|content-length|date|location|retry-after|link|www-authenticate|request-id|x-request-id|x-github-request-id|x-ratelimit-.+|ratelimit.*|x-rate-limit-.+)$/;

/** Shapes the value keeps inside a longer text that holds it: as written, URL- and form-encoded, JSON-escaped, hex. */
function verbatimShapes(value: string): string[] {
  const bytes = Buffer.from(value);
  const shapes = [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, "+"), JSON.stringify(value).slice(1, -1), bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
  return [...new Set(shapes)].filter((shape) => shape.length >= 6).sort((a, b) => b.length - a.length);
}

/**
 * The part of the value's base64 that stays the same wherever it sits in a longer base64 text (as in
 * `Basic` or echoed `Bearer …` headers): for each of the three alignments, the groups made only of
 * the value's own bytes. Both alphabets.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value);
  const cores: string[] = [];
  for (const lead of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(lead), bytes]);
    const full = Math.floor(padded.length / 3) * 4;
    for (const encoding of ["base64", "base64url"] as const) {
      const core = padded.toString(encoding).slice(lead ? 4 : 0, full);
      if (core.length >= 8) cores.push(core);
    }
  }
  return [...new Set(cores)];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with the secret's value hidden: as written and in the encodings an answer commonly echoes it in
 * (a whole base64 run holding it goes), then every saved value and key shape (lib/redact.ts). This is
 * defence in depth: a service that returns the value transformed some other way, or a part of it, is
 * not caught; the allowed destinations are what keep it in place.
 */
export function hideValue(text: string, value: string, name: string): string {
  const tag = `[${name}]`;
  let out = text;
  for (const shape of verbatimShapes(value)) out = out.split(shape).join(tag);
  for (const core of base64Cores(value)) out = out.replace(new RegExp(`[A-Za-z0-9+/_-]*${escape(core)}[A-Za-z0-9+/_-]*=*`, "g"), tag);
  return redactText(out);
}

async function readCapped(response: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size > ANSWER_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, ANSWER_BYTES), truncated };
}

export type SecretHttpContext = {
  prisma: Pick<PrismaClient, "runSecret">;
  userId: string;
  /** Which saved secrets the caller may use: a run's scope, or `all` for a node naming one in its call. */
  scope: SecretScope;
  /** False when the caller's run has the internet off. */
  network?: boolean;
  /** For the ledger: who asked. */
  via: { kind: "run"; jobId: string } | { kind: "node"; nodeId: string; operationId?: string | null };
  fetchImpl?: typeof fetch;
};

/** Makes the request, or refuses with why (SecretUseError). */
export async function secretHttp(raw: unknown, ctx: SecretHttpContext): Promise<SecretHttpResult> {
  const parsed = SecretHttpInput.safeParse(raw);
  if (!parsed.success) throw new SecretUseError(`Not sent: ${parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}.`, 400);
  const input = parsed.data;
  const name = refName(input.ref);
  const nameProblem = secretNameProblem(name);
  if (nameProblem) throw new SecretUseError(nameProblem, 400);
  if (ctx.network === false) throw new SecretUseError("The internet is off for this run, so nothing is sent.");
  const saved = await savedSecret(ctx.prisma as PrismaClient, ctx.userId, name);
  if (!saved) throw new SecretUseError(`${name} is not saved on this computer. Ask your owner for it (a node: node_secret_request; on the computer: \`ensemble secrets set ${name}\`).`, 404);
  if (!inScope(ctx.scope, name)) throw new SecretUseError(`This run may not use ${name}: it is not among the secrets named for it. Your owner names it in the run profile or the node's step.`);
  if (!saved.allow.length) {
    throw new SecretUseError(`${name} has no allowed destinations, so it is never sent anywhere by reference. Your owner can allow one on this computer: \`ensemble secrets allow ${name} https://api.example.com\` (the service's origin).`);
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SecretUseError("That is not a web address.", 400);
  }
  if (url.username || url.password) throw new SecretUseError("An address with a user name or password is not used.", 400);
  if (!saved.allow.includes(url.origin)) throw new SecretUseError(`${name} may only be sent to ${saved.allow.join(", ")}; ${url.origin} is not allowed. Only your owner can allow another destination, on this computer.`);
  const placeholder = `{{${name}}}`;
  const address = input.url.toLowerCase();
  if (address.includes(placeholder.toLowerCase()) || address.includes(`%7b%7b${name.toLowerCase()}`)) throw new SecretUseError(`Put ${placeholder} in a header or the body, never in the address.`, 400);
  if (/[\r\n]/.test(saved.value)) throw new SecretUseError(`${name} holds a line break, so it cannot go in a request by reference.`, 400);
  const headers: Record<string, string> = {};
  let used = false;
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (!TOKEN.test(key) || key.includes(placeholder)) throw new SecretUseError(`“${key.slice(0, 60)}” is not a header name.`, 400);
    if (FIXED_HEADERS.has(key.toLowerCase())) throw new SecretUseError(`The ${key} header is set by the request itself.`, 400);
    if (/[\r\n]/.test(value)) throw new SecretUseError(`The ${key} header has a line break.`, 400);
    if (value.includes(placeholder)) used = true;
    headers[key] = value.split(placeholder).join(saved.value);
  }
  let body = input.body;
  if (body !== undefined) {
    if (input.method === "GET" || input.method === "HEAD") throw new SecretUseError(`A ${input.method} request has no body.`, 400);
    if (body.includes(placeholder)) used = true;
    body = body.split(placeholder).join(saved.value);
  }
  if (!used) throw new SecretUseError(`Put ${placeholder} where the value goes: in a header (Authorization: Bearer ${placeholder}) or the body.`, 400);
  let response: Response;
  try {
    response = await (ctx.fetchImpl ?? fetch)(url, { method: input.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new SecretUseError(`${url.origin} could not be reached: ${hideValue(error instanceof Error ? error.message : String(error), saved.value, name).slice(0, 200)}`, 400);
  }
  const { bytes, truncated } = await readCapped(response);
  const type = response.headers.get("content-type") ?? "";
  const binary = bytes.includes(0) && !/^text\/|json|xml|javascript|html/.test(type);
  const kept: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (KEEP.test(key.toLowerCase())) kept[key.toLowerCase()] = hideValue(value, saved.value, name).slice(0, 2000);
  });
  const redirected = response.status >= 300 && response.status < 400 && kept.location;
  await appendLedger({
    userId: ctx.userId,
    actor: "agent",
    action: "secret.use",
    payload: { name, origin: url.origin, method: input.method, status: response.status, via: "secret_http", ...(ctx.via.kind === "run" ? { jobId: ctx.via.jobId } : { nodeId: ctx.via.nodeId, operationId: ctx.via.operationId ?? null }) },
  }).catch(() => undefined);
  return {
    status: response.status,
    url: hideValue(url.href, saved.value, name),
    headers: kept,
    body: binary ? `[${bytes.length} bytes of binary content]` : hideValue(bytes.toString("utf8"), saved.value, name),
    truncated,
    binary,
    ...(redirected ? { note: "A redirect is not followed. Call again with that address if it is one of the allowed destinations." } : {}),
  };
}

/** The tool's description, the same for coding agents and nodes. */
export const SECRET_HTTP_DESCRIPTION =
  "Call a web API with one of your owner's saved secrets without ever seeing it. Name the secret in ref (STRIPE_KEY) and put {{STRIPE_KEY}} where its value goes: in a header (Authorization: Bearer {{STRIPE_KEY}}) or inside the body (in a JSON string). " +
  "It goes only to the destinations your owner allowed for that secret, never in the address, redirects are not followed, and the answer (at most 64 KB) comes back with the value hidden. A secret with no allowed destination is refused with how your owner can allow one.";
