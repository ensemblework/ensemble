/**
 * Dropbox: files by name (search), or the newest in the top folder; a file's text
 * when it is a small text file or a Paper doc, otherwise its details; and a file's
 * original bytes (Paper docs and other files without bytes of their own are exported).
 * Ids: Dropbox's file id ("id:…").
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { facts, itemFetch, itemFetchBytes, itemMarkdown, tooLarge } from "../http.js";
import { ItemError, MAX_DOWNLOAD_BYTES, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const LABEL = "Dropbox";
const ID = /^id:[A-Za-z0-9_-]{4,128}$/;
const MAX_TEXT_BYTES = 1_000_000;

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml", "srt", "vtt",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cs", "php", "sh", "sql", "css", "scss",
]);
const PROSE = new Set(["txt", "md", "markdown", "paper"]);
/** Export formats for files Dropbox cannot hand over as they are, most useful first, with the extension each gets. */
const EXPORTS: ReadonlyArray<[format: string, ext: string]> = [
  ["docx", "docx"],
  ["xlsx", "xlsx"],
  ["pptx", "pptx"],
  ["pdf", "pdf"],
  ["markdown", "md"],
  ["plain_text", "txt"],
  ["html", "html"],
];

interface Entry {
  ".tag"?: string;
  id: string;
  name: string;
  path_display?: string;
  server_modified?: string;
  size?: number;
  is_downloadable?: boolean;
  export_info?: { export_as?: string; export_options?: string[] };
}

const auth = (ctx: ItemContext) => ({ Authorization: `Bearer ${ctx.token.token}` });

const rpc = <T>(ctx: ItemContext, path: string, body: unknown) => itemFetch<T>(ctx, "dropbox", LABEL, `${API}${path}`, { method: "POST", headers: auth(ctx), body });

/** Dropbox-API-Arg travels in an HTTP header, so anything outside ASCII is written as \uXXXX. */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export const extensionOf = (name: string) => (/\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1] ?? "").toLowerCase();

export function sizeText(bytes: number | undefined): string | null {
  if (typeof bytes !== "number") return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const folderOf = (path: string | undefined) => (path ? path.slice(0, path.lastIndexOf("/")) || "/" : "");

function webUrl(entry: Entry): string | undefined {
  if (!entry.path_display) return undefined;
  const folder = folderOf(entry.path_display);
  return `https://www.dropbox.com/home${folder === "/" ? "" : folder.split("/").map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(entry.name)}`;
}

function fileItem(entry: Entry): AppItem {
  return {
    source: "dropbox",
    kind: "file",
    id: entry.id,
    title: entry.name,
    subtitle: [folderOf(entry.path_display), sizeText(entry.size)].filter(Boolean).join(" · "),
    url: webUrl(entry),
    updatedAt: entry.server_modified,
  };
}

const isFile = (entry: Entry | undefined): entry is Entry => entry?.[".tag"] === "file" && typeof entry.id === "string";

function exportedName(name: string, ext: string, header: string | null): string {
  try {
    const result = header ? (JSON.parse(header) as { export_metadata?: { name?: string } }) : null;
    if (result?.export_metadata?.name) return result.export_metadata.name;
  } catch {
    // Name it from the original below.
  }
  const base = name.replace(/\.paper$/i, "");
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export const dropboxItems: ItemSource = {
  id: "dropbox",
  provider: "dropbox",
  label: LABEL,
  kinds: ["file"],
  async search(ctx, query) {
    const q = query.q.trim().slice(0, 200);
    if (q) {
      const found = await rpc<{ matches: Array<{ metadata?: { metadata?: Entry } }> }>(ctx, "/files/search_v2", {
        query: q,
        options: { max_results: Math.min(100, query.limit * 2), file_status: "active" },
      });
      return found.matches.map((match) => match.metadata?.metadata).filter(isFile).slice(0, query.limit).map(fileItem);
    }
    const listed = await rpc<{ entries: Entry[] }>(ctx, "/files/list_folder", { path: "", recursive: false, limit: 100 });
    return listed.entries
      .filter(isFile)
      .sort((a, b) => (b.server_modified ?? "").localeCompare(a.server_modified ?? ""))
      .slice(0, query.limit)
      .map(fileItem);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!ID.test(ref.id)) throw new ItemError("That is not a Dropbox file id.", 400);
    const entry = await rpc<Entry>(ctx, "/files/get_metadata", { path: ref.id });
    if (!isFile(entry)) throw new ItemError("That Dropbox item is not a file.", 400);
    const ext = extensionOf(entry.name);
    const options = entry.export_info?.export_options ?? [];
    const exportFormat = entry.is_downloadable === false ? (["markdown", "plain_text"].find((format) => options.includes(format)) ?? (ext === "paper" ? "markdown" : null)) : null;
    let body = "";
    let note = "";
    if (exportFormat) {
      body = await itemFetch<string>(ctx, "dropbox", LABEL, `${CONTENT}/files/export`, {
        method: "POST",
        headers: { ...auth(ctx), "Dropbox-API-Arg": dropboxArg({ path: ref.id, export_format: exportFormat }) },
        text: true,
      });
    } else if (TEXT_EXTENSIONS.has(ext) && (entry.size ?? 0) <= MAX_TEXT_BYTES && entry.is_downloadable !== false) {
      body = await itemFetch<string>(ctx, "dropbox", LABEL, `${CONTENT}/files/download`, {
        method: "POST",
        headers: { ...auth(ctx), "Dropbox-API-Arg": dropboxArg({ path: ref.id }) },
        text: true,
      });
    } else {
      note = TEXT_EXTENSIONS.has(ext) ? "This file is over 1 MB. Open it in Dropbox to read it." : "Open in Dropbox to read this file type.";
    }
    const list = facts({ Folder: folderOf(entry.path_display), Size: sizeText(entry.size), Modified: entry.server_modified?.slice(0, 10) });
    const text = body ? (PROSE.has(ext) || exportFormat ? body : `\`\`\`${ext}\n${body}\n\`\`\``) : note;
    return { ...fileItem(entry), facts: list, text: itemMarkdown(entry.name, list, text) };
  },
  async download(ctx, ref) {
    if (ref.kind !== "file") throw new ItemError("Only Dropbox files can be brought into Files.", 400);
    if (!ID.test(ref.id)) throw new ItemError("That is not a Dropbox file id.", 400);
    const entry = await rpc<Entry>(ctx, "/files/get_metadata", { path: ref.id });
    if (!isFile(entry)) throw new ItemError("That Dropbox item is not a file.", 400);
    if ((entry.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge(LABEL);
    if (entry.is_downloadable === false) {
      const options = entry.export_info?.export_options ?? (extensionOf(entry.name) === "paper" ? ["markdown"] : []);
      const chosen = EXPORTS.find(([format]) => options.includes(format));
      if (!chosen) throw new ItemError("Dropbox cannot hand over this file as it is. Open it in Dropbox and save a copy in another format.", 422);
      const got = await itemFetchBytes(ctx, "dropbox", LABEL, `${CONTENT}/files/export`, {
        method: "POST",
        headers: { ...auth(ctx), "Dropbox-API-Arg": dropboxArg({ path: ref.id, export_format: chosen[0] }) },
      });
      return { filename: exportedName(entry.name, chosen[1], got.headers.get("dropbox-api-result")), mediaType: "application/octet-stream", bytes: got.bytes, url: webUrl(entry) };
    }
    const got = await itemFetchBytes(ctx, "dropbox", LABEL, `${CONTENT}/files/download`, {
      method: "POST",
      headers: { ...auth(ctx), "Dropbox-API-Arg": dropboxArg({ path: ref.id }) },
    });
    return { filename: entry.name, mediaType: "application/octet-stream", bytes: got.bytes, url: webUrl(entry) };
  },
};
