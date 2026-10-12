import { FILE_FORMATS, type FileFormat } from "@ensemble/shared-types";

export type ViewerKind = "pdf" | "docx" | "pptx" | "sheet" | "image" | "audio" | "video" | "text" | "details";

/** Which viewer shows a format. Formats that cannot be previewed get the details card. */
export function viewerFor(format: FileFormat): ViewerKind {
  if (!format.preview) return "details";
  if (format.ext === "pdf") return "pdf";
  if (format.ext === "docx") return "docx";
  if (format.ext === "pptx") return "pptx";
  switch (format.kind) {
    case "sheet":
      return "sheet";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "text":
    case "code":
      return "text";
    default:
      return "details";
  }
}

/** How a file becomes a page: converted here (PDF, Word), or on the server from its text (text, code, CSV). */
export function pageWay(format: FileFormat): "browser" | "server" | null {
  if (format.toPage) return format.toPage;
  return format.ext === "csv" || format.ext === "tsv" ? "server" : null;
}

/** Everything Ensemble knows how to show, for file pickers. Other files are still accepted by drag and drop. */
export const FILE_ACCEPT = FILE_FORMATS.map((format) => `.${format.ext}`).join(",");

export function baseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename).trim() || filename;
}
