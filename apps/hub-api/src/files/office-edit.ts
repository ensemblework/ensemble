import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { decodeXml } from "../lib/office/extract.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function replaceOfficeText(bytes: Uint8Array, format: "docx" | "pptx", find: string, replacement: string): Uint8Array {
  let size = 0, count = 0;
  const files = unzipSync(bytes, { filter(entry) { size += entry.originalSize; count++; if (size > 40 * 1024 * 1024 || count > 4000) throw new Error("This Office file is too large or complex to edit here."); return true; } });
  let matches = 0;
  const pending = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    if (!(format === "docx" ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/ : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/).test(path)) continue;
    let xml = strFromU8(content);
    xml = xml.replace(format === "docx" ? /<w:p[\s>][\s\S]*?<\/w:p>/g : /<a:p[\s>][\s\S]*?<\/a:p>/g, paragraph => {
      const tokens = [...paragraph.matchAll(/<(w:t|a:t)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)];
      const joined = tokens.map(token => decodeXml(token[2]!)).join("");
      const start = joined.indexOf(find);
      if (start < 0) return paragraph;
      matches++; if (joined.indexOf(find, start + 1) >= 0) matches++;
      let offset = 0, inserted = false;
      const edits: Array<{ start: number; length: number; value: string }> = [];
      for (const token of tokens) {
        const body = decodeXml(token[2]!);
        const a = Math.max(0, start - offset), b = Math.min(body.length, start + find.length - offset);
        if (a < b) { const next = body.slice(0, a) + (inserted ? "" : replacement) + body.slice(b); edits.push({ start: token.index!, length: token[0].length, value: `<${token[1]} xml:space="preserve">${escape(next)}</${token[1]}>` }); inserted = true; }
        offset += body.length;
      }
      for (const edit of edits.reverse()) paragraph = paragraph.slice(0, edit.start) + edit.value + paragraph.slice(edit.start + edit.length);
      return paragraph;
    });
    pending.set(path, xml);
  }
  if (matches !== 1) throw new Error(`The text matched ${matches} places. Choose a longer unique passage.`);
  for (const [path, xml] of pending) files[path] = strToU8(xml);
  return zipSync(files);
}
