import { FILE_FORMATS, FILE_KIND_LABEL, fileFormat, type FileKind } from "@ensemble/shared-types";

/** Item kinds the Context Artifacts tile lists, by name. */
export const ARTIFACT_KIND_LABEL: Readonly<Record<string, string>> = {
  email: "Email",
  chat_msg: "Chat",
  channel_msg: "Channel",
  event: "Event",
  transcript: "Transcript",
  transcript_segment: "Transcript",
  file: "File",
  pr: "Pull request",
  pr_comment: "Review",
  commit: "Commit",
  issue: "Issue",
  meeting_note: "Note",
};

const APP_TYPES: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.folder": "Folder",
};

const BY_MIME = new Map<string, string>();
for (const format of FILE_FORMATS) if (!BY_MIME.has(format.mime)) BY_MIME.set(format.mime, format.label);

const FAMILIES = new Set<FileKind>(["image", "audio", "video", "text"]);

function fromFileType(value: string): string | null {
  const type = value.split(";")[0]!.trim();
  if (!type) return null;
  // Some apps give a type name ("Google Doc") rather than a media type.
  if (!type.includes("/")) return type;
  const mime = type.toLowerCase();
  const known = APP_TYPES[mime] ?? BY_MIME.get(mime);
  if (known) return known;
  const family = mime.split("/")[0] as FileKind;
  return FAMILIES.has(family) ? FILE_KIND_LABEL[family] : null;
}

/**
 * What an item is, for its card: the item kind, or for a file its real type ("PDF",
 * "Word document", "Google Doc") from its extension, then the media type its app gave.
 */
export function artifactTypeLabel(row: { kind: string; title: string; format?: string | null; fileType?: string | null }): string {
  if (row.kind !== "file") return ARTIFACT_KIND_LABEL[row.kind] ?? row.kind.replaceAll("_", " ");
  const ext = (row.format ?? "").trim().replace(/^\./, "").toLowerCase();
  const named = fileFormat(ext ? `file.${ext}` : row.title);
  if (named.kind !== "other") return named.label;
  const typed = row.fileType ? fromFileType(row.fileType) : null;
  if (typed) return typed;
  return named.ext && named.ext.length <= 5 ? named.ext.toUpperCase() : "File";
}

/** The card's "type · source" line, without repeating the type when the source only names the kind. */
export function artifactLine(row: { kind: string; title: string; source: string; format?: string | null; fileType?: string | null }): string {
  const type = artifactTypeLabel(row);
  const source = row.source.trim();
  const repeats = !source || [type, row.kind, row.kind.replaceAll("_", " "), ARTIFACT_KIND_LABEL[row.kind] ?? ""].some((word) => word.toLowerCase() === source.toLowerCase());
  return repeats ? type : `${type} · ${source}`;
}
