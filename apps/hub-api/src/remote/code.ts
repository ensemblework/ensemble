/**
 * This computer's side of the Code tab on Ensemble on the web (protocol 4, docs/25 §4.8). The web asks
 * for one call to this computer's own Code API (`routes/code.ts`): the same reviews, diffs, files and
 * source control the Code tab here uses, in the same folders Code may use here. Each call is checked
 * against `CODE_CALLS` again, never reaches git's own files or secrets files, and stops when the person
 * turns off "Show task files on the web" (`browseFiles`, reading) or "Change code from the web"
 * (`webEdit`, every write). Keys in code are hidden on the way out, and a file that holds one opens
 * read-only on the web, so a save can never write the mask back.
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { redactKeys } from "../lib/redact.js";
import { refusedPath } from "../workspace/folder-read.js";
import type { HostedClient } from "./client.js";
import { CODE_ANSWER_BYTES, CODE_EDIT_BYTES, CodeRequest, codeCall, type CodeAnswer } from "./contract.js";
import { loadSettings } from "./store.js";

type Injector = Pick<FastifyInstance, "inject">;

const userId = () => env.ENSEMBLE_DEV_USER_ID;

const refuse = (status: number, error: string): CodeAnswer => ({ status, body: { error } });

/** Every file path a call names: `path` in the query or body, and `paths` in the body. */
function pathsOf(request: CodeRequest): string[] {
  const body = (request.body && typeof request.body === "object" ? request.body : {}) as { path?: unknown; paths?: unknown };
  const list = [request.query.path, body.path, ...(Array.isArray(body.paths) ? body.paths : [])];
  return list.filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function call(app: Injector, method: CodeRequest["method"], path: string, query: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown; bytes: number }> {
  const search = new URLSearchParams(query).toString();
  const res = await app.inject({
    method,
    url: search ? `${path}?${search}` : path,
    headers: {
      host: "localhost",
      "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN,
      "x-ensemble-user": userId(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = res.body ? (JSON.parse(res.body) as unknown) : null;
  } catch {
    parsed = { error: res.body.slice(0, 500) };
  }
  return { status: res.statusCode, body: parsed, bytes: Buffer.byteLength(res.body) };
}

type Hunk = { header?: string; raw?: string; lines?: Array<{ text?: string }> };

/** Hides keys in what goes out; says whether anything was hidden. */
function masked(text: string): { text: string; hidden: boolean } {
  const out = redactKeys(text);
  return { text: out, hidden: out !== text };
}

const KEY_READ_ONLY = "This file holds something that looks like a key. It is shown with that part hidden and can be edited only on the computer.";

/** What leaves this computer for one answer: secrets files out of the review lists, keys hidden. */
function outgoing(request: CodeRequest, body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (request.path === "/api/code/file") {
    const file = body as { path?: string; content?: unknown };
    if (typeof file.content !== "string") return body;
    const head = file.content.slice(0, 8000);
    if (head.includes("\u0000")) return { ...file, content: "", binary: true, readOnly: "A binary file. It is not shown." };
    const big = Buffer.byteLength(file.content) > CODE_EDIT_BYTES;
    const { text, hidden } = masked(big ? file.content.slice(0, CODE_EDIT_BYTES) : file.content);
    return { ...file, content: text, ...(hidden ? { readOnly: KEY_READ_ONLY } : big ? { readOnly: "Files over 1 MB open read-only, cut to their first megabyte." , truncated: true } : {}) };
  }
  if (request.path === "/api/code/diff") {
    const answer = body as { diff?: { fileHeader?: string; hunks?: Hunk[] } };
    if (!answer.diff?.hunks) return body;
    return {
      ...answer,
      diff: {
        ...answer.diff,
        fileHeader: typeof answer.diff.fileHeader === "string" ? redactKeys(answer.diff.fileHeader) : answer.diff.fileHeader,
        hunks: answer.diff.hunks.map((hunk) => ({
          ...hunk,
          raw: typeof hunk.raw === "string" ? redactKeys(hunk.raw) : hunk.raw,
          lines: hunk.lines?.map((line) => (typeof line.text === "string" ? { ...line, text: redactKeys(line.text) } : line)),
        })),
      },
    };
  }
  if (request.path === "/api/code/source") {
    // A changed secrets file is named, never opened: it moves to "Changed, can't be reviewed".
    const source = body as { files?: Array<{ path: string }>; unreviewable?: Array<{ path: string }> };
    if (!Array.isArray(source.files)) return body;
    const hidden = source.files.filter((file) => refusedPath(file.path));
    if (!hidden.length) return body;
    return { ...source, files: source.files.filter((file) => !refusedPath(file.path)), unreviewable: [...(source.unreviewable ?? []), ...hidden] };
  }
  return body;
}

/** The answer to one `code.request`. */
export async function codeAnswerFor(app: Injector, request: CodeRequest): Promise<CodeAnswer> {
  const entry = codeCall(request.method, request.path);
  if (!entry) return refuse(403, "Ensemble on the web may not make that call on this computer.");
  const settings = loadSettings();
  if (!settings.browseFiles) return refuse(409, "Showing code on the web is turned off on this computer. Turn it on there with `ensemble browse on`.");
  if (entry.write && !settings.webEdit) return refuse(409, "Changing code from the web is turned off on this computer. Turn it on there with `ensemble web edit on`.");
  for (const path of pathsOf(request)) {
    const refused = refusedPath(path);
    if (refused) return refuse(403, refused);
  }
  if (request.method === "PUT") {
    const body = (request.body ?? {}) as { content?: unknown; path?: unknown };
    if (typeof body.content !== "string") return refuse(400, "Nothing to save.");
    if (Buffer.byteLength(body.content) > CODE_EDIT_BYTES) return refuse(413, "Files over 1 MB are edited on the computer.");
    // The web had this file read-only if it holds a key; refuse a save that would write the mask back.
    const { review, repo } = body as { review?: string; repo?: string };
    const current = await call(app, "GET", "/api/code/file", { path: String(body.path ?? ""), ...(review ? { review } : {}), ...(repo ? { repo } : {}) });
    const text = (current.body as { content?: unknown } | null)?.content;
    if (current.status === 200 && typeof text === "string" && masked(text).hidden) return refuse(403, KEY_READ_ONLY);
  }
  const answer = await call(app, request.method, request.path, request.query, request.body);
  if (answer.bytes > CODE_ANSWER_BYTES) return refuse(413, "That is too large to show on the web. Open it on the computer.");
  if (entry.write && answer.status < 400) {
    await appendLedger({ userId: userId(), actor: "me", action: "remote.code_write", payload: { call: `${request.method} ${request.path}`, paths: pathsOf(request).slice(0, 20) } }).catch(() => undefined);
  }
  return { status: answer.status, body: answer.status < 400 ? outgoing(request, answer.body) : answer.body };
}

/** A `code.request` frame from the event stream: answer it. A frame without an id cannot be answered and is ignored. */
export async function answerCodeRequest(app: Injector, client: HostedClient, data: unknown): Promise<void> {
  const parsed = CodeRequest.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, refuse(400, "That request could not be read."));
    return;
  }
  let answer: CodeAnswer;
  try {
    answer = await codeAnswerFor(app, parsed.data);
  } catch (error) {
    answer = refuse(500, error instanceof Error ? error.message.slice(0, 300) : "This computer could not answer.");
  }
  await client.answerCode(parsed.data.id, answer);
}
