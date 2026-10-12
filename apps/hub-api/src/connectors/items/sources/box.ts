/**
 * Box: files by name (search), or the ones you used most recently; a file's text when
 * it is a small text file or Box has extracted its text (documents, PDFs), otherwise
 * its details; and a file's original bytes. Ids: Box's numeric file id.
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { facts, itemFetch, itemFetchBytes, itemMarkdown, tooLarge } from "../http.js";
import { ItemError, MAX_DOWNLOAD_BYTES, type ItemContext, type ItemSource } from "../types.js";
import { extensionOf, sizeText, TEXT_EXTENSIONS } from "./dropbox.js";

const API = "https://api.box.com/2.0";
const LABEL = "Box";
const ID = /^\d{1,20}$/;
const MAX_TEXT_BYTES = 1_000_000;
const FIELDS = "id,type,name,size,modified_at,extension,path_collection";

interface BoxFile {
  type: string;
  id: string;
  name: string;
  size?: number;
  modified_at?: string;
  extension?: string;
  description?: string;
  path_collection?: { entries?: Array<{ id: string; name: string }> };
  representations?: {
    entries?: Array<{
      representation?: string;
      info?: { url?: string };
      status?: { state?: string };
      content?: { url_template?: string };
    }>;
  };
}

const auth = (ctx: ItemContext) => ({ Authorization: `Bearer ${ctx.token.token}` });

const get = <T>(ctx: ItemContext, path: string, headers: Record<string, string> = {}) => itemFetch<T>(ctx, "box", LABEL, `${API}${path}`, { headers: { ...auth(ctx), ...headers } });

/** Box hands back representation links; the token only ever goes to Box's own hosts. */
function boxUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "api.box.com" || url.hostname.endsWith(".boxcloud.com")) ? url.toString() : null;
  } catch {
    return null;
  }
}

const folderOf = (file: BoxFile) =>
  (file.path_collection?.entries ?? [])
    .filter((folder) => folder.id !== "0")
    .map((folder) => folder.name)
    .join("/");

function fileItem(file: BoxFile): AppItem {
  return {
    source: "box",
    kind: "file",
    id: file.id,
    title: file.name,
    subtitle: [folderOf(file) || "All Files", sizeText(file.size)].filter(Boolean).join(" · "),
    url: `https://app.box.com/file/${file.id}`,
    updatedAt: file.modified_at,
  };
}

/** "https://app.box.com/file/123" → "123". */
export function boxFileId(text: string): string | null {
  return /box\.com\/file\/(\d{1,20})/i.exec(text.trim())?.[1] ?? null;
}

export const boxItems: ItemSource = {
  id: "box",
  provider: "box",
  label: LABEL,
  kinds: ["file"],
  async search(ctx, query) {
    const direct = boxFileId(query.q);
    if (direct) return [fileItem(await get<BoxFile>(ctx, `/files/${direct}?fields=${FIELDS}`))];
    const q = query.q.trim().slice(0, 200);
    if (q) {
      const found = await get<{ entries: BoxFile[] }>(ctx, `/search?query=${encodeURIComponent(q)}&type=file&limit=${query.limit}&fields=${FIELDS}`);
      return found.entries.filter((file) => file.type === "file").map(fileItem);
    }
    const recent = await get<{ entries: Array<{ item?: BoxFile }> }>(ctx, `/recent_items?limit=${query.limit}&fields=${FIELDS}`);
    return recent.entries
      .map((row) => row.item)
      .filter((file): file is BoxFile => file?.type === "file")
      .map(fileItem);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!ID.test(ref.id)) throw new ItemError("That is not a Box file id.", 400);
    const file = await get<BoxFile>(ctx, `/files/${ref.id}?fields=${FIELDS},description,representations`, { "X-Rep-Hints": "[extracted_text]" });
    const ext = (file.extension || extensionOf(file.name)).toLowerCase();
    let body = "";
    let note = "";
    if (TEXT_EXTENSIONS.has(ext) && (file.size ?? 0) <= MAX_TEXT_BYTES) {
      body = await itemFetch<string>(ctx, "box", LABEL, `${API}/files/${ref.id}/content`, { headers: auth(ctx), text: true });
    } else {
      const extracted = file.representations?.entries?.find((row) => row.representation === "extracted_text");
      const content = boxUrl(extracted?.content?.url_template?.replace("{+asset_path}", ""));
      if (extracted?.status?.state === "success" && content) {
        body = await itemFetch<string>(ctx, "box", LABEL, content, { headers: auth(ctx), text: true });
      } else if (extracted) {
        // Asking for the representation's info starts Box's text extraction.
        const info = boxUrl(extracted.info?.url);
        if (info) await itemFetch(ctx, "box", LABEL, info, { headers: auth(ctx) }).catch(() => null);
        note = "Box is still extracting this file's text. Read it again in a minute.";
      } else {
        note = "Open in Box to read this file type.";
      }
    }
    const list = facts({ Folder: folderOf(file) || "All Files", Size: sizeText(file.size), Modified: file.modified_at?.slice(0, 10) });
    const text = [file.description ?? "", body || note].filter(Boolean).join("\n\n");
    return { ...fileItem(file), facts: list, text: itemMarkdown(file.name, list, text) };
  },
  async download(ctx, ref) {
    if (ref.kind !== "file") throw new ItemError("Only Box files can be brought into Files.", 400);
    if (!ID.test(ref.id)) throw new ItemError("That is not a Box file id.", 400);
    const file = await get<BoxFile>(ctx, `/files/${ref.id}?fields=${FIELDS}`);
    if (file.type !== "file") throw new ItemError("That Box item is not a file.", 400);
    if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge(LABEL);
    // Box answers with a redirect to its download host; only Box's own hosts are followed, without the token.
    const got = await itemFetchBytes(ctx, "box", LABEL, `${API}/files/${ref.id}/content`, { headers: auth(ctx), redirectTo: (url) => url.hostname.endsWith(".boxcloud.com") });
    if (got.status === 202) throw new ItemError("Box is still preparing this file. Try again in a minute.", 503);
    return { filename: file.name, mediaType: got.contentType || "application/octet-stream", bytes: got.bytes, url: `https://app.box.com/file/${file.id}` };
  },
};
