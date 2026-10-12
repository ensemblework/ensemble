/**
 * Exporting a page back to Word through the original .docx: its styles, numbering,
 * headers, footers and final section (page size, margins) stay; only the body is
 * rebuilt from the page, using the original's own paragraph and table styles.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Block, Run } from "@/lib/export/document";

const W_MAIN = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const NUMBERING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
const NUMBERING_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";

export type DocxStyleIds = {
  normal?: string;
  title?: string;
  headings: Partial<Record<1 | 2 | 3, string>>;
  listParagraph?: string;
  listBullet?: string;
  listNumber?: string;
  quote?: string;
  tableGrid?: string;
  hyperlink?: string;
};

const unescapeXml = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Style ids by their built-in names, which stay English whatever language the document was made in. */
export function readStyleIds(stylesXml: string): DocxStyleIds {
  const byName = new Map<string, { id: string; type: string }>();
  for (const match of stylesXml.matchAll(/<(\w+:)?style\b([^>]*)>([\s\S]*?)<\/\1?style>/g)) {
    const attrs = match[2] ?? "";
    const id = /\bstyleId="([^"]*)"/.exec(attrs)?.[1];
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? "paragraph";
    const name = /<(?:\w+:)?name\b[^>]*\bval="([^"]*)"/.exec(match[3] ?? "")?.[1];
    if (id && name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { id: unescapeXml(id), type });
  }
  const pick = (names: string[], type = "paragraph") => {
    for (const name of names) {
      const found = byName.get(name);
      if (found && found.type === type) return found.id;
    }
    return undefined;
  };
  return {
    normal: pick(["normal"]),
    title: pick(["title"]),
    headings: { 1: pick(["heading 1"]), 2: pick(["heading 2"]), 3: pick(["heading 3"]) },
    listParagraph: pick(["list paragraph"]),
    listBullet: pick(["list bullet"]),
    listNumber: pick(["list number"]),
    quote: pick(["quote", "intense quote"]),
    tableGrid: pick(["table grid"], "table"),
    hyperlink: pick(["hyperlink"], "character"),
  };
}

const escapeXml = (value: string) =>
  value
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The body's last element when it is the document's own section properties (not one inside a paragraph). */
export function finalSectPr(bodyInner: string, w: string): string | null {
  const start = bodyInner.lastIndexOf(`<${w}:sectPr`);
  if (start < 0) return null;
  const tail = bodyInner.slice(start);
  if (tail.includes(`</${w}:p>`) || tail.includes(`</${w}:tbl>`)) return null;
  const selfClosing = new RegExp(`^<${w}:sectPr\\b[^>]*/>\\s*$`);
  const full = new RegExp(`^<${w}:sectPr\\b[\\s\\S]*</${w}:sectPr>\\s*$`);
  return selfClosing.test(tail) || full.test(tail) ? tail.trim() : null;
}

function prefixFor(xml: string, namespaces: string[]): string | null {
  for (const match of xml.matchAll(/xmlns:(\w+)="([^"]+)"/g)) if (namespaces.includes(match[2]!)) return match[1]!;
  return null;
}

type Rels = { xml: string; next: () => string; add: (type: string, target: string, external: boolean) => string };

function relsEditor(xml: string): Rels {
  const used = new Set([...xml.matchAll(/\bId="([^"]+)"/g)].map((match) => match[1]!));
  let counter = 1;
  const state = {
    xml,
    next() {
      while (used.has(`rIdEnsemble${counter}`)) counter += 1;
      const id = `rIdEnsemble${counter}`;
      used.add(id);
      return id;
    },
    add(type: string, target: string, external: boolean) {
      const id = state.next();
      state.xml = state.xml.replace(
        /<\/Relationships>\s*$/,
        `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/></Relationships>`,
      );
      return id;
    },
  };
  return state;
}

type Numbering = { bullet: () => string; ordered: (start: number) => string; xml: () => string | null };

function numberingEditor(existing: string | null, w: string): Numbering {
  let xml = existing ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${w}:numbering xmlns:${w}="${W_MAIN[0]}"></${w}:numbering>`;
  const maxOf = (attr: string) => Math.max(0, ...[...xml.matchAll(new RegExp(`${w}:${attr}="(\\d+)"`, "g"))].map((match) => Number(match[1])));
  let abstractId = maxOf("abstractNumId") + 1;
  let numId = maxOf("numId") + 1;
  let bulletAbstract: number | null = null;
  let orderedAbstract: number | null = null;
  let bulletNum: string | null = null;
  let changed = false;
  const level = (format: "bullet" | "decimal") =>
    `<${w}:lvl ${w}:ilvl="0"><${w}:start ${w}:val="1"/><${w}:numFmt ${w}:val="${format}"/><${w}:lvlText ${w}:val="${format === "bullet" ? "•" : "%1."}"/><${w}:lvlJc ${w}:val="left"/><${w}:pPr><${w}:ind ${w}:left="720" ${w}:hanging="360"/></${w}:pPr></${w}:lvl>`;
  const addAbstract = (format: "bullet" | "decimal") => {
    const id = abstractId++;
    const element = `<${w}:abstractNum ${w}:abstractNumId="${id}"><${w}:multiLevelType ${w}:val="singleLevel"/>${level(format)}</${w}:abstractNum>`;
    const firstNum = xml.search(new RegExp(`<${w}:num[\\s>]`));
    const cleanup = xml.indexOf(`<${w}:numIdMacAtCleanup`);
    const at = firstNum >= 0 ? firstNum : cleanup >= 0 ? cleanup : xml.lastIndexOf(`</${w}:numbering>`);
    xml = `${xml.slice(0, at)}${element}${xml.slice(at)}`;
    changed = true;
    return id;
  };
  const addNum = (abstract: number, start?: number) => {
    const id = numId++;
    const override = start !== undefined ? `<${w}:lvlOverride ${w}:ilvl="0"><${w}:startOverride ${w}:val="${start}"/></${w}:lvlOverride>` : "";
    const element = `<${w}:num ${w}:numId="${id}"><${w}:abstractNumId ${w}:val="${abstract}"/>${override}</${w}:num>`;
    const cleanup = xml.indexOf(`<${w}:numIdMacAtCleanup`);
    const at = cleanup >= 0 ? cleanup : xml.lastIndexOf(`</${w}:numbering>`);
    xml = `${xml.slice(0, at)}${element}${xml.slice(at)}`;
    changed = true;
    return String(id);
  };
  return {
    bullet() {
      bulletAbstract ??= addAbstract("bullet");
      bulletNum ??= addNum(bulletAbstract);
      return bulletNum;
    },
    ordered(start: number) {
      orderedAbstract ??= addAbstract("decimal");
      return addNum(orderedAbstract, start);
    },
    xml: () => (changed ? xml : null),
  };
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** The original .docx with its body replaced by the page's blocks. */
export function rebuildDocx(original: Uint8Array, blocks: Block[]): Uint8Array {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(original);
  } catch {
    throw new Error("The original Word file could not be opened, so it cannot be used as the template.");
  }
  const rootRels = files["_rels/.rels"] ? strFromU8(files["_rels/.rels"]) : "";
  const main = /Type="[^"]*\/officeDocument"[^>]*Target="\/?([^"]+)"|Target="\/?([^"]+)"[^>]*Type="[^"]*\/officeDocument"/.exec(rootRels);
  const documentPath = main?.[1] ?? main?.[2] ?? "word/document.xml";
  const documentXml = files[documentPath] ? strFromU8(files[documentPath]) : null;
  if (!documentXml) throw new Error("The original Word file has no document body to use as the template.");
  const dir = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/")) : "";
  const relsPath = `${dir ? `${dir}/` : ""}_rels/${documentPath.slice(dir ? dir.length + 1 : 0)}.rels`;

  const w = prefixFor(documentXml, W_MAIN) ?? "w";
  let r = prefixFor(documentXml, [R_NS]);
  let head = documentXml;
  if (!r) {
    r = "r";
    head = head.replace(new RegExp(`<${w}:document\\b`), `<${w}:document xmlns:r="${R_NS}"`);
  }
  const bodyOpen = new RegExp(`<${w}:body(\\s[^>]*)?>`).exec(head);
  const bodyClose = head.lastIndexOf(`</${w}:body>`);
  if (!bodyOpen || bodyClose < 0) throw new Error("The original Word file has no document body to use as the template.");
  const innerStart = bodyOpen.index + bodyOpen[0].length;
  const inner = head.slice(innerStart, bodyClose);
  const sectPr = finalSectPr(inner, w);

  const stylesPath = Object.keys(files).find((path) => path === `${dir ? `${dir}/` : ""}styles.xml`);
  const styles = readStyleIds(stylesPath ? strFromU8(files[stylesPath]!) : "");
  const firstText = [...inner.matchAll(new RegExp(`<${w}:p\\b[^>]*?(?:/>|>[\\s\\S]*?</${w}:p>)`, "g"))].find((match) => match[0].includes(`<${w}:t`))?.[0] ?? "";
  const firstStyle = new RegExp(`<${w}:pStyle ${w}:val="([^"]+)"`).exec(firstText)?.[1];
  const titleFirst = Boolean(styles.title && firstStyle === styles.title);

  const rels = relsEditor(files[relsPath] ? strFromU8(files[relsPath]) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  const numberingRel = /<Relationship\b[^>]*Type="[^"]*\/numbering"[^>]*>/.exec(rels.xml)?.[0];
  const numberingTarget = numberingRel ? /Target="([^"]+)"/.exec(numberingRel)?.[1] : undefined;
  const numberingPath = numberingTarget?.startsWith("/") ? numberingTarget.slice(1) : `${dir ? `${dir}/` : ""}${numberingTarget ?? "numbering.xml"}`;
  const numbering = numberingEditor(files[numberingPath] ? strFromU8(files[numberingPath]) : null, w);

  const pageWidth = Number(new RegExp(`<${w}:pgSz\\b[^>]*${w}:w="(\\d+)"`).exec(sectPr ?? "")?.[1] ?? 12240);
  const marginLeft = Number(new RegExp(`<${w}:pgMar\\b[^>]*${w}:left="(\\d+)"`).exec(sectPr ?? "")?.[1] ?? 1440);
  const marginRight = Number(new RegExp(`<${w}:pgMar\\b[^>]*${w}:right="(\\d+)"`).exec(sectPr ?? "")?.[1] ?? 1440);
  const textWidth = Math.max(2000, pageWidth - marginLeft - marginRight);

  // Word rejects run properties out of schema order: rStyle, rFonts, b, i, strike, color, sz, u.
  const run = (value: Run, force: { bold?: boolean; italic?: boolean; size?: number } = {}): string => {
    const link = Boolean(value.href && SAFE_LINK.test(value.href));
    const props = [
      link && styles.hyperlink ? `<${w}:rStyle ${w}:val="${escapeXml(styles.hyperlink)}"/>` : "",
      value.code ? `<${w}:rFonts ${w}:ascii="Consolas" ${w}:hAnsi="Consolas" ${w}:cs="Consolas"/>` : "",
      value.bold || force.bold ? `<${w}:b/><${w}:bCs/>` : "",
      value.italic || force.italic ? `<${w}:i/><${w}:iCs/>` : "",
      value.strike ? `<${w}:strike/>` : "",
      link && !styles.hyperlink ? `<${w}:color ${w}:val="0563C1"/>` : "",
      force.size ? `<${w}:sz ${w}:val="${force.size}"/><${w}:szCs ${w}:val="${force.size}"/>` : "",
      link && !styles.hyperlink ? `<${w}:u ${w}:val="single"/>` : "",
    ].join("");
    const parts = value.text.split(/(\n|\t)/).map((piece) => (piece === "\n" ? `<${w}:br/>` : piece === "\t" ? `<${w}:tab/>` : piece ? `<${w}:t xml:space="preserve">${escapeXml(piece)}</${w}:t>` : ""));
    const xml = `<${w}:r>${props ? `<${w}:rPr>${props}</${w}:rPr>` : ""}${parts.join("")}</${w}:r>`;
    return link ? `<${w}:hyperlink ${r}:id="${rels.add(HYPERLINK, value.href!, true)}" ${w}:history="1">${xml}</${w}:hyperlink>` : xml;
  };
  const runs = (values: Run[], force: { bold?: boolean; italic?: boolean } = {}) => values.filter((value) => value.text).map((value) => run(value, force)).join("");
  const paragraph = (content: string, props = "") => `<${w}:p>${props ? `<${w}:pPr>${props}</${w}:pPr>` : ""}${content}</${w}:p>`;
  const styleRef = (id: string | undefined) => (id ? `<${w}:pStyle ${w}:val="${escapeXml(id)}"/>` : "");

  const body: string[] = [];
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "heading": {
        const id = index === 0 && block.level === 1 && titleFirst ? styles.title : styles.headings[block.level];
        body.push(paragraph(runs(block.runs, id ? {} : { bold: true }), styleRef(id)));
        break;
      }
      case "paragraph":
        body.push(paragraph(runs(block.runs)));
        break;
      case "list": {
        const numId = block.ordered ? numbering.ordered(1) : numbering.bullet();
        for (const item of block.items) {
          body.push(paragraph(runs(item), `${styleRef(styles.listParagraph)}<${w}:numPr><${w}:ilvl ${w}:val="0"/><${w}:numId ${w}:val="${numId}"/></${w}:numPr>`));
        }
        break;
      }
      case "todo":
        for (const item of block.items) body.push(paragraph(`${run({ text: item.checked ? "☒ " : "☐ " })}${runs(item.runs)}`));
        break;
      case "quote":
        body.push(paragraph(runs(block.runs, styles.quote ? {} : { italic: true }), styles.quote ? styleRef(styles.quote) : `<${w}:ind ${w}:left="720"/>`));
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          body.push(paragraph(run({ text: line, code: true }, { size: 20 }), `<${w}:spacing ${w}:before="0" ${w}:after="0"/>`));
        }
        break;
      case "rule":
        body.push(paragraph("", `<${w}:pBdr><${w}:bottom ${w}:val="single" ${w}:sz="6" ${w}:space="1" ${w}:color="auto"/></${w}:pBdr>`));
        break;
      case "table": {
        const width = Math.max(1, ...block.rows.map((row) => row.length));
        const col = Math.floor(textWidth / width);
        const borders = styles.tableGrid
          ? ""
          : `<${w}:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<${w}:${side} ${w}:val="single" ${w}:sz="4" ${w}:space="0" ${w}:color="auto"/>`).join("")}</${w}:tblBorders>`;
        const rows = block.rows
          .map(
            (row, rowIndex) =>
              `<${w}:tr>${Array.from({ length: width }, (_, cell) => `<${w}:tc><${w}:tcPr><${w}:tcW ${w}:w="${col}" ${w}:type="dxa"/></${w}:tcPr>${paragraph(runs([{ text: row[cell] ?? "", bold: rowIndex === 0 || undefined }]))}</${w}:tc>`).join("")}</${w}:tr>`,
          )
          .join("");
        body.push(
          `<${w}:tbl><${w}:tblPr>${styles.tableGrid ? `<${w}:tblStyle ${w}:val="${escapeXml(styles.tableGrid)}"/>` : ""}<${w}:tblW ${w}:w="5000" ${w}:type="pct"/>${borders}<${w}:tblLook ${w}:val="04A0" ${w}:firstRow="1" ${w}:lastRow="0" ${w}:firstColumn="1" ${w}:lastColumn="0" ${w}:noHBand="0" ${w}:noVBand="1"/></${w}:tblPr><${w}:tblGrid>${Array.from({ length: width }, () => `<${w}:gridCol ${w}:w="${col}"/>`).join("")}</${w}:tblGrid>${rows}</${w}:tbl>`,
        );
        break;
      }
    }
  });
  if (!body.length || body.at(-1)!.startsWith(`<${w}:tbl>`)) body.push(`<${w}:p/>`);

  const next: Record<string, Uint8Array> = { ...files };
  next[documentPath] = strToU8(`${head.slice(0, innerStart)}${body.join("")}${sectPr ?? ""}${head.slice(bodyClose)}`);
  const numberingXml = numbering.xml();
  if (numberingXml) {
    next[numberingPath] = strToU8(numberingXml);
    if (!numberingRel) rels.add(NUMBERING_REL, numberingPath.slice(dir ? dir.length + 1 : 0), false);
    const typesPath = "[Content_Types].xml";
    const types = files[typesPath] ? strFromU8(files[typesPath]) : "";
    const partName = `/${numberingPath}`;
    if (types && !types.includes(`PartName="${partName}"`)) {
      next[typesPath] = strToU8(types.replace(/<\/Types>\s*$/, `<Override PartName="${partName}" ContentType="${NUMBERING_TYPE}"/></Types>`));
    }
  }
  if (rels.xml !== (files[relsPath] ? strFromU8(files[relsPath]) : null)) next[relsPath] = strToU8(rels.xml);
  return zipSync(next);
}
