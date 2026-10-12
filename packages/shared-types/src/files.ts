/**
 * Files people bring into Ensemble: uploaded or imported from a connected app,
 * kept with their original bytes (context_documents) and their text (a file
 * Artifact) so pages can embed them and the assistant and agents can read them.
 * hub-api: src/files and routes/files.ts. Docs: docs/32_FILES.md.
 */
import type { AppItemKind } from "./app-items.js";

export type FileKind = "pdf" | "document" | "slides" | "sheet" | "image" | "text" | "code" | "audio" | "video" | "other";

export interface FileFormat {
  ext: string;
  kind: FileKind;
  /** The media type Ensemble uses for this extension, whatever the browser said. */
  mime: string;
  label: string;
  /** Shown in Ensemble. False: details and download only. */
  preview: boolean;
  /** "cells": edited in the sheet editor and saved back into the same file. "text": edited as text. */
  edit: "cells" | "text" | null;
  /** How it becomes a page: converted in the browser (pdf, docx) or on the server from its text. */
  toPage: "browser" | "server" | null;
  /** Shown when a format cannot be previewed or edited, e.g. "Save it as .docx to preview it". */
  note?: string;
  /** Prism/CodeMirror language for code files. */
  language?: string;
}

const f = (ext: string, kind: FileKind, mime: string, label: string, more: Partial<FileFormat> = {}): FileFormat => ({
  ext,
  kind,
  mime,
  label,
  preview: true,
  edit: null,
  toPage: null,
  ...more,
});

const code = (ext: string, language: string, label: string, mime = "text/plain"): FileFormat => f(ext, "code", mime, label, { toPage: "server", language });

export const FILE_FORMATS: readonly FileFormat[] = [
  f("pdf", "pdf", "application/pdf", "PDF", { toPage: "browser" }),
  f("docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word document", { toPage: "browser" }),
  f("doc", "document", "application/msword", "Word 97–2003 document", { preview: false, note: "Open it in Word and save it as .docx to preview it here." }),
  f("odt", "document", "application/vnd.oasis.opendocument.text", "OpenDocument text", { preview: false, note: "Save it as .docx to preview it here." }),
  f("rtf", "document", "application/rtf", "Rich text", { preview: false, note: "Save it as .docx to preview it here." }),
  f("pptx", "slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint presentation"),
  f("ppt", "slides", "application/vnd.ms-powerpoint", "PowerPoint 97–2003 presentation", { preview: false, note: "Open it in PowerPoint and save it as .pptx to preview it here." }),
  f("odp", "slides", "application/vnd.oasis.opendocument.presentation", "OpenDocument presentation", { preview: false, note: "Save it as .pptx to preview it here." }),
  f("key", "slides", "application/vnd.apple.keynote", "Keynote presentation", { preview: false, note: "Export it from Keynote as .pptx or PDF to preview it here." }),
  f("xlsx", "sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel workbook", { edit: "cells" }),
  f("xlsm", "sheet", "application/vnd.ms-excel.sheet.macroEnabled.12", "Excel macro workbook", { edit: "cells" }),
  f("xls", "sheet", "application/vnd.ms-excel", "Excel 97–2003 workbook", { note: "Make an .xlsx copy to edit it." }),
  f("ods", "sheet", "application/vnd.oasis.opendocument.spreadsheet", "OpenDocument spreadsheet", { note: "Make an .xlsx copy to edit it." }),
  f("numbers", "sheet", "application/vnd.apple.numbers", "Numbers spreadsheet", { note: "Make an .xlsx copy to edit it." }),
  f("csv", "sheet", "text/csv", "CSV", { edit: "text" }),
  f("tsv", "sheet", "text/tab-separated-values", "TSV", { edit: "text" }),
  f("png", "image", "image/png", "PNG image"),
  f("jpg", "image", "image/jpeg", "JPEG image"),
  f("jpeg", "image", "image/jpeg", "JPEG image"),
  f("gif", "image", "image/gif", "GIF image"),
  f("webp", "image", "image/webp", "WebP image"),
  f("avif", "image", "image/avif", "AVIF image"),
  f("svg", "image", "image/svg+xml", "SVG image"),
  f("bmp", "image", "image/bmp", "Bitmap image"),
  f("ico", "image", "image/x-icon", "Icon"),
  f("heic", "image", "image/heic", "HEIC photo", { preview: false, note: "Most browsers cannot show HEIC photos. Export it as JPEG to preview it here." }),
  f("tif", "image", "image/tiff", "TIFF image", { preview: false, note: "Browsers cannot show TIFF images. Export it as PNG or JPEG to preview it here." }),
  f("tiff", "image", "image/tiff", "TIFF image", { preview: false, note: "Browsers cannot show TIFF images. Export it as PNG or JPEG to preview it here." }),
  f("txt", "text", "text/plain", "Text", { toPage: "server" }),
  f("md", "text", "text/markdown", "Markdown", { toPage: "server" }),
  f("markdown", "text", "text/markdown", "Markdown", { toPage: "server" }),
  f("log", "text", "text/plain", "Log", { toPage: "server" }),
  code("json", "json", "JSON", "application/json"),
  code("jsonl", "json", "JSON lines"),
  code("yaml", "yaml", "YAML"),
  code("yml", "yaml", "YAML"),
  code("toml", "toml", "TOML"),
  code("xml", "xml", "XML"),
  code("html", "html", "HTML"),
  code("htm", "html", "HTML"),
  code("css", "css", "CSS"),
  code("scss", "scss", "SCSS"),
  code("js", "javascript", "JavaScript"),
  code("mjs", "javascript", "JavaScript"),
  code("cjs", "javascript", "JavaScript"),
  code("jsx", "jsx", "JavaScript (JSX)"),
  code("ts", "typescript", "TypeScript"),
  code("tsx", "tsx", "TypeScript (TSX)"),
  code("py", "python", "Python"),
  code("ipynb", "json", "Jupyter notebook"),
  code("r", "r", "R"),
  code("java", "java", "Java"),
  code("kt", "kotlin", "Kotlin"),
  code("swift", "swift", "Swift"),
  code("go", "go", "Go"),
  code("rs", "rust", "Rust"),
  code("rb", "ruby", "Ruby"),
  code("php", "php", "PHP"),
  code("c", "c", "C"),
  code("h", "c", "C header"),
  code("cpp", "cpp", "C++"),
  code("hpp", "cpp", "C++ header"),
  code("cs", "csharp", "C#"),
  code("sql", "sql", "SQL"),
  code("sh", "shell", "Shell script"),
  code("bash", "shell", "Shell script"),
  code("zsh", "shell", "Shell script"),
  code("ps1", "powershell", "PowerShell"),
  code("ini", "ini", "INI"),
  code("cfg", "ini", "Config"),
  code("conf", "ini", "Config"),
  code("env", "ini", "Environment file"),
  code("dockerfile", "dockerfile", "Dockerfile"),
  f("mp3", "audio", "audio/mpeg", "MP3 audio"),
  f("wav", "audio", "audio/wav", "WAV audio"),
  f("m4a", "audio", "audio/mp4", "M4A audio"),
  f("aac", "audio", "audio/aac", "AAC audio"),
  f("ogg", "audio", "audio/ogg", "Ogg audio"),
  f("flac", "audio", "audio/flac", "FLAC audio"),
  f("mp4", "video", "video/mp4", "MP4 video"),
  f("m4v", "video", "video/mp4", "MP4 video"),
  f("mov", "video", "video/quicktime", "QuickTime video"),
  f("webm", "video", "video/webm", "WebM video"),
];

const BY_EXT = new Map(FILE_FORMATS.map((format) => [format.ext, format]));

/** "Report.Final.PDF" → "pdf"; a Dockerfile has no dot but still has a format. */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const OTHER: FileFormat = { ext: "", kind: "other", mime: "application/octet-stream", label: "File", preview: false, edit: null, toPage: null, note: "Ensemble cannot show this kind of file. You can still attach it to pages and download it." };

/** The format for a file name; media types are ignored because browsers and apps disagree about them. */
export function fileFormat(filename: string): FileFormat {
  const ext = fileExtension(filename);
  return BY_EXT.get(ext) ?? { ...OTHER, ext };
}

export const FILE_KIND_LABEL: Readonly<Record<FileKind, string>> = {
  pdf: "PDF",
  document: "Document",
  slides: "Slides",
  sheet: "Spreadsheet",
  image: "Image",
  text: "Text",
  code: "Code",
  audio: "Audio",
  video: "Video",
  other: "File",
};

/** Text extraction state for agents and search. "none": the format has no text (images, audio, video). */
export type FileTextStatus = "ready" | "queued" | "failed" | "none";

export interface FileRecord {
  id: string;
  filename: string;
  /** The media type from FILE_FORMATS (or the upload's, for unknown formats). */
  mediaType: string;
  byteSize: number;
  format: string;
  kind: FileKind;
  sha256: string;
  textStatus: FileTextStatus;
  /** Characters of text agents can read. */
  textCharacters: number;
  /** PDF pages, slides or sheets, when known. */
  pageCount: number | null;
  warnings: string[];
  summary: string | null;
  /** Where it came from when it was imported from a connected app. */
  source: { app: string; label: string; url?: string } | null;
  /** True when a page converted from this file can be exported back with the original's formatting. */
  hasStyle: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Hosted accounts have caps; desktop and local servers do not (null). */
export interface FileUsage {
  count: number;
  bytes: number;
  maxCount: number | null;
  maxBytes: number | null;
  /** Largest single file accepted here. */
  maxFileBytes: number;
}

/** Formatting read from the original when a PDF or Word file becomes a page, used when the page is exported back. Points and #rrggbb. */
export interface FileStyleProfile {
  source: "pdf" | "docx";
  page?: { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } };
  body?: { font: string; size: number; color: string; lineHeight?: number };
  headings?: Partial<Record<"1" | "2" | "3", { font?: string; size: number; color: string; bold?: boolean }>>;
}

/** Cell edits for an .xlsx/.xlsm file, applied to the original so its formatting and other cells stay. Rows and columns are 1-based. */
export interface SheetPatch {
  sheets: Array<{
    name: string;
    set?: Array<{ row: number; col: number; value: string | number | boolean | null }>;
    /** Rows to remove, 1-based, applied after `set` from the bottom up. */
    deleteRows?: number[];
  }>;
}

/** A connected app Ensemble can bring files in from, and whether this person can use it yet. */
export interface FileImportSource {
  /** "google_drive", "gmail", "onedrive", "outlook", "dropbox", "box". */
  id: string;
  /** The app-items source that searches and downloads it ("google_workspace", "microsoft_365", "dropbox", "box"). */
  itemSource: string;
  /** Catalog entry to open for connecting ("google_workspace"…). */
  connector: string;
  name: string;
  logo: string;
  kind: Extract<AppItemKind, "file" | "attachment">;
  state: "ready" | "needs_permission" | "not_connected" | "not_set_up";
  /** One plain sentence for the person: what works, or what to do. */
  message: string;
  /** Short numbered steps for people who have not done this before. */
  steps?: string[];
  /** Where the fix is: Settings → Connections on this connector. */
  action?: { label: string; href: string };
  /** Google Drive: the Google Picker is set up, so the person can pick files without "Search all of Drive". */
  picker?: boolean;
}
