import { Mark, Node, mergeAttributes } from "@tiptap/core";

export const PageLink = Node.create({
  name: "pageLink",
  group: "block",
  atom: true,
  addAttributes() { return { pageId: { default: null }, externalPageId: { default: null }, label: { default: "Untitled" } }; },
  parseHTML() { return [{ tag: 'a[data-type="pageLink"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const href = node.attrs.pageId ? `/pages/${node.attrs.pageId}` : `https://www.notion.so/${node.attrs.externalPageId ?? ""}`;
    return ["a", mergeAttributes(HTMLAttributes, { "data-type": "pageLink", class: "page-link-block", href, contenteditable: "false" }), `📄 ${node.attrs.label}`];
  },
});

export const PageImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  addAttributes() { return { src: { default: null }, alt: { default: "" } }; },
  parseHTML() { return [{ tag: "img[src]" }]; },
  renderHTML({ HTMLAttributes }) { return ["img", mergeAttributes(HTMLAttributes, { class: "page-image", loading: "lazy" })]; },
});

export const Underline = Mark.create({ name: "underline", parseHTML: () => [{ tag: "u" }], renderHTML: () => ["u", 0] });

const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
export const NotionColor = Mark.create({
  name: "notionColor",
  addAttributes() { return { color: { default: "default" } }; },
  parseHTML() { return [{ tag: "span[data-notion-color]", getAttrs: (element) => ({ color: element.getAttribute("data-notion-color") }) }]; },
  renderHTML({ mark }) {
    const color = String(mark.attrs.color);
    const base = color.replace(/_background$/, "");
    return ["span", COLORS.has(base) ? { "data-notion-color": color, class: color.endsWith("_background") ? `notion-bg-${base}` : `notion-fg-${base}` } : {}, 0];
  },
});
