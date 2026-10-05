/** Where an inline "@ensemble …" prompt sits inside one paragraph. */

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
