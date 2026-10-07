/** Google Drive (list, read) and Google Docs (create, append, replace). */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { officeKind, officeText } from "../../../lib/office/extract.js";
import { markdownToHtml } from "../../../lib/office/html.js";
import { inlineText, outline, parseMarkdown, wordCount, type Inline } from "../../../lib/office/markdown.js";
import { clip } from "../../../lib/office/text.js";
import { defineTool, toolOk, type ToolContext } from "../../types.js";
import { UNTRUSTED_NOTE, AppRequestError, appAccess, appFetch, appToken, multipartRelated, plural, quote, whose } from "../apps-common.js";
import { DOCS_API, DOCS_WRITE, DRIVE_API, DRIVE_FILE_HINT, DRIVE_READ, DRIVE_UPLOAD, FULL_DRIVE_SCOPES, docLink } from "./meta.js";

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

const KINDS = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  folder: "application/vnd.google-apps.folder",
} as const;

const KIND_NAMES: Record<string, string> = {
  [KINDS.document]: "Google Doc",
  [KINDS.spreadsheet]: "Google Sheet",
  [KINDS.presentation]: "Google Slides",
  [KINDS.pdf]: "PDF",
  [KINDS.folder]: "folder",
};

const driveQuote = (text: string): string => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export const driveListFiles = defineTool({
  name: "drive_list_files",
  area: "apps",
  app: DRIVE_READ,
  description: "List Google Drive files Ensemble can open, newest first, optionally matching a search.",
  input: z.object({
    query: z.string().max(200).optional().describe("Words in the file name or text."),
    kind: z.enum(["any", "document", "spreadsheet", "presentation", "pdf", "folder"]).default("any"),
    max: z.number().int().min(1).max(50).default(20),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const access = await appAccess(ctx, DRIVE_READ);
    const terms = ["trashed = false"];
    if (input.kind !== "any") terms.push(`mimeType = ${driveQuote(KINDS[input.kind])}`);
    if (input.query?.trim()) terms.push(`(name contains ${driveQuote(input.query.trim())} or fullText contains ${driveQuote(input.query.trim())})`);
    const params = new URLSearchParams({
      q: terms.join(" and "),
      pageSize: String(input.max),
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress))",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    // Drive refuses to sort a full-text search.
    if (!input.query?.trim()) params.set("orderBy", "modifiedTime desc");
    const body = await appFetch<{ files?: DriveFile[] }>(ctx, DRIVE_READ, access.token, `${DRIVE_API}/files?${params}`);
    const files = (body.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      kind: KIND_NAMES[file.mimeType ?? ""] ?? file.mimeType,
      modified: file.modifiedTime,
      owner: file.owners?.[0]?.emailAddress ?? file.owners?.[0]?.displayName,
      link: file.webViewLink,
    }));
    const limited = !access.scopes.some((scope) => FULL_DRIVE_SCOPES.includes(scope));
    return toolOk(`Found ${plural(files.length, "file")} in Google Drive.`, {
      files,
      ...(limited ? { note: `Only files Ensemble created or that the person picked are visible (${DRIVE_FILE_HINT}).` } : {}),
    });
  },
});

async function readDriveText(ctx: ToolContext, token: string, file: DriveFile): Promise<string | null> {
  const id = encodeURIComponent(file.id);
  const mime = file.mimeType ?? "";
  const exportAs = (type: string) => appFetch<string>(ctx, DRIVE_READ, token, `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(type)}`, { expect: "text" });
  if (mime === KINDS.document) {
    try {
      return await exportAs("text/markdown");
    } catch (error) {
      if (!(error instanceof AppRequestError) || error.status !== 400) throw error;
      return exportAs("text/plain");
    }
  }
  if (mime === KINDS.spreadsheet) return exportAs("text/csv");
  if (mime === KINDS.presentation) return exportAs("text/plain");
  const media = `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`;
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/x-yaml"].includes(mime)) {
    return appFetch<string>(ctx, DRIVE_READ, token, media, { expect: "text" });
  }
  const kind = officeKind(file.name ?? "", mime);
  if (kind) return officeText(kind, await appFetch<Uint8Array>(ctx, DRIVE_READ, token, media, { expect: "bytes" }));
  return null;
}

export const driveReadFile = defineTool({
  name: "drive_read_file",
  area: "apps",
  app: DRIVE_READ,
  description: "Read a Google Drive file as text: Docs as Markdown, Sheets as CSV, Slides as text, Office files and text files. PDFs return details only.",
  input: z.object({
    fileId: z.string().min(1).max(200),
    offset: z.number().int().min(0).default(0).describe("Character offset for long files; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, DRIVE_READ);
    const file = await appFetch<DriveFile>(
      ctx,
      DRIVE_READ,
      token,
      `${DRIVE_API}/files/${encodeURIComponent(input.fileId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`,
      { notFound: DRIVE_FILE_HINT },
    );
    const details = { id: file.id, name: file.name, kind: KIND_NAMES[file.mimeType ?? ""] ?? file.mimeType, modified: file.modifiedTime, link: file.webViewLink };
    const text = await readDriveText(ctx, token, file);
    if (text === null) {
      return toolOk(`${quote(file.name ?? file.id)} is a ${details.kind ?? "file"} Ensemble cannot read as text here. Open the link to see it.`, details, file.webViewLink ? { href: file.webViewLink } : {});
    }
    const window = clip(text, input.offset, 5000);
    return toolOk(
      `Read ${quote(file.name ?? file.id)} from Google Drive.`,
      {
        ...details,
        text: window.text,
        offset: window.offset,
        total: window.total,
        ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset } : {}),
        note: UNTRUSTED_NOTE,
      },
      file.webViewLink ? { href: file.webViewLink } : {},
    );
  },
});

const Markdown = z.string().min(1).max(100_000).describe("Content in Markdown: headings, lists, tables, bold, links.");

function documentPreviewLines(markdown: string): string {
  const lines = outline(markdown);
  return lines.length ? `\nOutline:\n${lines.map((line) => `- ${line.trim()}`).join("\n")}` : "";
}

export const docsCreate = defineTool({
  name: "docs_create",
  area: "apps",
  app: DOCS_WRITE,
  description: "Create a Google Doc from Markdown (headings, lists, tables, bold and links survive). Returns its link.",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    markdown: Markdown,
    folderId: z.string().max(200).optional().describe("Drive folder id; omit for My Drive."),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const where = await whose(ctx, "google", "Google Drive");
    return `Create Google Doc ${quote(input.title)} in ${where} with ${plural(wordCount(input.markdown), "word")}. Only ${where.startsWith("your") ? "you" : "they"} can open it until it is shared.${documentPreviewLines(input.markdown)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, DOCS_WRITE);
    const boundary = `ensemble-${randomBytes(12).toString("hex")}`;
    const metadata = { name: input.title, mimeType: KINDS.document, ...(input.folderId ? { parents: [input.folderId] } : {}) };
    const file = await appFetch<DriveFile>(ctx, DOCS_WRITE, token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartRelated(boundary, metadata, "text/html; charset=UTF-8", markdownToHtml(input.markdown, input.title)),
    });
    const link = file.webViewLink ?? docLink(file.id);
    return toolOk(`Created the Google Doc ${quote(input.title)}.`, { id: file.id, link }, { href: link });
  },
});

interface DocsParagraph {
  text: string;
  inlines: Inline[];
  heading?: number;
  list?: { ordered: boolean; group: number; depth: number };
  code?: boolean;
  italic?: boolean;
}

function docsParagraphs(markdown: string): DocsParagraph[] {
  const out: DocsParagraph[] = [];
  let group = 0;
  for (const block of parseMarkdown(markdown)) {
    switch (block.kind) {
      case "heading":
        out.push({ text: inlineText(block.inlines), inlines: block.inlines, heading: block.level });
        break;
      case "paragraph":
        out.push({ text: inlineText(block.inlines), inlines: block.inlines });
        break;
      case "quote":
        out.push({ text: inlineText(block.inlines), inlines: block.inlines, italic: true });
        break;
      case "rule":
        out.push({ text: "———", inlines: [{ text: "———" }] });
        break;
      case "code":
        for (const line of block.text.split("\n")) out.push({ text: line, inlines: [{ text: line, code: true }], code: true });
        break;
      case "list": {
        group += 1;
        const ordered = block.items[0]?.ordered ?? false;
        for (const item of block.items) {
          // Docs reads nesting from leading tabs when it makes the bullets, then removes them.
          const tabs = "\t".repeat(item.depth);
          out.push({ text: tabs + inlineText(item.inlines), inlines: [{ text: tabs }, ...item.inlines], list: { ordered, group, depth: item.depth } });
        }
        break;
      }
      case "table":
        out.push({ text: block.header.map(inlineText).join(" | "), inlines: block.header.flatMap((cell, index) => [...(index ? [{ text: " | " }] : []), ...cell.map((piece) => ({ ...piece, bold: true }))]) });
        for (const row of block.rows) {
          out.push({ text: row.map(inlineText).join(" | "), inlines: row.flatMap((cell, index) => [...(index ? [{ text: " | " }] : []), ...cell]) });
        }
        break;
    }
  }
  return out;
}

/**
 * Docs batchUpdate requests that add Markdown at the end of a document.
 * `endIndex` is the body's last endIndex; the final newline stays last. Indexes are UTF-16 units, like JS strings.
 */
export function docsAppendRequests(markdown: string, endIndex: number): Array<Record<string, unknown>> {
  const paragraphs = docsParagraphs(markdown);
  const insertAt = Math.max(1, endIndex - 1);
  const lead = endIndex > 2 ? "\n" : "";
  const text = lead + paragraphs.map((paragraph) => paragraph.text).join("\n");
  if (!paragraphs.length || text === lead) return [];
  const start = insertAt + lead.length;
  // The body's final newline ends up at `end`. Ranges stop before it; Docs rejects ranges that include it.
  const end = insertAt + text.length;
  const upTo = (index: number, from: number) => Math.max(from + 1, Math.min(index, end));
  const requests: Array<Record<string, unknown>> = [
    { insertText: { location: { index: insertAt }, text } },
    { updateParagraphStyle: { range: { startIndex: start, endIndex: upTo(end, start) }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    { deleteParagraphBullets: { range: { startIndex: start, endIndex: upTo(end, start) } } },
    { updateTextStyle: { range: { startIndex: start, endIndex: upTo(end, start) }, textStyle: {}, fields: "bold,italic,strikethrough,link,weightedFontFamily" } },
  ];
  const bullets: Array<{ startIndex: number; endIndex: number; ordered: boolean }> = [];
  let cursor = start;
  paragraphs.forEach((paragraph, index) => {
    const paragraphEnd = cursor + paragraph.text.length;
    if (paragraph.heading && paragraph.text) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: cursor, endIndex: upTo(paragraphEnd + 1, cursor) },
          paragraphStyle: { namedStyleType: `HEADING_${paragraph.heading}` },
          fields: "namedStyleType",
        },
      });
    }
    let offset = cursor;
    for (const piece of paragraph.inlines) {
      const pieceEnd = offset + piece.text.length;
      const style: Record<string, unknown> = {};
      const fields: string[] = [];
      if (piece.bold) (style.bold = true), fields.push("bold");
      if (piece.italic || paragraph.italic) (style.italic = true), fields.push("italic");
      if (piece.strike) (style.strikethrough = true), fields.push("strikethrough");
      if (piece.code) (style.weightedFontFamily = { fontFamily: "Courier New" }), fields.push("weightedFontFamily");
      if (piece.link) (style.link = { url: piece.link }), fields.push("link");
      if (fields.length && pieceEnd > offset) {
        requests.push({ updateTextStyle: { range: { startIndex: offset, endIndex: pieceEnd }, textStyle: style, fields: fields.join(",") } });
      }
      offset = pieceEnd;
    }
    if (paragraph.list) {
      const last = bullets[bullets.length - 1];
      if (last && paragraphs[index - 1]?.list?.group === paragraph.list.group) last.endIndex = upTo(paragraphEnd + 1, last.startIndex);
      else bullets.push({ startIndex: cursor, endIndex: upTo(paragraphEnd + 1, cursor), ordered: paragraph.list.ordered });
    }
    cursor = paragraphEnd + 1;
  });
  // Bullets last and from the bottom up: making them removes the nesting tabs, which shifts later text.
  for (const range of bullets.reverse()) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: range.startIndex, endIndex: range.endIndex },
        bulletPreset: range.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  return requests;
}

interface GoogleDocument {
  documentId?: string;
  title?: string;
  body?: { content?: Array<{ endIndex?: number }> };
}

async function documentTitle(ctx: ToolContext, token: string, documentId: string): Promise<string> {
  const doc = await appFetch<GoogleDocument>(ctx, DOCS_WRITE, token, `${DOCS_API}/${encodeURIComponent(documentId)}?fields=title`, { notFound: DRIVE_FILE_HINT });
  return doc.title ?? documentId;
}

export const docsAppend = defineTool({
  name: "docs_append",
  area: "apps",
  app: DOCS_WRITE,
  description: "Add Markdown to the end of an existing Google Doc, keeping headings, lists, bold and links.",
  input: z.object({ documentId: z.string().min(1).max(200), markdown: Markdown }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const title = await documentTitle(ctx, await appToken(ctx, DOCS_WRITE), input.documentId);
    return `Add ${plural(wordCount(input.markdown), "word")} to the end of the Google Doc ${quote(title)}. Nothing already in it changes.${documentPreviewLines(input.markdown)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, DOCS_WRITE);
    const id = encodeURIComponent(input.documentId);
    const doc = await appFetch<GoogleDocument>(ctx, DOCS_WRITE, token, `${DOCS_API}/${id}?fields=title,body/content/endIndex`, { notFound: DRIVE_FILE_HINT });
    const endIndex = doc.body?.content?.at(-1)?.endIndex ?? 2;
    const requests = docsAppendRequests(input.markdown, endIndex);
    await appFetch(ctx, DOCS_WRITE, token, `${DOCS_API}/${id}:batchUpdate`, { method: "POST", body: { requests } });
    const link = docLink(input.documentId);
    return toolOk(`Added ${plural(wordCount(input.markdown), "word")} to ${quote(doc.title ?? "the document")}.`, { id: input.documentId, link }, { href: link });
  },
});

export const docsReplaceText = defineTool({
  name: "docs_replace_text",
  area: "apps",
  app: DOCS_WRITE,
  description: "Replace every occurrence of some text in a Google Doc. Read it first with drive_read_file.",
  input: z.object({
    documentId: z.string().min(1).max(200),
    replacements: z
      .array(z.object({ find: z.string().min(1).max(500), replace: z.string().max(5000), matchCase: z.boolean().default(true) }))
      .min(1)
      .max(20),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const title = await documentTitle(ctx, await appToken(ctx, DOCS_WRITE), input.documentId);
    const lines = input.replacements.map((row) => `- every ${quote(row.find)} → ${row.replace ? quote(row.replace) : "(removed)"}${row.matchCase ? "" : " (any case)"}`);
    return `In the Google Doc ${quote(title)}, replace:\n${lines.join("\n")}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, DOCS_WRITE);
    const result = await appFetch<{ replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }>(
      ctx,
      DOCS_WRITE,
      token,
      `${DOCS_API}/${encodeURIComponent(input.documentId)}:batchUpdate`,
      {
        method: "POST",
        body: {
          requests: input.replacements.map((row) => ({
            replaceAllText: { containsText: { text: row.find, matchCase: row.matchCase }, replaceText: row.replace },
          })),
        },
      },
    );
    const changed = (result.replies ?? []).reduce((sum, reply) => sum + (reply.replaceAllText?.occurrencesChanged ?? 0), 0);
    const link = docLink(input.documentId);
    return toolOk(
      changed ? `Replaced ${plural(changed, "occurrence")} in the Google Doc.` : "Nothing in the Google Doc matched, so nothing changed.",
      { id: input.documentId, occurrencesChanged: changed, link },
      { href: link },
    );
  },
});

export const googleDocsTools = [driveListFiles, driveReadFile, docsCreate, docsAppend, docsReplaceText];
