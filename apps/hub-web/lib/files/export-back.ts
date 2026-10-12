import type { FileRecord, PageDocument } from "@ensemble/shared-types";
import { filesApi } from "@/lib/api-files";
import { blocksFromPage } from "@/lib/export/document";
import { saveBlob, toPdf } from "@/lib/export/formats";
import { rebuildDocx } from "./docx-template";

export type ExportBackFormat = "pdf" | "docx";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Formats a page made from this file can be exported back to with the original's formatting. */
export function exportBackFormats(file: Pick<FileRecord, "format" | "hasStyle">): ExportBackFormat[] {
  if (file.format === "pdf") return file.hasStyle ? ["pdf"] : [];
  if (file.format === "docx") return ["docx"];
  return [];
}

/** A title as a file name: characters Windows and macOS refuse are replaced, the rest kept. */
export function downloadName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) || "Untitled";
  return `${base}.${extension}`;
}

/** Builds the PDF or Word file from the page with the original's formatting and downloads it. */
export async function exportBack(input: { title: string; doc: PageDocument; fileId: string; format: ExportBackFormat }): Promise<void> {
  const blocks = blocksFromPage(input.doc);
  if (input.format === "pdf") {
    const { style } = await filesApi.style(input.fileId);
    const blob = await toPdf({ title: input.title, blocks }, { style: style ?? { source: "pdf" } });
    saveBlob(blob, downloadName(input.title, "pdf"));
    return;
  }
  const original = new Uint8Array(await filesApi.original(input.fileId));
  const bytes = rebuildDocx(original, blocks);
  saveBlob(new Blob([bytes as BlobPart], { type: DOCX_TYPE }), downloadName(input.title, "docx"));
}
