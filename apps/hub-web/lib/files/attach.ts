import type { FileRecord, PageDocument, PageNode } from "@ensemble/shared-types";
import { ApiError, api } from "@/lib/api";

export type PageTarget = { kind: "page" | "task"; id: string; title: string };

function hasFile(nodes: PageNode[] | undefined, id: string): boolean {
  return Boolean(nodes?.some((node) => (node.type === "mention" && node.attrs?.kind === "file" && node.attrs.id === id) || hasFile(node.content, id)));
}

/** The page with a file mention added at the end, or null when the file is already on it. */
export function appendFileMention(doc: PageDocument | null, file: Pick<FileRecord, "id" | "filename">): PageDocument | null {
  const content = [...(doc?.content ?? [])];
  if (hasFile(content, file.id)) return null;
  const last = content.at(-1);
  if (last?.type === "paragraph" && !last.content?.length) content.pop();
  content.push({ type: "paragraph", content: [{ type: "mention", attrs: { kind: "file", id: file.id, label: file.filename } }] });
  return { type: "doc", content };
}

/**
 * Adds the file to the end of a page and saves it. The page may be open elsewhere, so a
 * revision conflict reloads the page and tries again.
 */
export async function attachFileToPage(target: PageTarget, file: Pick<FileRecord, "id" | "filename">): Promise<"attached" | "already"> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = target.kind === "page" ? await api.standalonePage(target.id) : await api.page(target.id);
    const next = appendFileMention(page.content, file);
    if (!next) return "already";
    try {
      if (target.kind === "page") await api.saveStandalonePage(target.id, { revision: page.revision, content: next });
      else await api.savePage(target.id, { revision: page.revision, content: next });
      return "attached";
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409) || attempt === 2) throw error;
    }
  }
  return "attached";
}
