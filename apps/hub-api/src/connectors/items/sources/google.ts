/**
 * Google Workspace: Drive files (search, read as text) and Gmail threads (search,
 * read), each only when the connection was granted that product. With the basic
 * Drive access (drive.file) Drive lists only files Ensemble created or the person picked.
 * Ids: Drive file ids and Gmail thread ids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { gmailBody } from "../../../assistant/tools/google/mail-calendar.js";
import { DRIVE_API, DRIVE_FILE_HINT, GMAIL_API } from "../../../assistant/tools/google/meta.js";
import { stripQuoted } from "../../google.js";
import { parseAddressList } from "../../ingest.js";
import { hasScopes, type ProviderToken } from "../../tokens.js";
import { capText, facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const LABEL = "Google Drive";
const G = "https://www.googleapis.com/auth/";
const DRIVE_SCOPES = [`${G}drive.file`, `${G}drive.readonly`, `${G}drive`];
const FULL_DRIVE_SCOPES = [`${G}drive.readonly`, `${G}drive`];
const GMAIL_SCOPES = [`${G}gmail.readonly`, `${G}gmail.modify`, "https://mail.google.com/"];
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const THREAD_MESSAGES = 15;

const MIME = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
} as const;

const KIND_NAME: Record<string, string> = {
  [MIME.document]: "Google Doc",
  [MIME.spreadsheet]: "Google Sheet",
  [MIME.presentation]: "Google Slides",
  [MIME.folder]: "Folder",
  "application/pdf": "PDF",
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
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const THREAD_ID = /^[0-9a-f]{8,40}$/i;

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
  kinds: ["file", "conversation"],
  usable(token) {
    return anyScope(token, DRIVE_SCOPES) || anyScope(token, GMAIL_SCOPES);
  },
  async search(ctx, query) {
    const files = anyScope(ctx.token, DRIVE_SCOPES);
    const mail = anyScope(ctx.token, GMAIL_SCOPES);
    if (query.kind === "file" && !files) throw new ItemError("Drive is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    if (query.kind === "conversation" && !mail) throw new ItemError("Gmail is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
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
    if (ref.kind === "conversation") {
      if (!anyScope(ctx.token, GMAIL_SCOPES)) throw new ItemError("Gmail is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
      return readThread(ctx, ref.id);
    }
    if (!anyScope(ctx.token, DRIVE_SCOPES)) throw new ItemError("Drive is switched off for Google Workspace. Turn it on in Settings → Connections.", 403);
    return readFile(ctx, ref.id);
  },
};
