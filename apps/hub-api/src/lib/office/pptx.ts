/** Slide specs → .pptx (npm `pptxgenjs`, MIT). Titles, bullets and speaker notes. */
import pptxImport from "pptxgenjs";
import { inlineText, parseInline } from "./markdown.js";

// The package ships ESM at runtime but CommonJS-style types, so TypeScript sees the class under `.default`.
type PptxConstructor = typeof pptxImport.default;
const PptxGenJS: PptxConstructor = (pptxImport as unknown as { default?: PptxConstructor }).default ?? (pptxImport as unknown as PptxConstructor);

export interface SlideSpec {
  title: string;
  bullets?: readonly string[];
  notes?: string;
}

export interface DeckSpec {
  title: string;
  subtitle?: string;
  slides: readonly SlideSpec[];
}

/** Bullets may carry Markdown emphasis and a leading "  " per nesting level. */
export function bulletLevel(bullet: string): { text: string; level: number } {
  const match = /^(\s*)(?:[-*+]\s+)?(.*)$/.exec(bullet) ?? ["", "", bullet];
  return { text: inlineText(parseInline(match[2]!.trim())), level: Math.min(Math.floor(match[1]!.length / 2), 4) };
}

const INK = "1F2933";
const MUTED = "52606D";

export async function slidesToPptx(deck: DeckSpec): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.author = "Ensemble";
  const cover = pptx.addSlide();
  cover.addText(deck.title, { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: INK, align: "left", valign: "middle" });
  if (deck.subtitle) cover.addText(deck.subtitle, { x: 0.8, y: 3.9, w: 11.7, h: 0.9, fontSize: 22, color: MUTED, align: "left", valign: "top" });
  for (const spec of deck.slides) {
    const slide = pptx.addSlide();
    slide.addText(inlineText(parseInline(spec.title)), { x: 0.6, y: 0.4, w: 12.1, h: 1.0, fontSize: 30, bold: true, color: INK, valign: "middle" });
    const bullets = (spec.bullets ?? []).filter((line) => line.trim());
    if (bullets.length) {
      slide.addText(
        bullets.map((line) => {
          const { text, level } = bulletLevel(line);
          return { text, options: { bullet: true, indentLevel: level, breakLine: true } };
        }),
        { x: 0.8, y: 1.6, w: 11.7, h: 5.4, fontSize: 20, color: INK, valign: "top", paraSpaceAfter: 8 },
      );
    }
    if (spec.notes?.trim()) slide.addNotes(spec.notes.trim());
  }
  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}
