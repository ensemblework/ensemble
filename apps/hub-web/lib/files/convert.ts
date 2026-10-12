import { fileFormat, type FileRecord } from "@ensemble/shared-types";
import { filesApi } from "@/lib/api-files";
import { baseName, pageWay } from "./formats";

export type PageConversion = { pageId: string; notice: string };

/**
 * Makes a page from a file. PDF and Word are converted here and send the formatting to
 * keep for exporting back; text, code and CSV are converted on the server.
 */
export async function convertToPage(file: FileRecord, bytes: () => Promise<ArrayBuffer>, onProgress?: (text: string) => void): Promise<PageConversion> {
  const format = fileFormat(file.filename);
  const way = pageWay(format);
  const title = baseName(file.filename);
  if (way === "server") {
    const { pageId } = await filesApi.toPage(file.id, { title });
    return { pageId, notice: `Made a page from ${file.filename}.` };
  }
  if (format.ext === "pdf") {
    onProgress?.("Reading the PDF…");
    const { pdfToPage } = await import("./pdf-to-page");
    const { content, style } = await pdfToPage(await bytes(), (done, total) => onProgress?.(`Reading page ${done} of ${total}…`));
    const { pageId } = await filesApi.toPage(file.id, { title, content, style });
    return {
      pageId,
      notice: "Converted. Export back to PDF keeps the original's page size, margins, sizes and colours.",
    };
  }
  if (format.ext === "docx") {
    onProgress?.("Reading the Word file…");
    const { docxToPage } = await import("./docx-to-page");
    const { content, imagesDropped } = await docxToPage(await bytes());
    const { pageId } = await filesApi.toPage(file.id, { title, content });
    return {
      pageId,
      notice: `Converted. Export back to Word keeps the original's fonts, sizes, colours and page setup.${imagesDropped ? " Images stay in the original file." : ""}`,
    };
  }
  throw new Error(`${format.label} files cannot become pages.`);
}
