/**
 * Microsoft 365: OneDrive files (search, read as text, download) and Outlook mail
 * (search, read one message) and email attachments (search, download), each only
 * when the connection was granted that product.
 * Ids: OneDrive item ids ("driveId/itemId" for an item shared from another drive),
 * Outlook message ids, and "<messageId>:<key>" for an attachment, where the key is a
 * short hash of Outlook's attachment id (the full pair is too long for an item id).
 */
import { createHash } from "node:crypto";
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { officeKind, officeText } from "../../../lib/office/extract.js";
import { stripQuoted } from "../../google.js";
import { GRAPH, odata } from "../../microsoft.js";
import { ConnectorNotConnectedError, hasScopes, type ProviderToken } from "../../tokens.js";
import { capText, facts, itemFetch, itemFetchBytes, itemFetchLargeJson, itemMarkdown, tooLarge } from "../http.js";
import { ItemError, MAX_DOWNLOAD_BYTES, type ItemContext, type ItemDownload, type ItemSource } from "../types.js";
import { sizeText } from "./dropbox.js";

const LABEL = "OneDrive and Outlook";
const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log)$/i;
const FILE_FIELDS = "id,name,size,file,folder,webUrl,lastModifiedDateTime,lastModifiedBy,parentReference";
const MESSAGE_FIELDS = "id,subject,from,receivedDateTime,webLink,bodyPreview";
const ATTACHMENT_FIELDS = "id,name,contentType,size,isInline";
const FILE_ATTACHMENT = "#microsoft.graph.fileAttachment";

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { driveId?: string; path?: string };
  remoteItem?: { id: string; parentReference?: { driveId?: string } };
}

interface Address {
  emailAddress?: { name?: string; address?: string };
}

interface Message {
  id: string;
  subject?: string;
  from?: Address;
  toRecipients?: Address[];
  ccRecipients?: Address[];
  receivedDateTime?: string;
  webLink?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
}

interface Attachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

const PART = /^[A-Za-z0-9!_.-]{1,200}$/;
const MESSAGE_ID = /^[A-Za-z0-9=_+/-]{10,400}$/;
const ATTACHMENT_REF = /^([A-Za-z0-9=_+/-]{10,400}):([0-9a-f]{16})$/;

export const attachmentKey = (attachmentId: string) => createHash("sha256").update(attachmentId).digest("hex").slice(0, 16);

const canFiles = (token: Pick<ProviderToken, "scopes">) => hasScopes(token, ["Files.Read"]);
const canMail = (token: Pick<ProviderToken, "scopes">) => hasScopes(token, ["Mail.Read"]);

/** A OneDrive or SharePoint sharing link → the address for Graph's /shares. */
export function shareId(text: string): string | null {
  const value = text.trim();
  if (!/^https:\/\/(?:onedrive\.live\.com|1drv\.ms|[a-z0-9-]+(?:-my)?\.sharepoint\.com)\//i.test(value)) return null;
  return `u!${Buffer.from(value).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
}

/** An Outlook web link (…?ItemID=…) → the message id. */
export function outlookMessageRef(text: string): string | null {
  const value = text.trim();
  if (!/^https:\/\/(?:outlook\.office(?:365)?\.com|outlook\.live\.com)\//i.test(value)) return null;
  const raw = /[?&]ItemID=([^&#]+)/i.exec(value)?.[1];
  if (!raw) return null;
  const id = decodeURIComponent(raw);
  return MESSAGE_ID.test(id) ? id : null;
}

function itemPath(id: string): string {
  const parts = id.split("/");
  if (parts.length === 2 && parts.every((part) => PART.test(part))) return `/drives/${encodeURIComponent(parts[0]!)}/items/${encodeURIComponent(parts[1]!)}`;
  if (parts.length === 1 && PART.test(id)) return `/me/drive/items/${encodeURIComponent(id)}`;
  throw new ItemError("That is not a OneDrive file id.", 400);
}

const graph = <T>(ctx: ItemContext, label: string, path: string, headers: Record<string, string> = {}, text = false) =>
  itemFetch<T>(ctx, "microsoft", label, `${GRAPH}${path}`, { headers: { Authorization: `Bearer ${ctx.token.token}`, ...headers }, text });

/** File bytes for Office extraction; itemFetch reads bodies as text. */
async function download(ctx: ItemContext, path: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await ctx.fetch(`${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${ctx.token.token}` },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
  } catch {
    throw new ItemError("Could not download that file from OneDrive. Try again in a moment.", 502);
  }
  if (response.status === 401) throw new ConnectorNotConnectedError("microsoft", "OneDrive no longer accepts the saved sign-in. Connect it again in Settings → Connections.");
  if (!response.ok) throw new ItemError(`OneDrive would not hand over that file (${response.status}).`, response.status === 404 ? 404 : 424);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OFFICE_BYTES) throw new ItemError("That file is too large to read here.", 413);
  return bytes;
}

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const address = (row: Address | undefined) => row?.emailAddress?.address ?? "";
const named = (row: Address | undefined) => (row?.emailAddress?.name && row.emailAddress.address ? `${row.emailAddress.name} <${row.emailAddress.address}>` : (row?.emailAddress?.name ?? address(row)));

function fileItem(item: DriveItem, id = item.id): AppItem {
  const folder = (item.parentReference?.path ?? "").replace(/^\/drive\/root:?/, "") || null;
  return {
    source: "microsoft_365",
    kind: "file",
    id,
    title: item.name || "Untitled file",
    subtitle: [item.folder ? "Folder" : "OneDrive", folder, item.lastModifiedBy?.user?.displayName].filter(Boolean).join(" · ").slice(0, 160),
    url: item.webUrl,
    updatedAt: item.lastModifiedDateTime,
  };
}

function messageItem(message: Message): AppItem {
  return {
    source: "microsoft_365",
    kind: "conversation",
    id: message.id,
    title: message.subject || "(no subject)",
    subtitle: ["Email", message.from?.emailAddress?.name ?? address(message.from)].filter(Boolean).join(" · "),
    url: message.webLink,
    updatedAt: message.receivedDateTime,
  };
}

async function searchFiles(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const select = odata({ $top: limit, $select: FILE_FIELDS });
  if (text) {
    const found = await graph<{ value?: DriveItem[] }>(ctx, "OneDrive", `/me/drive/root/search(q='${encodeURIComponent(text.replace(/'/g, "''"))}')?${select}`);
    return (found.value ?? []).map((item) => fileItem(item));
  }
  try {
    const recent = await graph<{ value?: DriveItem[] }>(ctx, "OneDrive", `/me/drive/recent?${odata({ $top: limit })}`);
    return (recent.value ?? [])
      .filter((item) => !item.folder)
      .map((item) => fileItem(item, item.remoteItem?.parentReference?.driveId ? `${item.remoteItem.parentReference.driveId}/${item.remoteItem.id}` : item.id));
  } catch (error) {
    if (!(error instanceof ItemError)) throw error;
    const top = await graph<{ value?: DriveItem[] }>(ctx, "OneDrive", `/me/drive/root/children?${select}`);
    return (top.value ?? []).map((item) => fileItem(item));
  }
}

async function searchMail(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const path = text
    ? `/me/messages?${odata({ $search: `"${text.replace(/["\\]/g, " ")}"`, $top: limit, $select: MESSAGE_FIELDS })}`
    : `/me/mailFolders/inbox/messages?${odata({ $top: limit, $orderby: "receivedDateTime desc", $select: MESSAGE_FIELDS })}`;
  const found = await graph<{ value?: Message[] }>(ctx, "Outlook", path);
  return (found.value ?? []).map(messageItem);
}

function attachmentItem(message: Message, attachment: Attachment): AppItem {
  const from = message.from?.emailAddress?.name || address(message.from) || "an unknown sender";
  return {
    source: "microsoft_365",
    kind: "attachment",
    id: `${message.id}:${attachmentKey(attachment.id)}`,
    title: attachment.name || "Attachment",
    subtitle: [`Attachment in “${message.subject || "(no subject)"}” from ${from}`, sizeText(attachment.size)].filter(Boolean).join(" · ").slice(0, 200),
    url: message.webLink,
    updatedAt: message.receivedDateTime,
  };
}

/** Files attached to the message. Linked items and cloud links have no bytes to hand over; pictures shown inside the email are left out. */
const fileAttachments = (rows: Attachment[] | undefined) =>
  (rows ?? []).filter((row) => row["@odata.type"] === FILE_ATTACHMENT && !(row.isInline && (row.contentType ?? "").startsWith("image/")));

async function listAttachments(ctx: ItemContext, messageId: string): Promise<Attachment[]> {
  const found = await graph<{ value?: Attachment[] }>(ctx, "Outlook", `/me/messages/${encodeURIComponent(messageId)}/attachments?${odata({ $select: ATTACHMENT_FIELDS })}`);
  return found.value ?? [];
}

async function searchAttachments(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  // Outlook search cannot be combined with $filter, so the attachment condition goes into the search words.
  const path = text
    ? `/me/messages?${odata({ $search: `"hasAttachments:true ${text.replace(/["\\]/g, " ")}"`, $top: limit, $select: `${MESSAGE_FIELDS},hasAttachments` })}`
    : `/me/messages?${odata({ $filter: "hasAttachments eq true", $top: limit, $select: `${MESSAGE_FIELDS},hasAttachments` })}`;
  const found = await graph<{ value?: Message[] }>(ctx, "Outlook", path);
  const messages = (found.value ?? []).filter((message) => message.hasAttachments !== false);
  const lists = await Promise.all(messages.map(async (message) => fileAttachments(await listAttachments(ctx, message.id)).map((row) => attachmentItem(message, row))));
  return lists.flat().slice(0, limit);
}

async function attachmentRef(ctx: ItemContext, id: string): Promise<{ message: Message; attachment: Attachment }> {
  const ref = ATTACHMENT_REF.exec(id);
  if (!ref) throw new ItemError("That is not an Outlook attachment id.", 400);
  const messageId = ref[1]!;
  const [message, rows] = await Promise.all([
    graph<Message>(ctx, "Outlook", `/me/messages/${encodeURIComponent(messageId)}?${odata({ $select: "id,subject,from,receivedDateTime,webLink" })}`),
    listAttachments(ctx, messageId),
  ]);
  const attachment = rows.find((row) => attachmentKey(row.id) === ref[2]);
  if (!attachment) throw new ItemError("That attachment is no longer on the email.", 404);
  return { message, attachment };
}

async function readAttachment(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const { message, attachment } = await attachmentRef(ctx, id);
  const item = attachmentItem(message, attachment);
  const list = facts({ Email: message.subject || "(no subject)", From: named(message.from), Type: attachment.contentType, Size: sizeText(attachment.size) });
  return { ...item, facts: list, text: itemMarkdown(item.title, list, "A file attached to an email. Bring it into Files to read its text.") };
}

async function downloadAttachment(ctx: ItemContext, id: string): Promise<ItemDownload> {
  const { message, attachment } = await attachmentRef(ctx, id);
  if (attachment["@odata.type"] !== FILE_ATTACHMENT) {
    throw new ItemError("Outlook only hands over files attached to an email. This one is an attached email or a link; open it in Outlook.", 422);
  }
  if ((attachment.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge("Outlook");
  // Base64 makes the answer about a third larger than the file.
  const full = await itemFetchLargeJson<Attachment>(ctx, "microsoft", "Outlook", `${GRAPH}/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`, {
    headers: { Authorization: `Bearer ${ctx.token.token}` },
    maxBytes: Math.ceil((MAX_DOWNLOAD_BYTES * 4) / 3) + 64 * 1024,
  });
  const bytes = Buffer.from(full.contentBytes ?? "", "base64");
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw tooLarge("Outlook");
  return { filename: attachment.name || "Attachment", mediaType: attachment.contentType || "application/octet-stream", bytes: new Uint8Array(bytes), url: message.webLink };
}

async function downloadFile(ctx: ItemContext, id: string): Promise<ItemDownload> {
  const path = itemPath(id);
  const item = await graph<DriveItem>(ctx, "OneDrive", `${path}?${odata({ $select: FILE_FIELDS })}`);
  if (item.folder || !item.file) throw new ItemError("That is a OneDrive folder. Pick a file inside it.", 400);
  if ((item.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge("OneDrive");
  // /content redirects to a short-lived download address on another host; the token is not sent there.
  const got = await itemFetchBytes(ctx, "microsoft", "OneDrive", `${GRAPH}${path}/content`, { headers: { Authorization: `Bearer ${ctx.token.token}` }, redirectTo: () => true });
  return { filename: item.name || "Untitled file", mediaType: item.file.mimeType || got.contentType || "application/octet-stream", bytes: got.bytes, url: item.webUrl };
}

async function fileText(ctx: ItemContext, item: DriveItem, path: string): Promise<string | null> {
  const name = item.name ?? "";
  const size = item.size ?? 0;
  const kind = officeKind(name, item.file?.mimeType);
  if (kind && size <= MAX_OFFICE_BYTES) {
    const bytes = await download(ctx, `${path}/content`);
    try {
      return await officeText(kind, bytes);
    } catch {
      throw new ItemError(`Ensemble could not read the text of ${name || "that file"}.`, 422);
    }
  }
  if ((TEXT_EXTENSIONS.test(name) || (item.file?.mimeType ?? "").startsWith("text/")) && size <= MAX_TEXT_BYTES) {
    return graph<string>(ctx, "OneDrive", `${path}/content`, {}, true);
  }
  return null;
}

async function readFile(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const path = itemPath(id);
  const item = await graph<DriveItem>(ctx, "OneDrive", `${path}?${odata({ $select: FILE_FIELDS })}`);
  const summary = fileItem(item, id);
  const editor = item.lastModifiedBy?.user;
  const people: AppItemPerson[] = editor?.displayName ? [{ name: editor.displayName, ...(editor.email ? { email: editor.email } : {}) }] : [];
  if (item.folder) {
    const children = await graph<{ value?: DriveItem[] }>(ctx, "OneDrive", `${path}/children?${odata({ $top: 50, $select: "name,folder,lastModifiedDateTime" })}`);
    const list = facts({ Items: item.folder.childCount });
    const lines = (children.value ?? []).map((child) => `- ${child.name ?? ""}${child.folder ? "/" : ""}`);
    return { ...summary, facts: list, people, text: itemMarkdown(summary.title, list, lines.join("\n")) };
  }
  const text = await fileText(ctx, item, path);
  const list = facts({
    Type: item.file?.mimeType,
    "Modified by": editor?.displayName,
    Modified: item.lastModifiedDateTime?.slice(0, 10),
    Size: item.size !== undefined && text === null ? `${Math.ceil(item.size / 1024)} KB` : null,
  });
  const body = text ?? (Number(item.size ?? 0) > MAX_OFFICE_BYTES ? "This file is too large to read here. Open it in OneDrive." : "Ensemble cannot read this kind of file as text. Open it in OneDrive to see it.");
  return { ...summary, facts: list, people, text: itemMarkdown(summary.title, list, body) };
}

async function readMessage(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!MESSAGE_ID.test(id)) throw new ItemError("That is not an Outlook message id.", 400);
  const message = await graph<Message>(
    ctx,
    "Outlook",
    `/me/messages/${encodeURIComponent(id)}?${odata({ $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,webLink,hasAttachments,body" })}`,
    { Prefer: 'outlook.body-content-type="text"' },
  );
  const people = new Map<string, AppItemPerson>();
  for (const row of [message.from, ...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]) {
    const email = address(row);
    if (email) people.set(email.toLowerCase(), { name: row?.emailAddress?.name || email, email });
  }
  const list = facts({
    From: named(message.from),
    To: (message.toRecipients ?? []).map(named).join(", "),
    Cc: (message.ccRecipients ?? []).map(named).join(", "),
    Received: message.receivedDateTime?.slice(0, 16).replace("T", " "),
    Attachments: message.hasAttachments ? "yes" : null,
  });
  const summary = messageItem(message);
  return { ...summary, facts: list, people: [...people.values()], text: itemMarkdown(summary.title, list, capText(stripQuoted(message.body?.content ?? message.bodyPreview ?? ""), 12_000)) };
}

export const microsoftItems: ItemSource = {
  id: "microsoft_365",
  provider: "microsoft",
  label: LABEL,
  kinds: ["file", "conversation", "attachment"],
  usable(token) {
    return canFiles(token) || canMail(token);
  },
  async search(ctx, query) {
    const files = canFiles(ctx.token);
    const mail = canMail(ctx.token);
    if (query.kind === "file" && !files) throw new ItemError("OneDrive is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    if ((query.kind === "conversation" || query.kind === "attachment") && !mail) throw new ItemError("Outlook mail is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    if (query.kind === "attachment") return searchAttachments(ctx, query.q.trim().slice(0, 200), query.limit);
    const share = files && query.kind !== "conversation" ? shareId(query.q) : null;
    if (share) {
      const item = await graph<DriveItem>(ctx, "OneDrive", `/shares/${share}/driveItem?${odata({ $select: FILE_FIELDS })}`);
      return [fileItem(item, item.parentReference?.driveId ? `${item.parentReference.driveId}/${item.id}` : item.id)];
    }
    const message = mail && query.kind !== "file" ? outlookMessageRef(query.q) : null;
    if (message) return [hit(await readMessage(ctx, message))];
    const text = query.q.trim().slice(0, 200);
    const out: AppItem[] = [];
    if (files && query.kind !== "conversation") out.push(...(await searchFiles(ctx, text, query.limit)));
    if (mail && query.kind !== "file") out.push(...(await searchMail(ctx, text, query.kind ? query.limit : Math.min(5, query.limit))));
    return out;
  },
  async read(ctx, ref) {
    if (ref.kind === "conversation" || ref.kind === "attachment") {
      if (!canMail(ctx.token)) throw new ItemError("Outlook mail is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
      return ref.kind === "attachment" ? readAttachment(ctx, ref.id) : readMessage(ctx, ref.id);
    }
    if (!canFiles(ctx.token)) throw new ItemError("OneDrive is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    return readFile(ctx, ref.id);
  },
  async download(ctx, ref) {
    if (ref.kind === "attachment") {
      if (!canMail(ctx.token)) throw new ItemError("Outlook mail is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
      return downloadAttachment(ctx, ref.id);
    }
    if (ref.kind !== "file") throw new ItemError("Only OneDrive files and email attachments can be brought into Files.", 400);
    if (!canFiles(ctx.token)) throw new ItemError("OneDrive is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    return downloadFile(ctx, ref.id);
  },
};
