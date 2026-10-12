/**
 * Microsoft 365: OneDrive files (search, read as text) and Outlook mail (search,
 * read one message), each only when the connection was granted that product.
 * Ids: OneDrive item ids ("driveId/itemId" for an item shared from another drive)
 * and Outlook message ids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { officeKind, officeText } from "../../../lib/office/extract.js";
import { stripQuoted } from "../../google.js";
import { GRAPH, odata } from "../../microsoft.js";
import { ConnectorNotConnectedError, hasScopes, type ProviderToken } from "../../tokens.js";
import { capText, facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const LABEL = "OneDrive and Outlook";
const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log)$/i;
const FILE_FIELDS = "id,name,size,file,folder,webUrl,lastModifiedDateTime,lastModifiedBy,parentReference";
const MESSAGE_FIELDS = "id,subject,from,receivedDateTime,webLink,bodyPreview";

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

const PART = /^[A-Za-z0-9!_.-]{1,200}$/;
const MESSAGE_ID = /^[A-Za-z0-9=_+/-]{10,400}$/;

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
  kinds: ["file", "conversation"],
  usable(token) {
    return canFiles(token) || canMail(token);
  },
  async search(ctx, query) {
    const files = canFiles(ctx.token);
    const mail = canMail(ctx.token);
    if (query.kind === "file" && !files) throw new ItemError("OneDrive is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    if (query.kind === "conversation" && !mail) throw new ItemError("Outlook mail is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
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
    if (ref.kind === "conversation") {
      if (!canMail(ctx.token)) throw new ItemError("Outlook mail is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
      return readMessage(ctx, ref.id);
    }
    if (!canFiles(ctx.token)) throw new ItemError("OneDrive is switched off for Microsoft 365. Turn it on in Settings → Connections.", 403);
    return readFile(ctx, ref.id);
  },
};
