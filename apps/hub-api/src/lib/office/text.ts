/** Plain text helpers shared by the app readers. */

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h\d|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_all, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Clipped {
  text: string;
  offset: number;
  total: number;
  /** Set when there is more; pass it back as `offset` to read on. */
  nextOffset?: number;
}

/** One window of a long text. Cuts on a line break when one is near. */
export function clip(text: string, offset = 0, max = 5000): Clipped {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  let end = Math.min(total, start + max);
  if (end < total) {
    const lineBreak = text.lastIndexOf("\n", end);
    if (lineBreak > start + max * 0.6) end = lineBreak + 1;
  }
  return { text: text.slice(start, end), offset: start, total, ...(end < total ? { nextOffset: end } : {}) };
}
