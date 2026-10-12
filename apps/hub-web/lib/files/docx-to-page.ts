/**
 * A Word file becomes a page in the browser: mammoth turns the document into plain
 * HTML (headings, lists, tables, bold, italic, links), and TipTap reads that HTML with
 * the editor's own extensions so the page only holds what pages support. Images are
 * left out; they stay in the original file, which is also the template for export back.
 */
import type { PageDocument } from "@ensemble/shared-types";

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Heading 4'] => h3:fresh",
  "p[style-name='Heading 5'] => h3:fresh",
  "p[style-name='Heading 6'] => h3:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='List Bullet'] => ul > li:fresh",
  "p[style-name='List Bullet 2'] => ul > li:fresh",
  "p[style-name='List Number'] => ol > li:fresh",
  "p[style-name='List Number 2'] => ol > li:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "r[style-name='Strong'] => strong",
  "r[style-name='Emphasis'] => em",
];

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Drops images and unsafe or in-document links from mammoth's HTML. Returns how many images were dropped. */
export function cleanConvertedHtml(html: string): { html: string; images: number } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const images = doc.querySelectorAll("img");
  const count = images.length;
  images.forEach((image) => image.remove());
  doc.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    if (SAFE_LINK.test(href) && link.textContent?.trim()) {
      link.removeAttribute("id");
      return;
    }
    link.replaceWith(...Array.from(link.childNodes));
  });
  doc.querySelectorAll("p").forEach((paragraph) => {
    if (!paragraph.textContent?.trim() && !paragraph.querySelector("br")) paragraph.remove();
  });
  return { html: doc.body.innerHTML, images: count };
}

type Mammoth = {
  convertToHtml: (input: { arrayBuffer: ArrayBuffer }, options: Record<string, unknown>) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  images: { imgElement: (convert: () => Promise<{ src: string }>) => unknown };
};

export async function docxToPage(bytes: ArrayBuffer): Promise<{ content: PageDocument; imagesDropped: number }> {
  const loaded = (await import("mammoth")) as unknown as Mammoth & { default?: Mammoth };
  const mammoth = loaded.default ?? loaded;
  let result: { value: string };
  try {
    result = await mammoth.convertToHtml(
      { arrayBuffer: bytes.slice(0) },
      { styleMap: STYLE_MAP, convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
    );
  } catch {
    throw new Error("This Word file could not be read. It may be damaged, password-protected, or an older .doc saved with a .docx name.");
  }
  const { html, images } = cleanConvertedHtml(result.value);
  const [{ generateJSON }, { editorExtensions }] = await Promise.all([import("@tiptap/core"), import("@/components/editor/extensions")]);
  const json = generateJSON(html || "<p></p>", editorExtensions(() => [], "")) as PageDocument;
  const content: PageDocument = { type: "doc", content: json.content?.length ? json.content : [{ type: "paragraph" }] };
  return { content, imagesDropped: images };
}
