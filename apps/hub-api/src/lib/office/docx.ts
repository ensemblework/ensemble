/** Markdown → .docx with real Word headings, lists, tables and links (npm `docx`, MIT). */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { parseMarkdown, type Inline } from "./markdown.js";

const NUMBERS = "ensemble-numbers";
const CODE_FONT = "Consolas";

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function runs(inlines: readonly Inline[], extra: { bold?: boolean; italics?: boolean } = {}): ParagraphChild[] {
  return inlines.map((piece) => {
    const run = new TextRun({
      text: piece.text,
      bold: piece.bold || extra.bold || undefined,
      italics: piece.italic || extra.italics || undefined,
      strike: piece.strike || undefined,
      font: piece.code ? CODE_FONT : undefined,
      style: piece.link ? "Hyperlink" : undefined,
    });
    return piece.link ? new ExternalHyperlink({ link: piece.link, children: [run] }) : run;
  });
}

function numberingLevels() {
  const formats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  return Array.from({ length: 6 }, (_unused, level) => ({
    level,
    format: formats[level % formats.length]!,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

export function markdownToDocxDocument(markdown: string, title = ""): Document {
  const children: Array<Paragraph | Table> = [];
  let listInstance = 0;
  for (const block of parseMarkdown(markdown)) {
    switch (block.kind) {
      case "heading":
        children.push(new Paragraph({ heading: HEADINGS[block.level - 1], children: runs(block.inlines) }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(block.inlines) }));
        break;
      case "quote":
        children.push(new Paragraph({ indent: { left: 720 }, children: runs(block.inlines, { italics: true }) }));
        break;
      case "rule":
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
              children: [new TextRun({ text: line, font: CODE_FONT })],
            }),
          );
        }
        break;
      case "list": {
        listInstance += 1;
        for (const item of block.items) {
          children.push(
            item.ordered
              ? new Paragraph({ numbering: { reference: NUMBERS, level: item.depth, instance: listInstance }, children: runs(item.inlines) })
              : new Paragraph({ bullet: { level: item.depth }, children: runs(item.inlines) }),
          );
        }
        break;
      }
      case "table": {
        const row = (cells: readonly Inline[][], header: boolean) =>
          new TableRow({
            tableHeader: header,
            children: cells.map((cell) => new TableCell({ children: [new Paragraph({ children: runs(cell, header ? { bold: true } : {}) })] })),
          });
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [row(block.header, true), ...block.rows.map((cells) => row(cells, false))],
          }),
        );
        // Word joins two adjacent tables; an empty paragraph keeps them apart.
        children.push(new Paragraph({ children: [] }));
        break;
      }
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [] }));
  return new Document({
    title: title || undefined,
    creator: "Ensemble",
    numbering: { config: [{ reference: NUMBERS, levels: numberingLevels() }] },
    sections: [{ children }],
  });
}

export async function markdownToDocx(markdown: string, title = ""): Promise<Buffer> {
  return Packer.toBuffer(markdownToDocxDocument(markdown, title));
}
