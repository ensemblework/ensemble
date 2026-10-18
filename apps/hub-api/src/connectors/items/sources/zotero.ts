/**
 * Zotero: references (papers, books, chapters…) and collections in the person's own
 * library and the group libraries saved at connect, through the Zotero Web API v3.
 * A reference reads with its metadata, abstract, tags, collections, child notes,
 * attachment names and an APA citation; a collection reads as a reading list.
 * Posting an update adds a child note to the reference.
 * Ids: the 8-character item or collection key in the person's own library, "<groupID>/<key>" in a group.
 */
import { randomBytes } from "node:crypto";
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { escapeHtml } from "../../../lib/office/html.js";
import { htmlToText } from "../../../lib/office/text.js";
import { ConnectorNotConnectedError } from "../../tokens.js";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.zotero.org";
const WEB = "https://www.zotero.org";
const LABEL = "Zotero";
/** Each search asks every library separately, so only the first few groups are searched. */
const MAX_GROUPS = 5;
const MAX_NOTES = 20;
const NOTE_CHARS = 4_000;
const ABSTRACT_CHARS = 6_000;
const MAX_CREATORS = 20;
const MAX_ATTACHMENTS = 20;
const READING_LIST = 50;

const KEY = /^[A-Z0-9]{8}$/;
const GROUP = /^\d{1,12}$/;

interface Library {
  /** "/users/123" or "/groups/456". */
  prefix: string;
  groupId: number | null;
  name: string;
}

interface Creator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ItemData {
  key: string;
  itemType?: string;
  title?: string;
  caseName?: string;
  nameOfAct?: string;
  subject?: string;
  creators?: Creator[];
  date?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
  extra?: string;
  publicationTitle?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  websiteTitle?: string;
  blogTitle?: string;
  university?: string;
  repository?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstractNote?: string;
  tags?: Array<{ tag?: string }>;
  collections?: string[];
  dateAdded?: string;
  dateModified?: string;
  note?: string;
  contentType?: string;
  filename?: string;
  linkMode?: string;
}

interface ZoteroItem {
  key: string;
  links?: { alternate?: { href?: string } };
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
  data: ItemData;
  /** Formatted with `include=bib`/`citation` and `style`: HTML. */
  bib?: string;
  citation?: string;
}

interface ZoteroCollection {
  key: string;
  links?: { alternate?: { href?: string } };
  meta?: { numCollections?: number; numItems?: number };
  data: { key: string; name?: string; parentCollection?: string | false };
}

interface WriteResult {
  successful?: Record<string, { key?: string }>;
  success?: Record<string, string>;
  failed?: Record<string, { code?: number; message?: string }>;
}

const headers = (ctx: ItemContext) => ({ "Zotero-API-Key": ctx.token.token, "Zotero-API-Version": "3" });

const call = <T>(ctx: ItemContext, path: string, init: ItemRequest = {}) =>
  itemFetch<T>(ctx, "zotero", LABEL, `${API}${path}`, { ...init, headers: { ...headers(ctx), ...init.headers } });

function ownLibrary(ctx: ItemContext): Library {
  const id = Number(ctx.token.meta?.userID ?? ctx.token.extra?.userID);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ConnectorNotConnectedError("zotero", "Connect Zotero again so Ensemble knows whose library to read.");
  return { prefix: `/users/${id}`, groupId: null, name: "My Library" };
}

function savedGroups(ctx: ItemContext): Array<{ id: number; name: string }> {
  const saved = ctx.token.meta?.groups;
  if (!Array.isArray(saved)) return [];
  return (saved as Array<{ id?: unknown; name?: unknown }>)
    .filter((group): group is { id: number; name?: unknown } => typeof group?.id === "number" && Number.isSafeInteger(group.id) && group.id > 0)
    .map((group) => ({ id: group.id, name: typeof group.name === "string" && group.name ? group.name : `Group ${group.id}` }));
}

function groupLibrary(ctx: ItemContext, id: number): Library {
  return { prefix: `/groups/${id}`, groupId: id, name: savedGroups(ctx).find((group) => group.id === id)?.name ?? `Group ${id}` };
}

/** The person's own library (unless the key cannot read it), then the groups saved at connect. */
function libraries(ctx: ItemContext): Library[] {
  const own = ctx.token.meta?.library === false ? [] : [ownLibrary(ctx)];
  return [...own, ...savedGroups(ctx).slice(0, MAX_GROUPS).map((group) => groupLibrary(ctx, group.id))];
}

const joinId = (library: Library, key: string) => (library.groupId ? `${library.groupId}/${key}` : key);

function splitId(ctx: ItemContext, id: string): { library: Library; key: string } {
  const [first = "", second, extra] = id.split("/");
  if (second === undefined && KEY.test(first)) return { library: ownLibrary(ctx), key: first };
  if (extra === undefined && second !== undefined && GROUP.test(first) && KEY.test(second)) return { library: groupLibrary(ctx, Number(first)), key: second };
  throw new ItemError("That is not a Zotero id from a search.", 400);
}

interface ZoteroLink {
  kind: "reference" | "collection";
  key: string;
  /** The numeric group id, or "named" when the link names the group only by its URL name. */
  group: string | null;
}

/**
 * A Zotero link: web library links (zotero.org/<user>/items/<key>, …/collections/<key>,
 * groups/<id>/<name>/items/<key>, groups/<name>/items/<key>) and the desktop app's
 * zotero://select/… links.
 */
function zoteroLink(text: string): ZoteroLink | null {
  const value = text.trim();
  const desktop = /^zotero:\/\/select\/(?:library|groups\/(\d{1,12}))\/(items|collections)\/([A-Z0-9]{8})(?:[/?#]|$)/.exec(value);
  if (desktop) return { kind: desktop[2] === "items" ? "reference" : "collection", key: desktop[3]!, group: desktop[1] ?? null };
  const web = /^https?:\/\/(?:www\.)?zotero\.org\/([^?#\s]+)/i.exec(value);
  if (!web) return null;
  const parts = web[1]!.split("/").filter(Boolean);
  const group = parts[0] === "groups" ? (GROUP.test(parts[1] ?? "") ? parts[1]! : "named") : null;
  const keyAfter = (segment: string): string | null => {
    for (let at = parts.length - 2; at >= 0; at -= 1) {
      if (parts[at] !== segment) continue;
      const next = parts[at + 1] === "itemKey" ? parts[at + 2] : parts[at + 1];
      if (next && KEY.test(next)) return next;
    }
    return null;
  };
  const item = keyAfter("items");
  const key = item ?? keyAfter("collections");
  return key ? { kind: item ? "reference" : "collection", key, group } : null;
}

/** A Zotero link → the item or collection it names, when the link says which library it is in. */
export function zoteroRef(text: string): { kind: "reference" | "collection"; id: string } | null {
  const link = zoteroLink(text);
  if (!link || link.group === "named") return null;
  return { kind: link.kind, id: link.group ? `${link.group}/${link.key}` : link.key };
}

/** "10.48550/arXiv.1706.03762" out of a DOI, a doi.org link or an Extra field line. */
export function zoteroDoi(raw: string | null | undefined): string | null {
  const match = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(raw ?? "");
  return match ? match[1]!.replace(/[.,;)\]]+$/, "") : null;
}

function webUrl(ctx: ItemContext, library: Library, key: string, kind: "items" | "collections", alternate?: string): string | undefined {
  if (alternate && /^https:\/\/www\.zotero\.org\//.test(alternate)) return alternate;
  if (library.groupId) return `${WEB}/groups/${library.groupId}/${kind}/${key}`;
  const username = ctx.token.meta?.username;
  return typeof username === "string" && username ? `${WEB}/${encodeURIComponent(username)}/${kind}/${key}` : undefined;
}

const titleOf = (data: ItemData) => (data.title || data.caseName || data.nameOfAct || data.subject || "Untitled").trim();

/** "journalArticle" → "Journal article". */
const typeLabel = (type: string | undefined) => (type ? type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (first) => first.toUpperCase()) : undefined);

const yearOf = (item: ZoteroItem) => (item.meta?.parsedDate?.slice(0, 4) || /\b(1[5-9]\d\d|20\d\d)\b/.exec(item.data.date ?? "")?.[1]) ?? undefined;

const venueOf = (data: ItemData) => data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.websiteTitle || data.blogTitle || data.university || data.repository || data.publisher || undefined;

const doiOf = (data: ItemData) => zoteroDoi(data.DOI) ?? zoteroDoi(/^DOI:\s*(.+)$/im.exec(data.extra ?? "")?.[1]);

const creatorName = (creator: Creator) => (creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(" ")).trim();

const creatorCite = (creator: Creator) => (creator.name ?? [creator.lastName, creator.firstName].filter(Boolean).join(", ")).trim();

function creatorsLine(creators: Creator[], type: "author" | "editor"): string | undefined {
  const named = creators.filter((creator) => (type === "author" ? creator.creatorType !== "editor" : creator.creatorType === "editor")).map(creatorCite).filter(Boolean);
  if (!named.length) return undefined;
  return named.length > 10 ? `${named.slice(0, 10).join("; ")}; and ${named.length - 10} more` : named.join("; ");
}

/** Formatted citation HTML → Markdown, keeping the style's italics. */
const citationText = (html: string | undefined) => (html ? htmlToText(html.replace(/<\/?i>/gi, "_")) : "");

/** A note's HTML → Markdown-ish text: headings and links survive, everything else is plain. */
function noteText(html: string): string {
  return htmlToText(
    html
      .replace(/<h[1-6]\b[^>]*>/gi, "\n#### ")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<a\b[^>]*\bhref="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)"),
  );
}

/** The person's text as a Zotero note: escaped, one paragraph per blank-line block. */
export function zoteroNoteHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function referenceHit(ctx: ItemContext, library: Library, item: ZoteroItem): AppItem {
  const doi = doiOf(item.data);
  return {
    source: "zotero",
    kind: "reference",
    id: joinId(library, item.key),
    title: titleOf(item.data),
    subtitle: [item.meta?.creatorSummary, yearOf(item), venueOf(item.data), doi ? `doi:${doi}` : null, library.groupId ? library.name : null].filter(Boolean).join(" · "),
    url: webUrl(ctx, library, item.key, "items", item.links?.alternate?.href),
    updatedAt: item.data.dateModified,
  };
}

function collectionHit(ctx: ItemContext, library: Library, collection: ZoteroCollection): AppItem {
  const count = collection.meta?.numItems;
  return {
    source: "zotero",
    kind: "collection",
    id: joinId(library, collection.key),
    title: collection.data?.name || "Untitled collection",
    subtitle: [typeof count === "number" ? `${count} item${count === 1 ? "" : "s"}` : null, library.name].filter(Boolean).join(" · "),
    url: webUrl(ctx, library, collection.key, "collections", collection.links?.alternate?.href),
  };
}

const isReference = (item: ZoteroItem) => item.data.itemType !== "note" && item.data.itemType !== "attachment" && item.data.itemType !== "annotation";

async function searchLibrary(ctx: ItemContext, library: Library, text: string, wants: { references: boolean; collections: boolean }, limit: number) {
  const references: AppItem[] = [];
  const collections: AppItem[] = [];
  if (wants.references) {
    const query = `limit=${Math.min(25, limit)}&sort=dateModified&direction=desc&itemType=-attachment${text ? `&q=${encodeURIComponent(text)}&qmode=everything` : ""}`;
    const found = await call<ZoteroItem[]>(ctx, `${library.prefix}/items/top?${query}`);
    for (const item of Array.isArray(found) ? found : []) if (item?.key && item.data && isReference(item)) references.push(referenceHit(ctx, library, item));
  }
  if (wants.collections) {
    const found = await call<ZoteroCollection[]>(ctx, `${library.prefix}/collections?limit=100`);
    const needle = text.toLowerCase();
    for (const collection of Array.isArray(found) ? found : []) {
      if (collection?.key && (!needle || (collection.data?.name ?? "").toLowerCase().includes(needle))) collections.push(collectionHit(ctx, library, collection));
    }
    collections.sort((a, b) => a.title.localeCompare(b.title));
  }
  return { references, collections };
}

async function readReference(ctx: ItemContext, library: Library, key: string): Promise<AppItemContent> {
  const answer = await call<ZoteroItem>(ctx, `${library.prefix}/items/${key}?include=data,bib,citation&style=apa`);
  const item: ZoteroItem = { ...answer, key: answer.key ?? key, data: answer.data ?? { key } };
  const data = item.data;
  const children = item.meta?.numChildren === 0 ? [] : await call<ZoteroItem[]>(ctx, `${library.prefix}/items/${key}/children?limit=100`).catch(() => [] as ZoteroItem[]);
  const childList = Array.isArray(children) ? children.filter((child) => child?.data) : [];
  const byAdded = (a: ZoteroItem, b: ZoteroItem) => (a.data.dateAdded ?? "").localeCompare(b.data.dateAdded ?? "");
  const notes = childList.filter((child) => child.data.itemType === "note").sort(byAdded);
  const attachments = childList.filter((child) => child.data.itemType === "attachment").sort(byAdded);
  const collectionKeys = data.collections ?? [];
  const collectionNames = collectionKeys.length
    ? await call<ZoteroCollection[]>(ctx, `${library.prefix}/collections?limit=100`)
        .then((rows) => {
          const names = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.key, row.data?.name ?? row.key]));
          return collectionKeys.map((collectionKey) => names.get(collectionKey) ?? collectionKey);
        })
        .catch(() => collectionKeys)
    : [];
  const creators = (data.creators ?? []).slice(0, MAX_CREATORS);
  const doi = doiOf(data);
  const tags = (data.tags ?? []).map((tag) => tag.tag?.trim()).filter((tag): tag is string => Boolean(tag));
  const inText = citationText(item.citation);
  const list = facts({
    Type: typeLabel(data.itemType),
    Authors: creatorsLine(creators, "author"),
    Editors: creatorsLine(creators, "editor"),
    Year: yearOf(item),
    "Published in": venueOf(data),
    Volume: data.volume,
    Issue: data.issue,
    Pages: data.pages,
    DOI: doi ? `https://doi.org/${doi}` : null,
    ISBN: data.ISBN,
    URL: data.url,
    Tags: tags.slice(0, 15).join(", "),
    Collections: collectionNames.join(", "),
    Library: library.groupId ? library.name : null,
    Added: data.dateAdded?.slice(0, 10),
    Notes: notes.length || null,
    Citation: inText,
  });
  const bib = citationText(item.bib);
  const abstract = (data.abstractNote ?? "").trim();
  const ownNote = data.itemType === "note" && data.note ? noteText(data.note) : "";
  const noteBlocks = notes.slice(0, MAX_NOTES).map((note) => {
    const body = noteText(note.data.note ?? "");
    return `### Note${note.data.dateAdded ? ` (${note.data.dateAdded.slice(0, 10)})` : ""}\n\n${body.length > NOTE_CHARS ? `${body.slice(0, NOTE_CHARS)}…` : body}`;
  });
  const attachmentLines = attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => {
    const kind = attachment.data.contentType === "application/pdf" ? "PDF" : attachment.data.contentType;
    const link = attachment.data.linkMode === "linked_url" && attachment.data.url ? attachment.data.url : null;
    return `- ${titleOf(attachment.data)}${kind ? ` (${kind})` : ""}${link ? ` ${link}` : ""}`;
  });
  const body = [
    bib ? `## Citation (APA)\n\n${bib}` : "",
    abstract ? `## Abstract\n\n${abstract.length > ABSTRACT_CHARS ? `${abstract.slice(0, ABSTRACT_CHARS)}…` : abstract}` : "",
    ownNote,
    noteBlocks.length ? `## Notes (${notes.length})\n\n${noteBlocks.join("\n\n")}${notes.length > MAX_NOTES ? `\n\n… ${notes.length - MAX_NOTES} more notes in Zotero.` : ""}` : "",
    attachmentLines.length ? `## Attachments\n\n${attachmentLines.join("\n")}` : "",
  ];
  const people: AppItemPerson[] = creators.map((creator) => ({ name: creatorName(creator), ...(creator.creatorType ? { title: creator.creatorType } : {}) })).filter((person) => person.name);
  const hit = referenceHit(ctx, library, item);
  return { ...hit, facts: list, people, text: itemMarkdown(hit.title, list, body.filter(Boolean).join("\n\n")) };
}

async function readCollection(ctx: ItemContext, library: Library, key: string): Promise<AppItemContent> {
  const collection = await call<ZoteroCollection>(ctx, `${library.prefix}/collections/${key}`);
  const items = await call<ZoteroItem[]>(ctx, `${library.prefix}/collections/${key}/items/top?limit=${READING_LIST}&sort=title&direction=asc&itemType=-attachment&include=data,bib&style=apa`);
  const subcollections = collection.meta?.numCollections
    ? await call<ZoteroCollection[]>(ctx, `${library.prefix}/collections/${key}/collections?limit=50`).catch(() => [] as ZoteroCollection[])
    : [];
  const references = (Array.isArray(items) ? items : []).filter((item) => item?.data && isReference(item));
  const lines = references.map((item) => {
    const url = webUrl(ctx, library, item.key, "items", item.links?.alternate?.href);
    const doi = doiOf(item.data);
    const fallback = [`**${titleOf(item.data)}**`, item.meta?.creatorSummary, yearOf(item) ? `(${yearOf(item)})` : null, venueOf(item.data) ? `_${venueOf(item.data)}_` : null, doi ? `https://doi.org/${doi}` : null].filter(Boolean).join(" ");
    return `- ${citationText(item.bib) || fallback}${url ? ` ([Zotero](${url}))` : ""}`;
  });
  const total = collection.meta?.numItems ?? references.length;
  const subs = (Array.isArray(subcollections) ? subcollections : []).map((row) => row.data?.name).filter((name): name is string => Boolean(name));
  const list = facts({ Items: total, Subcollections: subs.join(", "), Library: library.name });
  const body = [
    lines.length ? `## Reading list (APA)\n\n${lines.join("\n")}${total > lines.length ? `\n\n… ${total - lines.length} more in Zotero.` : ""}` : "This collection has no items yet.",
  ];
  const hit = collectionHit(ctx, library, collection);
  return { ...hit, facts: list, text: itemMarkdown(hit.title, list, body.join("\n\n")) };
}

export const zoteroItems: ItemSource = {
  id: "zotero",
  provider: "zotero",
  label: LABEL,
  kinds: ["reference", "collection"],
  async search(ctx, query) {
    if (query.kind && query.kind !== "reference" && query.kind !== "collection") return [];
    const link = zoteroLink(query.q);
    if (link) {
      if (query.kind && query.kind !== link.kind) return [];
      // A link that names its group only by name is looked for in each saved group.
      const places = link.group === "named" ? libraries(ctx).filter((library) => library.groupId) : [link.group ? groupLibrary(ctx, Number(link.group)) : ownLibrary(ctx)];
      for (const library of places) {
        try {
          if (link.kind === "collection") return [collectionHit(ctx, library, await call<ZoteroCollection>(ctx, `${library.prefix}/collections/${link.key}`))];
          const item = await call<ZoteroItem>(ctx, `${library.prefix}/items/${link.key}`);
          return item?.data ? [referenceHit(ctx, library, { ...item, key: item.key ?? link.key })] : [];
        } catch (error) {
          const elsewhere = error instanceof ItemError && (error.statusCode === 404 || error.statusCode === 403);
          if (!elsewhere || places.length === 1) throw error;
        }
      }
      return [];
    }
    const raw = query.q.trim();
    const text = (zoteroDoi(raw) ?? raw).slice(0, 200);
    const wants = { references: query.kind !== "collection", collections: query.kind === "collection" || (!query.kind && Boolean(text)) };
    const places = libraries(ctx);
    const settled = await Promise.allSettled(places.map((library) => searchLibrary(ctx, library, text, wants, query.limit)));
    const failed = settled.filter((row): row is PromiseRejectedResult => row.status === "rejected");
    if (places.length && failed.length === places.length) throw failed[0]!.reason;
    const found = settled.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    let references = found.flatMap((row) => row.references);
    if (!text) references = references.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const collections = found.flatMap((row) => row.collections);
    if (query.kind === "collection") return collections.slice(0, query.limit);
    if (query.kind === "reference") return references.slice(0, query.limit);
    const few = collections.slice(0, 2);
    return [...references.slice(0, Math.max(1, query.limit - few.length)), ...few];
  },
  async read(ctx, ref) {
    const { library, key } = splitId(ctx, ref.id);
    if (ref.kind === "collection") return readCollection(ctx, library, key);
    if (ref.kind !== "reference") throw new ItemError("Zotero has references and collections here.", 400);
    return readReference(ctx, library, key);
  },
  /** Updates go on references only, so a collection link is not a target. */
  fromUrl(url) {
    const ref = zoteroRef(url);
    return ref?.kind === "reference" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "reference") throw new ItemError("Zotero notes go on a reference, not a collection.", 400);
    const { library, key } = splitId(ctx, ref.id);
    const note = zoteroNoteHtml(body);
    if (!note) throw new ItemError("Write the note first.", 400);
    let result: WriteResult;
    try {
      result = await call<WriteResult>(ctx, `${library.prefix}/items`, {
        method: "POST",
        // Zotero refuses a second write with the same token, so a retried request cannot add the note twice.
        headers: { "Zotero-Write-Token": randomBytes(16).toString("hex") },
        body: [{ itemType: "note", parentItem: key, note, tags: [] }],
      });
    } catch (error) {
      if (error instanceof ItemError && error.statusCode === 403) {
        throw new ItemError(
          `This Zotero key can't add notes${library.groupId ? ` in ${library.name}` : ""}. At zotero.org/settings/keys, edit the key and tick Allow write access${library.groupId ? " for this group" : ""}, then post again.`,
          403,
        );
      }
      throw error;
    }
    const failure = Object.values(result.failed ?? {})[0];
    if (failure || !Object.keys(result.successful ?? result.success ?? {}).length) {
      throw new ItemError(`Zotero did not save the note${failure?.message ? `: ${failure.message.slice(0, 200)}` : "."}`);
    }
    return { url: webUrl(ctx, library, key, "items") };
  },
};
