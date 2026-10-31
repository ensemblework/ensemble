/**
 * `hub_save_file` (docs/35 §6): puts a file into Ensemble Files from a public web link (fetched here,
 * guarded like plots/ssrf.ts: http(s) only, every address and every redirect checked against private
 * networks, the Files size cap, documents, images and media only, never a web page), from evidence the
 * account owns (a capture, a download a node's browser made), or, for a node, from a path on its owner's
 * computer (shared as evidence first, node/device-tools.ts) or a file its owner attached in the chat
 * (already in the owner's Files: found, tagged with the project, or copied into another space). The file
 * is saved like an upload (files/store.ts `saveFile`), with where it came from, and its link is
 * `ensemble://file/<id>`.
 * The Hub's assistant follows the person's write policy; a node's owner-started turn saves at once.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { z } from "zod";
import { FILE_FORMATS, fileExtension, fileFormat, fileTypeProblem, type FileRecord } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { evidenceContent } from "../../evidence/store.js";
import { ORIGINAL_SELECT, originalBytes } from "../../files/originals.js";
import { assertNewFile, FILE_SELECT, fileRecord, maxFileBytes, safeFilename, saveFile } from "../../files/store.js";
import { requireVerifiedUser } from "../../lib/hosted-access.js";
import { HostedLimitError } from "../../lib/hosted-limits.js";
import { isBlockedAddress } from "../../plots/ssrf.js";
import { actorFor } from "../../sharing/context.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext, type ToolResult } from "../types.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
const USER_AGENT = "Mozilla/5.0 (compatible; EnsembleFiles/1.0; +https://ensemblework.com)";
/** Kinds of file a web link may bring in: documents, images and media, not programs or unknown binaries. */
const KEPT_KINDS = new Set(["pdf", "document", "slides", "sheet", "image", "text", "code", "audio", "video"]);
const WEB_PAGE_HINT =
  "That link opened a web page, not a file. Give the direct link to the file (for a paper, its PDF link), or download it with browser_fetch and save the evidence id it returns.";

export class SaveFileError extends ToolBlockedError {
  readonly expose = true;
  constructor(
    message: string,
    remedy?: string,
    readonly statusCode = 400,
  ) {
    super(message, remedy);
    this.name = "SaveFileError";
  }
}

export type LookupFn = (hostname: string) => Promise<string[]>;
export type SaveFetchDeps = {
  lookup?: LookupFn;
  /** Whether an address (that `hostname` resolved to) may be fetched. Default: public addresses only. */
  allowAddress?: (address: string, hostname: string) => boolean;
};

let testDeps: SaveFetchDeps | null = null;

/** Tests reach a local site through a name only they resolve. */
export function setSaveFileNetworkForTests(deps: SaveFetchDeps | null): void {
  testDeps = deps;
}

/** Private, loopback, link-local and other addresses no web link may reach, including IPv6 forms that carry an IPv4 address. */
export function privateAddress(address: string): boolean {
  if (isBlockedAddress(address)) return true;
  const lower = address.toLowerCase();
  if (!lower.includes(":")) return false;
  const mapped = /^(?:::ffff:|::ffff:0:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped) {
    const value = (parseInt(mapped[1]!, 16) << 16) | parseInt(mapped[2]!, 16);
    return isBlockedAddress([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
  }
  return lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:") || lower.startsWith("2002:") || lower.startsWith("fec") || lower.startsWith("ff") || lower.startsWith("::");
}

const defaultLookup: LookupFn = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((row) => row.address);

/** Resolves at connect time and refuses private addresses there, so a name cannot change what it points at between check and use. */
function guardedLookup(resolve: LookupFn, allowed: (address: string, hostname: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    const fail = (message: string, code: string) => callback(Object.assign(new SaveFileError(message), { code }) as NodeJS.ErrnoException, "", 4);
    resolve(hostname).then(
      (addresses) => {
        const usable = addresses.filter((address) => isIP(address));
        if (!usable.length) return fail("That host did not resolve.", "ENOTFOUND");
        if (usable.some((address) => !allowed(address, hostname))) return fail("That link points at a private address, which Ensemble does not fetch.", "EPRIVATE");
        if ((options as { all?: boolean }).all) return callback(null, usable.map((address) => ({ address, family: isIP(address) })));
        return callback(null, usable[0]!, isIP(usable[0]!));
      },
      () => fail("That host did not resolve.", "ENOTFOUND"),
    );
  };
}

/** A link a person or a model gave: http(s), no user name or password. */
export function checkedLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SaveFileError("That link is not a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SaveFileError("Only http and https links can be saved.");
  if (url.username || url.password) throw new SaveFileError("Links with a user name or password are refused.");
  return url;
}

function open(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: "GET", lookup, agent: false, signal, headers: { "user-agent": USER_AGENT, accept: "application/pdf,application/octet-stream,image/*,text/plain;q=0.9,*/*;q=0.8" } }, resolve);
    request.on("error", reject);
    request.end();
  });
}

const tooLarge = (max: number) => new SaveFileError(`That file is larger than the ${Math.round(max / (1024 * 1024))} MB Ensemble Files keeps.`, undefined, 413);

async function readCapped(response: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const part = chunk as Buffer;
    total += part.byteLength;
    if (total > max) {
      response.destroy();
      throw tooLarge(max);
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}

export type Fetched = { bytes: Buffer; url: string; contentType: string; disposition: string | null };

/**
 * Downloads a public file: http(s), every hop's address checked when it connects (no private, loopback
 * or link-local network), at most 5 redirects, at most `maxBytes`. A web page is refused with a hint.
 */
export async function fetchPublicFile(raw: string, maxBytes = maxFileBytes(), deps: SaveFetchDeps = testDeps ?? {}): Promise<Fetched> {
  const allowed = deps.allowAddress ?? ((address: string) => !privateAddress(address));
  const lookup = guardedLookup(deps.lookup ?? defaultLookup, allowed);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = checkedLink(raw);
  for (let hop = 0; ; hop += 1) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allowed(host, host)) throw new SaveFileError("That link points at a private address, which Ensemble does not fetch.");
    let response: IncomingMessage;
    try {
      response = await open(url, lookup, signal);
    } catch (error) {
      if (error instanceof SaveFileError) throw error;
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof SaveFileError) throw cause;
      throw new SaveFileError(signal.aborted ? "That link took too long to answer." : `That link could not be reached (${(error as { code?: string }).code ?? (error as Error).message}).`);
    }
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && status !== 304) {
      response.resume();
      const location = response.headers.location;
      if (!location) throw new SaveFileError("That link redirected without saying where.");
      if (hop >= MAX_REDIRECTS) throw new SaveFileError("That link redirected too many times.");
      url = checkedLink(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      const signIn = status === 401 || status === 403;
      throw new SaveFileError(`That link answered ${status}.`, signIn ? "It may need a sign-in or block automated downloads: download it in the browser with browser_fetch, then save the evidence id it returns." : undefined);
    }
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (/^(text\/html|application\/xhtml\+xml)$/.test(contentType)) {
      response.destroy();
      throw new SaveFileError(WEB_PAGE_HINT, undefined, 415);
    }
    const length = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(length) && length > maxBytes) {
      response.destroy();
      throw tooLarge(maxBytes);
    }
    const bytes = await readCapped(response, maxBytes).catch((error: unknown) => {
      throw error instanceof SaveFileError ? error : new SaveFileError(signal.aborted ? "That download took too long." : "That download stopped before it finished.");
    });
    if (/^\s*<(?:!doctype html|html[\s>]|head[\s>]|body[\s>])/i.test(bytes.subarray(0, 512).toString("latin1"))) throw new SaveFileError(WEB_PAGE_HINT, undefined, 415);
    const disposition = response.headers["content-disposition"];
    return { bytes, url: url.toString(), contentType, disposition: typeof disposition === "string" ? disposition : null };
  }
}

/** The first extension each media type has in Files' formats. */
const EXT_OF_MIME = new Map<string, string>();
for (const format of FILE_FORMATS) if (!EXT_OF_MIME.has(format.mime)) EXT_OF_MIME.set(format.mime, format.ext);
EXT_OF_MIME.set("image/jpg", "jpg");
EXT_OF_MIME.set("application/x-pdf", "pdf");
EXT_OF_MIME.set("text/x-markdown", "md");

/** The format's extension from the file's first bytes, for a server that names neither. */
function sniffedExtension(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (head.startsWith("GIF8")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  return null;
}

/** The name a download says it has: Content-Disposition, else the link's last part. */
function givenName(fetched: Fetched): string {
  const header = fetched.disposition ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header)?.[1];
  for (const value of [star, plain]) {
    if (!value) continue;
    try {
      const name = decodeURIComponent(value.trim());
      if (name) return name;
    } catch {
      if (value.trim()) return value.trim();
    }
  }
  const last = new URL(fetched.url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last) || "download";
  } catch {
    return last || "download";
  }
}

/** Kinds a file's own bytes decide, whatever its name says (a PDF served from `download.php`). */
const BINARY_KINDS = new Set(["pdf", "document", "slides", "sheet", "image", "audio", "video"]);

/** A name with the extension of what the file is: `paper` → `paper.pdf`, `download.php` (a PDF) → `download.php.pdf`. */
export function fileNameFor(name: string, type: { mime?: string | null; bytes?: Buffer }): string {
  const clean = safeFilename(name.trim() || "download");
  const ext = (type.mime ? EXT_OF_MIME.get(type.mime.toLowerCase()) : undefined) ?? (type.bytes ? sniffedExtension(type.bytes) : null);
  if (!ext) return clean;
  const named = fileExtension(clean) ? fileFormat(clean).kind : "other";
  const actual = fileFormat(`x.${ext}`).kind;
  if (named === "other" || (BINARY_KINDS.has(actual) && (named === "code" || named === "text"))) return `${clean.replace(/\.+$/, "")}.${ext}`;
  return clean;
}

function assertKept(filename: string, bytes: Buffer): void {
  const format = fileFormat(filename);
  if (format.ext === "html" || format.ext === "htm") throw new SaveFileError(WEB_PAGE_HINT, undefined, 415);
  const program = fileTypeProblem(filename);
  if (program) throw new SaveFileError(program, undefined, 415);
  if (!KEPT_KINDS.has(format.kind)) {
    throw new SaveFileError(`Ensemble could not tell what kind of file “${filename}” is.`, "Save PDFs, documents, slides, sheets, images, text, audio or video; give a name with its extension (name) if you know it.", 415);
  }
  if (format.kind === "pdf" && !bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    throw new SaveFileError("That link did not give a PDF (it may need a sign-in or show a download page).", "Download it in the browser with browser_fetch, then save the evidence id it returns.", 415);
  }
  assertNewFile(filename, bytes.byteLength);
}

/** "13.6 MB", "820 KB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Saved = { file: FileRecord; existing: boolean };

/** The result a model reads: what was saved, and the only link to give for it. */
export function savedResult(saved: Saved): ToolResult {
  const { file, existing } = saved;
  const link = `ensemble://file/${file.id}`;
  return toolOk(existing ? `“${file.filename}” (${sizeText(file.byteSize)}) is already in Ensemble Files.` : `Saved “${file.filename}” (${sizeText(file.byteSize)}) to Ensemble Files.`, {
    file: { id: file.id, name: file.filename, size: file.byteSize, mime: file.mediaType },
    link,
    ...(existing ? { existing: true } : {}),
    note: `Link it only as [${file.filename.replace(/[[\]]/g, "")}](${link}).`,
  }, { href: `/files/${file.id}`, invalidate: ["documents"] });
}

async function projectTags(prisma: PrismaClient, userId: string, projectId: string | undefined): Promise<{ projectIds: string[] } | undefined> {
  if (!projectId) return undefined;
  const project = await prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null }, select: { id: true } });
  if (!project) throw new SaveFileError("There is no project with that id.", "Use an id from hub_list_projects, or leave projectId out.");
  return { projectIds: [project.id] };
}

async function keep(prisma: PrismaClient, userId: string, file: Parameters<typeof saveFile>[2], projectId: string | undefined): Promise<FileRecord> {
  const tags = await projectTags(prisma, userId, projectId);
  try {
    return await saveFile(prisma, userId, file, tags ? { tags } : {});
  } catch (error) {
    if (error instanceof HostedLimitError) throw new SaveFileError(error.message, "Remove a file in Files (/files) to make room.", 429);
    throw error;
  }
}

/** Saves a public web file in this space's Files; the same file saved from the same link before comes back as it is. */
export async function saveFromUrl(prisma: PrismaClient, userId: string, input: { url: string; name?: string; projectId?: string }): Promise<Saved> {
  const fetched = await fetchPublicFile(input.url);
  const filename = fileNameFor(input.name?.trim() || givenName(fetched), { mime: fetched.contentType, bytes: fetched.bytes });
  assertKept(filename, fetched.bytes);
  const sha256 = createHash("sha256").update(fetched.bytes).digest("hex");
  const kept = await prisma.document.findFirst({ where: { userId, deletedAt: null, sha256, source: { path: ["url"], equals: fetched.url } }, select: FILE_SELECT });
  if (kept) return { file: fileRecord(kept), existing: true };
  const host = new URL(fetched.url).host;
  return { file: await keep(prisma, userId, { filename, mediaType: fetched.contentType, bytes: fetched.bytes, source: { app: "web", label: host, url: fetched.url } }, input.projectId), existing: false };
}

/** Saves evidence the account owns (a capture, a browser download, a file shared from a computer) in this space's Files, once. */
export async function saveFromEvidence(prisma: PrismaClient, userId: string, accountId: string, input: { evidence: string; name?: string; projectId?: string }): Promise<Saved> {
  const row = await prisma.jobEvidence.findFirst({ where: { id: input.evidence, userId: accountId } });
  if (!row) throw new SaveFileError("There is no evidence with that id.", "Use the id a tool returned (browser_fetch, a screenshot, node_share_file).");
  if (row.held) throw new SaveFileError(`“${row.name}” is held on the computer for your owner to preview first.`, "It can be saved once they release it on its card.");
  if (row.local) throw new SaveFileError(`“${row.name}” stayed on the computer: evidence upload is off there.`, "Your owner turns evidence upload on there, or uploads the file to Files themselves.");
  const externalId = `evidence:${row.id}`;
  const kept = await prisma.document.findFirst({ where: { userId, deletedAt: null, source: { path: ["externalId"], equals: externalId } }, select: FILE_SELECT });
  if (kept) return { file: fileRecord(kept), existing: true };
  const bytes = await evidenceContent(row);
  const filename = fileNameFor(input.name?.trim() || row.name, { mime: row.mime, bytes });
  assertKept(filename, bytes);
  const label = row.nodeId ? "Ensemble Node" : "an agent run";
  return { file: await keep(prisma, userId, { filename, mediaType: row.mime, bytes, source: { app: "evidence", label, externalId } }, input.projectId), existing: false };
}

/**
 * A file the owner attached in the chat, which is already in their own Files: in that space it is the
 * same file (tagged with the project when one is named); in another space it is copied there once.
 */
export async function saveFromAttachment(prisma: PrismaClient, userId: string, accountId: string, input: { file: string; name?: string; projectId?: string }): Promise<Saved> {
  const row = await prisma.document.findFirst({ where: { id: input.file, userId: accountId, deletedAt: null }, select: { ...FILE_SELECT, ...ORIGINAL_SELECT, projectIds: true, manualTags: true } });
  if (!row) throw new SaveFileError("That attachment is no longer in your owner's Files.");
  if (userId === accountId) {
    const tags = await projectTags(prisma, userId, input.projectId);
    if (tags && !row.projectIds.includes(tags.projectIds[0]!)) {
      const projectIds = [...row.projectIds, ...tags.projectIds];
      const manual = row.manualTags && typeof row.manualTags === "object" && !Array.isArray(row.manualTags) ? (row.manualTags as Record<string, unknown>) : {};
      await prisma.document.updateMany({ where: { id: row.id, userId }, data: { projectIds, manualTags: { ...manual, projectIds } } });
    }
    return { file: fileRecord(row), existing: true };
  }
  const externalId = `attachment:${row.id}`;
  const kept = await prisma.document.findFirst({ where: { userId, deletedAt: null, source: { path: ["externalId"], equals: externalId } }, select: FILE_SELECT });
  if (kept) return { file: fileRecord(kept), existing: true };
  const bytes = await originalBytes(row);
  const filename = safeFilename(input.name?.trim() || row.filename);
  assertNewFile(filename, bytes.byteLength);
  return { file: await keep(prisma, userId, { filename, mediaType: row.mediaType, bytes, source: { app: "node", label: "Ensemble Node chat", externalId } }, input.projectId), existing: false };
}

const Url = z.string().trim().min(1).max(2000).describe("A public http(s) link straight to the file (a PDF, a document, an image). Not a web page.");
const Evidence = z.string().uuid().describe("An evidence id a tool returned (browser_fetch, a screenshot, node_share_file).");
const Name = z.string().trim().min(1).max(200).describe("The file's name in Files, e.g. “Smith et al. 2024 - CVPR.pdf”. Default: the name it came with.");
const ProjectId = z.string().uuid().describe("Tag the file with this project.");

const one = (input: Record<string, unknown>, keys: readonly string[], ctx: z.RefinementCtx) => {
  const given = keys.filter((key) => input[key] !== undefined);
  if (given.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Give exactly one of ${keys.join(", ")}.` });
};

const HubInput = z
  .object({ url: Url.optional(), evidence: Evidence.optional(), name: Name.optional(), projectId: ProjectId.optional() })
  .strict()
  .superRefine((input, ctx) => one(input, ["url", "evidence"], ctx));
type HubInput = z.infer<typeof HubInput>;

const DESCRIPTION =
  "Save a file into Ensemble Files and get its link: from a public web link straight to the file (url: a PDF, a document, an image), or from evidence you have (evidence: the id browser_fetch, a screenshot or node_share_file returned). " +
  "For a paper or report, find the official source and give its direct PDF link. A web page is refused: give the file's own link, or download it in the browser first (browser_fetch) and save its evidence. " +
  "The result's link (ensemble://file/<id>) is the only link to give for the file; never write one yourself.";

const account = (ctx: ToolContext) => actorFor(ctx.userId) ?? ctx.userId;

async function runSave(ctx: ToolContext, input: { url?: string; evidence?: string; name?: string; projectId?: string }): Promise<ToolResult> {
  await requireVerifiedUser(ctx.userId);
  const saved = input.url ? await saveFromUrl(ctx.prisma, ctx.userId, { url: input.url, name: input.name, projectId: input.projectId }) : await saveFromEvidence(ctx.prisma, ctx.userId, account(ctx), { evidence: input.evidence!, name: input.name, projectId: input.projectId });
  return savedResult(saved);
}

/** The Hub's `hub_save_file`: a write, held or done as the person's write policy says. */
export const saveFileTools: AnyHubTool[] = [
  defineTool({
    name: "hub_save_file",
    area: "context",
    description: DESCRIPTION,
    input: HubInput,
    isWrite: true,
    risk: "low",
    outsideTransaction: true,
    async preview(ctx, input: HubInput) {
      if (input.url) {
        const url = checkedLink(input.url);
        return `Save ${input.name ? `“${input.name}”` : "the file"} from ${url.host} to Files`;
      }
      const row = await ctx.prisma.jobEvidence.findFirst({ where: { id: input.evidence!, userId: account(ctx) }, select: { name: true } });
      if (!row) throw new SaveFileError("There is no evidence with that id.");
      return `Save “${input.name ?? row.name}” to Files`;
    },
    async run(ctx, input: HubInput) {
      return runSave(ctx, input);
    },
  }),
];

/**
 * The same tool for a node's own turn with its owner: saved at once (it only adds a file, so it never
 * waits for Apply, though the owner's write settings and access to the space still decide), and it also
 * takes a `path` on the owner's computer, which `share` brings in as evidence first. node/brain.ts gives
 * it a `space` like every Hub tool.
 */
export function nodeSaveFileTool(options: {
  computerFields: { computer: z.ZodTypeAny; folder: z.ZodTypeAny };
  /** Brings the file in as evidence; or the result to give the node instead (it waits for its owner, or is held). `input` is the whole call, to make again. */
  share: (ctx: ToolContext, input: { path: string; folder?: string; computer?: string; name?: string; projectId?: string }) => Promise<{ evidence: string } | ToolResult>;
  /** The owner's file an attachment names (node/attachments.ts `findAttachment`). */
  attachment: (ctx: ToolContext, ref: string) => Promise<{ id: string }>;
}): AnyHubTool {
  const NodeInput = z
    .object({
      url: Url.optional(),
      evidence: Evidence.optional(),
      attachment: z.string().trim().min(1).max(300).optional().describe("A file your owner attached in this chat: its name (q3.pdf) or id."),
      path: z.string().min(1).max(1000).optional().describe("A file on your owner's computer (with folder; omit folder for your own folder there), e.g. report.pdf."),
      folder: options.computerFields.folder,
      computer: options.computerFields.computer,
      name: Name.optional(),
      projectId: ProjectId.optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
      one(input, ["url", "evidence", "path", "attachment"], ctx);
      if ((input.folder !== undefined || input.computer !== undefined) && input.path === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "folder and computer go with path." });
    });
  return defineTool({
    name: "hub_save_file",
    area: "context",
    description: `${DESCRIPTION} Or path: a file on your owner's computer (after computer_run downloaded it, say); it is brought in and saved. Or attachment: a file your owner attached in this chat (its name, {attachment: "q3.pdf"}); it is already in their Files, so this gives its link, tags it with projectId, or copies it into another space.`,
    input: NodeInput,
    isWrite: true,
    immediate: true,
    risk: "low",
    outsideTransaction: true,
    async run(ctx, input) {
      const values = input as z.infer<typeof NodeInput>;
      if (values.attachment !== undefined) {
        await requireVerifiedUser(ctx.userId);
        const found = await options.attachment(ctx, values.attachment);
        return savedResult(await saveFromAttachment(ctx.prisma, ctx.userId, account(ctx), { file: found.id, name: values.name, projectId: values.projectId }));
      }
      if (values.path === undefined) return runSave(ctx, values);
      const { url: _url, evidence: _evidence, ...call } = values;
      const shared = await options.share(ctx, { ...call, path: values.path, folder: values.folder as string | undefined, computer: values.computer as string | undefined });
      if (!("evidence" in shared)) return shared;
      return runSave(ctx, { evidence: shared.evidence, name: values.name ?? values.path.split(/[\\/]/).pop(), projectId: values.projectId });
    },
  });
}
