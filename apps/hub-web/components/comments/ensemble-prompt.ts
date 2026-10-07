/** Where an inline "@ensemble …" prompt sits inside one paragraph. */
import { PageMention } from "@ensemble/shared-types";
import type { Node } from "@tiptap/pm/model";

export interface EnsembleSlice {
  prompt: string;
  /** Character offset of "@ensemble" in the block. */
  at: number;
  /** Character offset of the caret. Text after this stays in the paragraph. */
  caret: number;
}

/**
 * The prompt is only the text from "@ensemble" up to the caret.
 * Anything after the caret belongs to the rest of the paragraph.
 */
export function ensembleSlice(block: string, caretOffset: number): EnsembleSlice | null {
  const caret = Math.max(0, Math.min(caretOffset, block.length));
  const before = block.slice(0, caret);
  const at = before.toLowerCase().lastIndexOf("@ensemble");
  if (at < 0) return null;
  const prompt = before.slice(at + "@ensemble".length).trim();
  if (!prompt) return null;
  return { prompt, at, caret };
}

export function ensembleNodeRequest(block: Node, caretOffset: number): (EnsembleSlice & { mentions: PageMention[] }) | null {
  const caret = Math.min(caretOffset, block.content.size);
  let at = -1;
  block.forEach((node, offset) => {
    if (!node.isText || offset >= caret) return;
    const text = (node.text ?? "").slice(0, caret - offset);
    for (const match of text.matchAll(/@ensemble(?=\s|:|$)/gi)) at = offset + match.index!;
  });
  if (at < 0) return null;
  const prompt = block.textBetween(at + "@ensemble".length, caret, " ", (node) => node.type.name === "mention" ? `@${node.attrs.label ?? ""}` : "").trim();
  if (!prompt) return null;
  const mentions: PageMention[] = [];
  block.nodesBetween(at, caret, (node) => {
    if (node.type.name !== "mention") return;
    const mention = PageMention.safeParse(node.attrs);
    if (mention.success) mentions.push(mention.data);
  });
  return { at, caret, prompt, mentions };
}
