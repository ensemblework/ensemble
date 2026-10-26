import { z } from "zod";
import { strToU8 } from "fflate";
import { jsPDF } from "jspdf";
import { patchOfficeText } from "../../files/extract.js";
import { ORIGINAL_SELECT, originalBytes } from "../../files/originals.js";
import { fileFormat } from "@ensemble/shared-types";
import { markdownToDocx } from "../../lib/office/docx.js";
import { editablePage } from "../../pages/store.js";
import { pageMarkdown } from "../../pages/markdown.js";
import { PageDocument } from "@ensemble/shared-types";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk, type ToolContext } from "../types.js";


async function original(ctx: ToolContext, id: string) {
  // The same route gate controls shared-file access before server-side bytes are opened.
  const details = await assistantRequest(ctx, "GET", `/api/documents/${id}`);
  const row = await ctx.prisma.document.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { ...ORIGINAL_SELECT, filename: true, sha256: true, byteSize: true } });
  if (!row) throw new Error("File not found.");
  if (row.byteSize > 15 * 1024 * 1024) throw new Error("This file is too large for an assistant edit. Edit it in its original app and upload it again.");
  return { row, file: details.file };
}

const Cell = z.object({ row: z.number().int().min(1).max(1048576), col: z.number().int().min(1).max(16384), value: z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()]) });
const Input = z.object({ fileId: z.string().uuid(), expectedSha256: z.string().length(64), action: z.enum(["replace_text", "edit_cells"]), find: z.string().min(1).max(10000).optional(), replacement: z.string().max(10000).optional(), sheets: z.array(z.object({ name: z.string().min(1).max(200), set: z.array(Cell).max(1000).optional(), deleteRows: z.array(z.number().int().positive()).max(100).optional() })).max(30).optional() });

export const fileEditTools = [
  defineTool({ name: "hub_file_edit_info", area: "context", description: "Read a file's format, content hash and editing options before changing its original. Open the file itself with hub_view_file. The hash is required by hub_edit_file.", input: z.object({ fileId: z.string().uuid() }), isWrite: false, risk: "low", async run(ctx, input) { const result = await assistantRequest(ctx, "GET", `/api/documents/${input.fileId}`); const row = await ctx.prisma.document.findFirst({ where: { id: input.fileId, userId: ctx.userId, deletedAt: null }, select: { sha256: true } }); return toolOk("Read file editing details.", { file: result.file, expectedSha256: row?.sha256 }); } }),
  defineTool({ name: "hub_edit_file", area: "context", description: "Edit an original uploaded file after reading it: replace one unique passage in Word, PowerPoint or text/code/CSV files, keeping Office formatting; or edit spreadsheet cells/rows. Requires hash from hub_file_edit_info. Sheet coordinates are 1-based. Unsupported/complex files are refused.", input: Input, isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
    async preview(ctx, input) { const { row } = await original(ctx, input.fileId); if (row.sha256 !== input.expectedSha256) throw new Error("The file changed. Read it again."); if (input.action === "replace_text" && !input.find) throw new Error("Send find and replacement."); if (input.action === "edit_cells" && !input.sheets?.length) throw new Error("Send the sheet edits."); return `Edit original “${row.filename}”: ${input.action === "replace_text" ? `${input.find} → ${input.replacement ?? ""}` : JSON.stringify(input.sheets)}. Existing attachments use the changed file.`; },
    async run(ctx, input) {
      const { row } = await original(ctx, input.fileId);
      if (row.sha256 !== input.expectedSha256) throw new Error("The file changed. Read it again.");
      let result;
      if (input.action === "edit_cells") result = await assistantRequest(ctx, "POST", `/api/documents/${input.fileId}/cells`, { sheets: input.sheets, expectedSha256: input.expectedSha256 });
      else {
        if (!input.find) throw new Error("Send the exact passage to replace.");
        const format = fileFormat(row.filename);
        const current = await originalBytes(row);
        let bytes: Uint8Array;
        if (format.ext === "docx" || format.ext === "pptx") bytes = await patchOfficeText(current, format.ext, input.find, input.replacement ?? "");
        else if (["text", "code", "csv", "tsv"].includes(format.kind) || ["csv", "tsv"].includes(format.ext)) { const body = new TextDecoder("utf-8", { fatal: true }).decode(current); if (body.indexOf(input.find) < 0 || body.indexOf(input.find) !== body.lastIndexOf(input.find)) throw new Error("Choose an exact passage that occurs once."); bytes = strToU8(body.replace(input.find, () => input.replacement ?? "")); }
        else throw new Error("Use spreadsheet cell edits, or convert this document to a page and export it. This format cannot be edited as text.");
        result = await assistantRequest(ctx, "PUT", `/api/documents/${input.fileId}/content`, { dataBase64: Buffer.from(bytes).toString("base64"), expectedSha256: input.expectedSha256 });
      }
      return toolOk(`Updated “${row.filename}”.`, { id: result.file.id, filename: result.file.filename }, { href: `/files/${input.fileId}`, invalidate: ["documents", "files", "context"] });
    }
  }),
  defineTool({ name: "hub_file_to_page", area: "context", description: "Convert a supported file into an editable Ensemble page. Text/code/CSV use the original; PDF/Word use Markdown supplied after opening the file with hub_view_file. Keeps the original file attached.", input: z.object({ fileId: z.string().uuid(), title: z.string().max(200).optional(), markdown: z.string().max(100000).optional() }), isWrite: true, risk: "low", outsideTransaction: true,
    async preview(ctx, input) { const result = await assistantRequest(ctx, "GET", `/api/documents/${input.fileId}`); return `Make an editable page from “${result.file.filename}”.`; },
    async run(ctx, input) { const { markdownPage } = await import("./pages.js"); const result = await assistantRequest(ctx, "POST", `/api/documents/${input.fileId}/page`, { title: input.title, ...(input.markdown !== undefined ? { content: markdownPage(input.markdown) } : {}) }); return toolOk("Created a page from the file.", { id: result.pageId }, { href: `/pages/${result.pageId}`, invalidate: ["pages"] }); }
  }),
  defineTool({ name: "hub_export_page_file", area: "context", description: "Save a page as a Word, PDF, Markdown or text file in Files. Optionally replace an existing file of that format using its content hash. Word export rebuilds formatting from the page; original advanced layout may differ.", input: z.object({ pageId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), format: z.enum(["docx", "pdf", "md", "txt"]), filename: z.string().max(200), replaceFileId: z.string().uuid().optional(), expectedSha256: z.string().length(64).optional() }), isWrite: true, risk: "medium", outsideTransaction: true, alwaysHold: true,
    preview(_ctx, input) { return `${input.replaceFileId ? "Replace original file" : "Save a file"}: ${input.filename} (${input.format}); formatting is rebuilt from the page.`; },
    async run(ctx, input) {
      if (!input.pageId && !input.taskId) throw new Error("Choose a page or task.");
      if (input.replaceFileId && !input.expectedSha256) throw new Error("Read the target file hash first.");
      const { page, task } = await editablePage(ctx.prisma, ctx.userId, input.pageId ? { pageId: input.pageId } : { taskId: input.taskId! });
      const body = pageMarkdown(page?.content ? PageDocument.parse(page.content) : null, task?.notes ?? page?.notesSnapshot ?? "");
      if (!input.filename.toLowerCase().endsWith(`.${input.format}`)) throw new Error("The filename must match the chosen format.");
      let bytes: Buffer;
      if (input.format === "docx") bytes = await markdownToDocx(body, task?.title ?? page?.title ?? "");
      else if (input.format === "pdf") {
        if (/[^\u0000-\u024f\u2000-\u206f]/.test(body)) throw new Error("Use Word export for this document's characters; the PDF export's standard fonts cannot render them reliably.");
        const pdf = new jsPDF({ unit: "pt", format: "a4" });
        pdf.setFont("helvetica"); pdf.setFontSize(11);
        const lines = pdf.splitTextToSize(body.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-"), 499) as string[];
        let y = 48;
        for (const line of lines) { if (y > 794) { pdf.addPage(); y = 48; } pdf.text(line, 48, y); y += 16; }
        bytes = Buffer.from(pdf.output("arraybuffer"));
      } else bytes = Buffer.from(body);
      const result = await assistantRequest(ctx, input.replaceFileId ? "PUT" : "POST", input.replaceFileId ? `/api/documents/${input.replaceFileId}/content` : "/api/documents", { filename: input.filename, dataBase64: bytes.toString("base64"), expectedSha256: input.expectedSha256, summarize: false });
      return toolOk("Saved the exported file.", { id: result.file.id }, { href: `/files/${result.file.id}`, invalidate: ["files", "documents"] });
    }
  }),
];
