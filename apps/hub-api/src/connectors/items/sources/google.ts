/**
 * Google Workspace: Drive files (search, read as text, download) and Gmail threads
 * (search, read) and email attachments (search, download), each only when the
 * connection was granted that product. With the basic Drive access (drive.file)
 * Drive lists only files Ensemble created or the person picked.
 * Ids: Drive file ids, Gmail thread ids, and "<messageId>:<partId>" for an attachment
 * (Gmail's own attachment ids are long and change between reads; the part id does not).
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { gmailBody } from "../../../assistant/tools/google/mail-calendar.js";
import { DRIVE_API, DRIVE_FILE_HINT, GMAIL_API } from "../../../assistant/tools/google/meta.js";
import { stripQuoted } from "../../google.js";
import { parseAddressList } from "../../ingest.js";
import { hasScopes, type ProviderToken } from "../../tokens.js";
import { capText, facts, itemFetch, itemFetchBytes, itemFetchLargeJson, itemMarkdown, tooLarge } from "../http.js";
import { ItemError, MAX_DOWNLOAD_BYTES, type ItemContext, type ItemDownload, type ItemSource } from "../types.js";
import { sizeText } from "./dropbox.js";

const LABEL = "Google Drive";
const G = "https://www.googleapis.com/auth/";
/** Any one of these is enough. */
export const DRIVE_SCOPES = [`${G}drive.file`, `${G}drive.readonly`, `${G}drive`];
export const FULL_DRIVE_SCOPES = [`${G}drive.readonly`, `${G}drive`];
export const GMAIL_SCOPES = [`${G}gmail.readonly`, `${G}gmail.modify`, "https://mail.google.com/"];
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const THREAD_MESSAGES = 15;

const MIME = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  drawing: "application/vnd.google-apps.drawing",
  folder: "application/vnd.google-apps.folder",
} as const;

const KIND_NAME: Record<string, string> = {
  [MIME.document]: "Google Doc",
  [MIME.spreadsheet]: "Google Sheet",
  [MIME.presentation]: "Google Slides",
  [MIME.drawing]: "Google Drawing",
  [MIME.folder]: "Folder",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.site": "Google Site",
  "application/vnd.google-apps.shortcut": "Drive shortcut",
  "application/pdf": "PDF",
};

/** Google's own formats have no bytes of their own; they are exported as the matching Office file. */
const EXPORT_AS: Record<string, { mime: string; ext: string }> = {
  [MIME.document]: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  [MIME.spreadsheet]: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  [MIME.presentation]: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  [MIME.drawing]: { mime: "application/pdf", ext: "pdf" },
};

const TEXT_TYPES = ["application/json", "application/xml", "application/x-yaml"];

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  description?: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** For Google's own formats: one download link per format, without the export call's 10 MB cap. */
  exportLinks?: Record<string, string>;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const THREAD_ID = /^[0-9a-f]{8,40}$/i;
const ATTACHMENT_REF = /^([0-9a-f]{8,40}):([0-9][0-9.]{0,30})$/i;

const anyScope = (token: Pick<ProviderToken, "scopes">, scopes: readonly string[]) => scopes.some((scope) => hasScopes(token, [scope]));

/** A Docs, Sheets, Slides or Drive link → the file id. */
export function googleFileRef(text: string): string | null {
  const value = text.trim();
  const match = /^https:\/\/(?:docs|drive)\.google\.com\/(?:[a-z0-9]+\/)*d\/([A-Za-z0-9_-]{10,200})/i.exec(value) ?? /^https:\/\/drive\.google\.com\/.*[?&]id=([A-Za-z0-9_-]{10,200})/i.exec(value);
  return match ? match[1]! : null;
}

const bearer = (ctx: ItemContext) => ({ Authorization: `Bearer ${ctx.token.token}` });
const drive = <T>(ctx: ItemContext, url: string, text = false) => itemFetch<T>(ctx, "google", LABEL, url, { headers: bearer(ctx), text });
const gmail = <T>(ctx: ItemContext, path: string) => itemFetch<T>(ctx, "google", "Gmail", `${GMAIL_API}${path}`, { headers: bearer(ctx) });
const driveQuote = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const header = (message: GmailMessage, name: string) => message.payload?.headers?.find((row) => row.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const threadLink = (id: string) => `https://mail.google.com/mail/u/0/#all/${id}`;
const fromMillis = (value: string | undefined) => (value && /^\d+$/.test(value) ? new Date(Number(value)).toISOString() : undefined);
const partHeader = (part: GmailPart, name: string) => part.headers?.find((row) => row.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** "Q3 plan" exported as docx → "Q3 plan.docx"; a name that already ends that way stays. */
export function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Files attached to a message: named parts with a separate body. Pictures shown inside the email (logos, signatures) are left out. */
export function gmailAttachments(payload: GmailPart | undefined): GmailPart[] {
  const found: GmailPart[] = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    if (part.filename && part.partId && part.body?.attachmentId) {
      const disposition = partHeader(part, "Content-Disposition").trim().toLowerCase();
      const shownInline = (part.mimeType ?? "").startsWith("image/") && (disposition.startsWith("inline") || (Boolean(partHeader(part, "Content-ID")) && !disposition.startsWith("attachment")));
      if (!shownInline) found.push(part);
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return found;
}

function findPart(part: GmailPart | undefined, partId: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, partId);
    if (found) return found;
  }
  return undefined;
}

function attachmentItem(message: GmailMessage, part: GmailPart): AppItem {
  const from = parseAddressList(header(message, "From"))[0];
  const subject = header(message, "Subject") || "(no subject)";
  return {
    source: "google_workspace",
    kind: "attachment",
    id: `${message.id}:${part.partId}`,
    title: part.filename || "Attachment",
    subtitle: [`Attachment in “${subject}” from ${from?.name ?? from?.email ?? "an unknown sender"}`, sizeText(part.body?.size)].filter(Boolean).join(" · ").slice(0, 200),
    url: threadLink(message.threadId ?? message.id),
    updatedAt: fromMillis(message.internalDate),
  };
}

function fileItem(file: DriveFile): AppItem {
  const owner = file.owners?.[0];
  return {
    source: "google_workspace",
    kind: "file",
    id: file.id,
    title: file.name || "Untitled file",
    subtitle: [KIND_NAME[file.mimeType ?? ""] ?? file.mimeType, owner?.displayName ?? owner?.emailAddress].filter(Boolean).join(" · "),
    url: file.webViewLink,
    updatedAt: file.modifiedTime,
  };
}

function threadItem(id: string, messages: GmailMessage[]): AppItem {
  const first = messages[0];
  const last = messages.at(-1);
  const from = last ? parseAddressList(header(last, "From"))[0] : undefined;
  return {
    source: "google_workspace",
    kind: "conversation",
    id,
    title: (first && header(first, "Subject")) || "(no subject)",
    subtitle: ["Email", from?.name ?? from?.email, messages.length > 1 ? `${messages.length} messages` : null].filter(Boolean).join(" · "),
    url: threadLink(id),
    updatedAt: fromMillis(last?.internalDate),
  };
}

async function searchFiles(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const terms = ["trashed = false", `mimeType != ${driveQuote(MIME.folder)}`];
  if (text) terms.push(`name contains ${driveQuote(text)}`);
  const params = new URLSearchParams({
    q: terms.join(" and "),
    orderBy: "modifiedTime desc",
    pageSize: String(limit),
    fields: "files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName,emailAddress))",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const found = await drive<{ files?: DriveFile[] }>(ctx, `${DRIVE_API}/files?${params}`);
  return (found.files ?? []).map(fileItem);
}

async function searchThreads(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const params = new URLSearchParams({ q: text || "in:inbox -category:promotions -category:social", maxResults: String(limit) });
  const found = await gmail<{ threads?: Array<{ id: string }> }>(ctx, `/threads?${params}`);
  const metadata = "format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date";
  const threads = await Promise.all((found.threads ?? []).map((row) => gmail<{ id: string; messages?: GmailMessage[] }>(ctx, `/threads/${encodeURIComponent(row.id)}?${metadata}`)));
  return threads.map((thread) => threadItem(thread.id, thread.messages ?? []));
}

/** Messages with attachments matching the words, newest first; each attachment is one item. */
async function searchAttachments(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const params = new URLSearchParams({ q: ["has:attachment", text].filter(Boolean).join(" "), maxResults: String(limit) });
  const found = await gmail<{ messages?: Array<{ id: string }> }>(ctx, `/messages?${params}`);
  const messages = await Promise.all((found.messages ?? []).map((row) => gmail<GmailMessage>(ctx, `/messages/${encodeURIComponent(row.id)}?format=full`)));
  return messages.flatMap((message) => gmailAttachments(message.payload).map((part) => attachmentItem(message, part))).slice(0, limit);
}

async function attachmentPart(ctx: ItemContext, id: string): Promise<{ message: GmailMessage; part: GmailPart }> {
  const ref = ATTACHMENT_REF.exec(id);
  if (!ref) throw new ItemError("That is not a Gmail attachment id.", 400);
  const message = await gmail<GmailMessage>(ctx, `/messages/${ref[1]}?format=full`);
  const part = findPart(message.payload, ref[2]!);
  if (!part?.body?.attachmentId) throw new ItemError("That attachment is no longer on the email.", 404);
  return { message, part };
}

async function readAttachment(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const { message, part } = await attachmentPart(ctx, id);
  const item = attachmentItem(message, part);
  const list = facts({ Email: header(message, "Subject") || "(no subject)", From: header(message, "From"), Type: part.mimeType, Size: sizeText(part.body?.size) });
  return { ...item, facts: list, text: itemMarkdown(item.title, list, "A file attached to an email. Bring it into Files to read its text.") };
}

async function downloadAttachment(ctx: ItemContext, id: string): Promise<ItemDownload> {
  const { message, part } = await attachmentPart(ctx, id);
  if ((part.body?.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge("Gmail");
  const ref = ATTACHMENT_REF.exec(id)!;
  // Base64 makes the answer about a third larger than the file.
  const body = await itemFetchLargeJson<{ data?: string }>(ctx, "google", "Gmail", `${GMAIL_API}/messages/${ref[1]}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`, {
    headers: bearer(ctx),
    maxBytes: Math.ceil((MAX_DOWNLOAD_BYTES * 4) / 3) + 64 * 1024,
  });
  const bytes = Buffer.from(body.data ?? "", "base64url");
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw tooLarge("Gmail");
  return { filename: part.filename || "Attachment", mediaType: part.mimeType || "application/octet-stream", bytes: new Uint8Array(bytes), url: threadLink(message.threadId ?? message.id) };
}

/** Google's own files may be served from its content hosts; the token never goes there. */
const googleContent = (url: URL) => url.hostname.endsWith(".googleusercontent.com");

/** Only Google's own Docs host is sent the token for an export link. */
function exportLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "docs.google.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** What to call each of Google's formats, the app that opens it, and its Download menu entry. */
const EXPORT_WORDS: Record<string, { noun: string; app: string; menu: string }> = {
  [MIME.document]: { noun: "document", app: "Google Docs", menu: "Microsoft Word (.docx)" },
  [MIME.spreadsheet]: { noun: "spreadsheet", app: "Google Sheets", menu: "Microsoft Excel (.xlsx)" },
  [MIME.presentation]: { noun: "presentation", app: "Google Slides", menu: "Microsoft PowerPoint (.pptx)" },
  [MIME.drawing]: { noun: "drawing", app: "Google Drawings", menu: "PDF document (.pdf)" },
};

/**
 * A Google Doc, Sheet, Slides or Drawing as an Office file or PDF. Drive's export call stops at
 * 10 MB, which decks with pictures pass easily; larger files come through the file's own export
 * link instead, the one Drive's File → Download uses.
 */
async function exportFile(ctx: ItemContext, path: string, file: DriveFile, exported: { mime: string; ext: string }): Promise<Uint8Array> {
  try {
    return (await itemFetchBytes(ctx, "google", LABEL, `${path}/export?mimeType=${encodeURIComponent(exported.mime)}`, { headers: bearer(ctx), redirectTo: googleContent })).bytes;
  } catch (error) {
    if (!(error instanceof ItemError) || error.reason !== "exportSizeLimitExceeded") throw error;
  }
  const words = EXPORT_WORDS[file.mimeType ?? ""] ?? { noun: "file", app: "Google Drive", menu: `.${exported.ext}` };
  const byHand = `Open it in ${words.app}, choose File → Download → ${words.menu}, then upload that file to Files.`;
  const link = exportLink(file.exportLinks?.[exported.mime]);
  if (!link) throw new ItemError(`This ${words.noun} is too large for Google Drive to convert here. ${byHand}`, 413);
  try {
    return (await itemFetchBytes(ctx, "google", LABEL, link, { headers: bearer(ctx), redirectTo: googleContent })).bytes;
  } catch (error) {
    // Ensemble's own size cap already says what to do; anything else gets the way round it.
    if (error instanceof ItemError && error.statusCode === 413) throw error;
    throw new ItemError(`Google Drive could not convert this ${words.noun}${error instanceof ItemError ? ` (${error.message.replace(/\.$/, "")})` : ""}. ${byHand}`, 502);
  }
}

async function downloadFile(ctx: ItemContext, id: string): Promise<ItemDownload> {
  if (!FILE_ID.test(id)) throw new ItemError("That is not a Google Drive file id.", 400);
  const path = `${DRIVE_API}/files/${encodeURIComponent(id)}`;
  const file = await drive<DriveFile>(ctx, `${path}?fields=id,name,mimeType,size,webViewLink,exportLinks&supportsAllDrives=true`);
  const mime = file.mimeType ?? "";
  const name = file.name || "Untitled file";
  if (mime === MIME.folder) throw new ItemError("That is a Drive folder. Pick a file inside it.", 400);
  const exported = EXPORT_AS[mime];
  if (exported) {
    const bytes = await exportFile(ctx, path, file, exported);
    return { filename: withExtension(name, exported.ext), mediaType: exported.mime, bytes, url: file.webViewLink };
  }
  if (mime.startsWith("application/vnd.google-apps.")) throw new ItemError(`${KIND_NAME[mime] ?? "This kind of Google file"} cannot be downloaded. Open it in Google Drive.`, 422);
  if (Number(file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge(LABEL);
  const got = await itemFetchBytes(ctx, "google", LABEL, `${path}?alt=media&supportsAllDrives=true`, { headers: bearer(ctx), redirectTo: googleContent });
  return { filename: name, mediaType: mime || got.contentType || "application/octet-stream", bytes: got.bytes, url: file.webViewLink };
}

/** The file's text, or null when it is not a kind Ensemble reads here. */
async function fileText(ctx: ItemContext, file: DriveFile): Promise<string | null> {
  const id = encodeURIComponent(file.id);
  const mime = file.mimeType ?? "";
  const exportAs = (type: string) => drive<string>(ctx, `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(type)}`, true);
  if (mime === MIME.document) {
    try {
      return await exportAs("text/markdown");
    } catch (error) {
      if (!(error instanceof ItemError) || error.statusCode !== 424) throw error;
      return exportAs("text/plain");
    }
  }
  if (mime === MIME.spreadsheet) return exportAs("text/csv");
  if (mime === MIME.presentation) return exportAs("text/plain");
  if ((mime.startsWith("text/") || TEXT_TYPES.includes(mime)) && Number(file.size ?? 0) <= MAX_TEXT_FILE_BYTES) {
    return drive<string>(ctx, `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`, true);
  }
  return null;
}

async function readFile(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!FILE_ID.test(id)) throw new ItemError("That is not a Google Drive file id.", 400);
  const file = await drive<DriveFile>(ctx, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,description,modifiedTime,webViewLink,owners(displayName,emailAddress)&supportsAllDrives=true`);
  const text = await fileText(ctx, file);
  const owner = file.owners?.[0];
  const list = facts({
    Type: KIND_NAME[file.mimeType ?? ""] ?? file.mimeType,
    Owner: owner?.displayName ?? owner?.emailAddress,
    Modified: file.modifiedTime?.slice(0, 10),
    Size: file.size && !text ? `${Math.ceil(Number(file.size) / 1024)} KB` : null,
  });
  const item = fileItem(file);
  const body = text === null ? `Ensemble cannot read this kind of file as text. Open it in Google Drive to see it.${file.description ? `\n\n${file.description}` : ""}` : text;
  return {
    ...item,
    facts: list,
    people: owner?.displayName ? [{ name: owner.displayName, ...(owner.emailAddress ? { email: owner.emailAddress } : {}) }] : [],
    text: itemMarkdown(item.title, list, body),
  };
}

async function readThread(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!THREAD_ID.test(id)) throw new ItemError("That is not a Gmail thread id.", 400);
  const thread = await gmail<{ id: string; messages?: GmailMessage[] }>(ctx, `/threads/${id}?format=full`);
  const messages = thread.messages ?? [];
  const shown = messages.slice(-THREAD_MESSAGES);
  const people = new Map<string, AppItemPerson>();
  const parts = shown.map((message) => {
    for (const field of ["From", "To", "Cc"]) {
      for (const row of parseAddressList(header(message, field))) if (row.email) people.set(row.email, { name: row.name ?? row.email, email: row.email });
    }
    const meta = [`To: ${header(message, "To")}`, header(message, "Cc") ? `Cc: ${header(message, "Cc")}` : ""].filter(Boolean).join("\n");
    return `## ${header(message, "From") || "Unknown sender"} · ${header(message, "Date")}\n${meta}\n\n${capText(stripQuoted(gmailBody(message.payload)), 4000)}`;
  });
  const item = threadItem(thread.id, messages);
  const list = facts({ Messages: messages.length, Shown: messages.length > shown.length ? `latest ${shown.length}` : null, Participants: [...people.values()].slice(0, 8).map((row) => row.name).join(", ") });
  return { ...item, facts: list, people: [...people.values()], text: itemMarkdown(item.title, list, parts.join("\n\n")) };
}

export const googleItems: ItemSource = {
  id: "google_workspace",
  provider: "google",
  label: LABEL,
  kinds: ["file", "conversation", "attachment"],
  usable(token) {
    return anyScope(token, DRIVE_SCOPES) || anyScope(token, GMAIL_SCOPES);
  },
  async search(ctx, query) {
    const files = anyScope(ctx.token, DRIVE_SCOPES);
    const mail = anyScope(ctx.token, GMAIL_SCOPES);
    if (query.kind === "file" && !files) throw new ItemError("Drive is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    if ((query.kind === "conversation" || query.kind === "attachment") && !mail) throw new ItemError("Gmail is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    // Attachments are searched only when asked for; a search without a kind stays files and emails.
    if (query.kind === "attachment") return searchAttachments(ctx, query.q.trim().slice(0, 200), query.limit);
    const direct = googleFileRef(query.q);
    if (direct && files && query.kind !== "conversation") return [hit(await readFile(ctx, direct))];
    const text = query.q.trim().slice(0, 200);
    const out: AppItem[] = [];
    if (files && query.kind !== "conversation") out.push(...(await searchFiles(ctx, text, query.limit)));
    if (mail && query.kind !== "file") out.push(...(await searchThreads(ctx, text, query.kind ? query.limit : Math.min(5, query.limit))));
    if (!out.length && files && query.kind !== "conversation" && !anyScope(ctx.token, FULL_DRIVE_SCOPES)) {
      throw new ItemError(`Google Drive found nothing${text ? ` for “${text}”` : ""}: ${DRIVE_FILE_HINT}. Turn on Search all of Drive in Settings → Connections to search everything.`, 404);
    }
    return out;
  },
  async read(ctx, ref) {
    if (ref.kind === "conversation" || ref.kind === "attachment") {
      if (!anyScope(ctx.token, GMAIL_SCOPES)) throw new ItemError("Gmail is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
      return ref.kind === "attachment" ? readAttachment(ctx, ref.id) : readThread(ctx, ref.id);
    }
    if (!anyScope(ctx.token, DRIVE_SCOPES)) throw new ItemError("Drive is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    return readFile(ctx, ref.id);
  },
  async download(ctx, ref) {
    if (ref.kind === "attachment") {
      if (!anyScope(ctx.token, GMAIL_SCOPES)) throw new ItemError("Gmail is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
      return downloadAttachment(ctx, ref.id);
    }
    if (ref.kind !== "file") throw new ItemError("Only Drive files and email attachments can be brought into Files.", 400);
    if (!anyScope(ctx.token, DRIVE_SCOPES)) throw new ItemError("Drive is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    return downloadFile(ctx, ref.id);
  },
};
