/**
 * Images in pages: the `image` node and what it shows. An image is either a file in Files
 * (`fileId`, uploaded with the page-image rules) or a web address (`src`, from Notion imports and
 * pasted HTML). `width` is a percentage of the page column (null: the image's own size, capped to
 * the column), `align` places it, and `naturalWidth`/`naturalHeight` reserve its shape while it
 * loads. All of it lives in node attributes, so it saves, undoes and co-edits like any change.
 * Docs: docs/32_FILES.md §6, docs/02.
 */
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  PAGE_IMAGE_MAX_BYTES,
  PAGE_IMAGE_MAX_WIDTH,
  PAGE_IMAGE_MIN_WIDTH,
  isPageImageType,
  pageImageAlign,
  pageImageSide,
  pageImageWidth,
  type PageImageAlign,
} from "@ensemble/shared-types";
import { API, itemViewHeaders } from "@/lib/api";

const STEP = 5;
const PRESETS = [25, 50, 75, 100] as const;

export type ImageLoadReason = "gone" | "denied" | "not-image" | "failed";

export class ImageLoadError extends Error {
  constructor(readonly reason: ImageLoadReason) {
    super(reason);
  }
}

/** Originals already read this session, by file id, kept while their SHA-256 (the ETag) still matches. */
const kept = new Map<string, { sha: string; blob: Blob }>();
const KEPT_BYTES = 64 * 1024 * 1024;
const reading = new Map<string, Promise<Blob>>();

function keep(fileId: string, sha: string, blob: Blob): void {
  kept.delete(fileId);
  kept.set(fileId, { sha, blob });
  let total = 0;
  for (const entry of kept.values()) total += entry.blob.size;
  for (const [id, entry] of kept) {
    if (total <= KEPT_BYTES) break;
    total -= entry.blob.size;
    kept.delete(id);
  }
}

/**
 * The bytes of an image kept in Files. An `<img src>` cannot send the share or public-link headers
 * a shared page needs, so the bytes are fetched with them and shown from an object URL. Every load
 * asks the server (it re-checks access); an unchanged file answers 304 and the kept bytes are used.
 */
export function loadPageImage(fileId: string, headers: Record<string, string> = itemViewHeaders()): Promise<Blob> {
  const key = `${fileId}\n${JSON.stringify(headers)}`;
  const running = reading.get(key);
  if (running) return running;
  const work = (async () => {
    const known = kept.get(fileId);
    const response = await fetch(`${API}/api/documents/${encodeURIComponent(fileId)}/original`, {
      credentials: "include",
      cache: "no-store",
      headers: { ...headers, ...(known ? { "If-None-Match": `"${known.sha}"` } : {}) },
    }).catch(() => {
      throw new ImageLoadError("failed");
    });
    if (response.status === 304 && known) return known.blob;
    if (response.status === 404 || response.status === 410) throw new ImageLoadError("gone");
    if (response.status === 401 || response.status === 403) throw new ImageLoadError("denied");
    if (!response.ok) throw new ImageLoadError("failed");
    if (Number(response.headers.get("content-length")) > PAGE_IMAGE_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new ImageLoadError("not-image");
    }
    const blob = await response.blob();
    if (blob.size > PAGE_IMAGE_MAX_BYTES || !isPageImageType(blob.type)) throw new ImageLoadError("not-image");
    const sha = (response.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
    if (sha) keep(fileId, sha, blob);
    return blob;
  })();
  reading.set(key, work);
  void work.then(
    () => reading.delete(key),
    () => reading.delete(key),
  );
  return work;
}

const UNAVAILABLE: Record<ImageLoadReason, string> = {
  gone: "Its file was deleted from Files.",
  denied: "You can't open its file from here.",
  "not-image": "Its file is over 2 MB or isn't a PNG, JPEG, GIF or WebP image. Open it from Files.",
  failed: "It couldn't load. Check your connection and reload the page.",
};

function svgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const ICONS: Record<PageImageAlign | "remove", string[]> = {
  left: ["M21 6H3", "M15 12H3", "M17 18H3"],
  center: ["M21 6H3", "M17 12H7", "M19 18H5"],
  right: ["M21 6H3", "M21 12H9", "M21 18H7"],
  remove: ["M18 6 6 18", "M6 6l12 12"],
};

const ALIGN_LABEL: Record<PageImageAlign, string> = { left: "Align left", center: "Center", right: "Align right" };

type Attrs = { src: string; fileId: string; alt: string; width: number | null; align: PageImageAlign; naturalWidth: number | null; naturalHeight: number | null };

function readAttrs(node: ProseMirrorNode): Attrs {
  return {
    src: typeof node.attrs.src === "string" ? node.attrs.src : "",
    fileId: typeof node.attrs.fileId === "string" ? node.attrs.fileId : "",
    alt: String(node.attrs.alt ?? ""),
    width: pageImageWidth(node.attrs.width),
    align: pageImageAlign(node.attrs.align),
    naturalWidth: pageImageSide(node.attrs.naturalWidth),
    naturalHeight: pageImageSide(node.attrs.naturalHeight),
  };
}

function button(label: string, content: string | SVGSVGElement, run: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "page-image-tool";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.append(content);
  // Keeps the image selected and the caret where it was; the click still runs.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.preventDefault();
    run();
  });
  return element;
}

function imageView(node: ProseMirrorNode, editor: Editor, getPos: () => number | undefined) {
  let attrs = readAttrs(node);
  const dom = document.createElement("figure");
  dom.className = "page-image-frame page-image-block";
  dom.contentEditable = "false";
  const box = document.createElement("div");
  box.className = "page-image-box";
  const image = document.createElement("img");
  image.className = "page-image";
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  box.append(image);
  dom.append(box);
  let objectUrl: string | null = null;
  let destroyed = false;

  /** Attribute steps carry only what changed, so co-editors never resend the image node. */
  const setAttrs = (patch: Partial<Attrs>) => {
    const pos = getPos();
    if (!editor.isEditable || typeof pos !== "number") return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "image") return;
    const tr = editor.state.tr;
    for (const [key, value] of Object.entries(patch)) if (current.attrs[key] !== value) tr.setNodeAttribute(pos, key, value);
    if (tr.docChanged) editor.view.dispatch(tr);
  };

  const columnWidth = () => dom.getBoundingClientRect().width;
  /** The width shown now, as a percentage of the column. */
  const shownPercent = () => {
    if (attrs.width !== null) return attrs.width;
    const column = columnWidth();
    const shown = box.getBoundingClientRect().width;
    return column > 0 && shown > 0 ? Math.round((shown / column) * 100) : PAGE_IMAGE_MAX_WIDTH;
  };

  let handle: HTMLElement | null = null;
  const presetButtons = new Map<number | null, HTMLButtonElement>();
  const alignButtons = new Map<PageImageAlign, HTMLButtonElement>();
  let altButton: HTMLButtonElement | null = null;

  const showWidth = (width: number | null) => {
    box.style.width = width === null ? "" : `${width}%`;
    dom.toggleAttribute("data-width", width !== null);
    if (handle) {
      const now = width ?? shownPercent();
      handle.setAttribute("aria-valuenow", String(now));
      handle.setAttribute("aria-valuetext", width === null ? `Original size (${now}% of the page width)` : `${width}% of the page width`);
    }
    for (const [value, element] of presetButtons) element.setAttribute("aria-pressed", String(value === width));
  };

  const render = () => {
    dom.dataset.align = attrs.align;
    image.alt = attrs.alt;
    if (attrs.naturalWidth && attrs.naturalHeight) {
      image.width = attrs.naturalWidth;
      image.height = attrs.naturalHeight;
      image.style.aspectRatio = `${attrs.naturalWidth} / ${attrs.naturalHeight}`;
    }
    showWidth(attrs.width);
    for (const [value, element] of alignButtons) element.setAttribute("aria-pressed", String(value === attrs.align));
    if (altButton) {
      altButton.textContent = attrs.alt ? "Alt ✓" : "Alt";
      altButton.title = attrs.alt ? `Alt text: ${attrs.alt}` : "Add alt text";
    }
  };

  const unavailable = (title: string, detail: string, link?: string) => {
    const note = document.createElement("div");
    note.className = "page-image-broken";
    note.setAttribute("role", "note");
    const heading = document.createElement("span");
    heading.textContent = title;
    note.append(heading);
    if (detail) {
      const more = document.createElement(link ? "a" : "span");
      if (link) {
        more.setAttribute("href", link);
        more.setAttribute("target", "_blank");
        more.setAttribute("rel", "noopener noreferrer nofollow");
      }
      more.textContent = detail;
      note.append(more);
    }
    box.classList.remove("is-loading");
    image.remove();
    box.prepend(note);
  };

  image.addEventListener("load", () => box.classList.remove("is-loading"));
  if (attrs.fileId) {
    box.classList.add("is-loading");
    // The share or public-link headers of the page being viewed, as it is now.
    void loadPageImage(attrs.fileId, itemViewHeaders()).then(
      (blob) => {
        if (destroyed) return;
        if (typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        image.src = objectUrl;
      },
      (error: unknown) => {
        if (destroyed) return;
        const reason = error instanceof ImageLoadError ? error.reason : "failed";
        unavailable(attrs.alt.trim() ? `Image unavailable: ${attrs.alt.trim()}` : "Image unavailable", UNAVAILABLE[reason]);
      },
    );
    image.addEventListener("error", () => {
      if (!destroyed && objectUrl) unavailable("Image unavailable", UNAVAILABLE["not-image"]);
    });
  } else if (attrs.src) {
    // An image that cannot load keeps its place on the page and says what it was.
    image.addEventListener("error", () => {
      const alt = attrs.alt.trim();
      const web = /^https?:\/\//i.test(attrs.src);
      unavailable(alt ? `Image couldn't load: ${alt}` : "Image couldn't load", /^data:/i.test(attrs.src) ? "" : attrs.src, web ? attrs.src : undefined);
    });
    image.src = attrs.src;
  } else unavailable("Image couldn't load", "");

  const buildControls = (): HTMLElement[] => {
    const label = () => (attrs.alt.trim() ? `Image width: ${attrs.alt.trim()}` : "Image width");
    const makeHandle = (side: "left" | "right") => {
      const element = document.createElement("div");
      element.className = `page-image-handle is-${side}`;
      element.contentEditable = "false";
      element.title = "Drag to resize. Arrow keys change the width by 5%.";
      if (side === "right") {
        element.setAttribute("role", "slider");
        element.setAttribute("aria-label", label());
        element.setAttribute("aria-valuemin", String(PAGE_IMAGE_MIN_WIDTH));
        element.setAttribute("aria-valuemax", String(PAGE_IMAGE_MAX_WIDTH));
        element.tabIndex = 0;
        // An image at its own size reports the share of the column it takes now.
        element.addEventListener("focus", () => showWidth(attrs.width));
      } else element.setAttribute("aria-hidden", "true");
      let start: { x: number; percent: number; column: number; pointer: number } | null = null;
      let live: number | null = null;
      element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const column = columnWidth();
        if (!column) return;
        start = { x: event.clientX, percent: shownPercent(), column, pointer: event.pointerId };
        element.classList.add("is-dragging");
        element.setPointerCapture?.(event.pointerId);
      });
      element.addEventListener("pointermove", (event) => {
        if (!start || event.pointerId !== start.pointer) return;
        // A centred image grows on both sides, so the edge moves half as far as the width changes.
        const moved = (side === "right" ? event.clientX - start.x : start.x - event.clientX) * (attrs.align === "center" ? 2 : 1);
        live = pageImageWidth(start.percent + (moved / start.column) * 100);
        showWidth(live);
      });
      const end = (event: PointerEvent) => {
        if (!start || event.pointerId !== start.pointer) return;
        start = null;
        element.classList.remove("is-dragging");
        if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
        if (live !== null) setAttrs({ width: live });
        live = null;
      };
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", end);
      element.addEventListener("keydown", (event) => {
        const now = shownPercent();
        const next =
          event.key === "ArrowRight" || event.key === "ArrowUp"
            ? now + STEP
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? now - STEP
              : event.key === "Home"
                ? PAGE_IMAGE_MIN_WIDTH
                : event.key === "End"
                  ? PAGE_IMAGE_MAX_WIDTH
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        setAttrs({ width: pageImageWidth(next) });
      });
      return element;
    };
    const left = makeHandle("left");
    const right = makeHandle("right");
    handle = right;
    box.append(left, right);

    const toolbar = document.createElement("div");
    toolbar.className = "page-image-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Image");
    const group = (...items: HTMLElement[]) => {
      const element = document.createElement("span");
      element.className = "page-image-tools";
      element.append(...items);
      toolbar.append(element);
    };
    group(
      ...(["left", "center", "right"] as const).map((align) => {
        const element = button(ALIGN_LABEL[align], svgIcon(ICONS[align]), () => setAttrs({ align }));
        alignButtons.set(align, element);
        return element;
      }),
    );
    group(
      ...[...PRESETS, null].map((width) => {
        const element = button(width === null ? "Original size, up to the page width" : `Width ${width}% of the page`, width === null ? "Original" : `${width}%`, () => setAttrs({ width }));
        presetButtons.set(width, element);
        return element;
      }),
    );
    altButton = button("Edit alt text", "Alt", () => editAlt());
    group(altButton, button("Remove image", svgIcon(ICONS.remove), () => remove()));
    box.append(toolbar);

    const remove = () => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      const current = editor.state.doc.nodeAt(pos);
      if (current) editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
    };

    let form: HTMLElement | null = null;
    const editAlt = () => {
      if (form?.isConnected) {
        form.querySelector("input")?.focus();
        return;
      }
      form = document.createElement("div");
      form.className = "page-image-alt";
      const input = document.createElement("input");
      input.type = "text";
      input.value = attrs.alt;
      input.maxLength = 1000;
      input.placeholder = "Describe the image for people who can't see it";
      input.setAttribute("aria-label", "Alt text");
      const hint = document.createElement("span");
      hint.className = "page-image-alt-hint";
      hint.textContent = "Enter to save · Esc to cancel";
      form.append(input, hint);
      let closed = false;
      const close = (save: boolean, refocus: boolean) => {
        if (closed) return;
        closed = true;
        const value = input.value.replace(/\s+/g, " ").trim();
        form?.remove();
        form = null;
        if (save) setAttrs({ alt: value });
        if (refocus) altButton?.focus();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          close(true, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(false, true);
        }
      });
      input.addEventListener("blur", () => close(true, false));
      dom.append(form);
      input.focus();
      input.select();
    };
    return [left, right, toolbar];
  };

  // Controls exist while the page can be edited; a page that turns read-only hides them.
  let controls: HTMLElement[] | null = null;
  const syncEditable = () => {
    if (destroyed) return;
    if (editor.isEditable && !controls) controls = buildControls();
    for (const element of controls ?? []) element.hidden = !editor.isEditable;
    if (!editor.isEditable) dom.querySelector(".page-image-alt")?.remove();
  };
  syncEditable();
  editor.on("update", syncEditable);
  render();

  return {
    dom,
    update(next: ProseMirrorNode) {
      if (next.type !== node.type) return false;
      const fresh = readAttrs(next);
      if (fresh.fileId !== attrs.fileId || fresh.src !== attrs.src) return false;
      attrs = fresh;
      render();
      if (handle) handle.setAttribute("aria-label", attrs.alt.trim() ? `Image width: ${attrs.alt.trim()}` : "Image width");
      return true;
    },
    destroy() {
      destroyed = true;
      editor.off("update", syncEditable);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
    stopEvent: (event: Event) => Boolean((event.target as HTMLElement | null)?.closest?.(".page-image-toolbar, .page-image-handle, .page-image-alt")),
    ignoreMutation: (mutation: { type: string }) => mutation.type !== "selection",
  };
}

export const PageImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: {
        default: null,
        // A blob: address only lives in the tab that made it.
        parseHTML: (element) => {
          const src = element.getAttribute("src");
          return src && !/^blob:/i.test(src) ? src : null;
        },
      },
      alt: { default: "", parseHTML: (element) => element.getAttribute("alt") ?? "" },
      fileId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-file-id") || null,
        renderHTML: (attributes) => (attributes.fileId ? { "data-file-id": attributes.fileId } : {}),
      },
      width: {
        default: null,
        parseHTML: (element) => pageImageWidth(element.getAttribute("data-width")),
        renderHTML: (attributes) => (pageImageWidth(attributes.width) ? { "data-width": String(pageImageWidth(attributes.width)) } : {}),
      },
      align: {
        default: "center",
        parseHTML: (element) => pageImageAlign(element.getAttribute("data-align")),
        renderHTML: (attributes) => ({ "data-align": pageImageAlign(attributes.align) }),
      },
      naturalWidth: {
        default: null,
        parseHTML: (element) => pageImageSide(element.getAttribute("data-natural-width")),
        renderHTML: (attributes) => (pageImageSide(attributes.naturalWidth) ? { "data-natural-width": String(attributes.naturalWidth) } : {}),
      },
      naturalHeight: {
        default: null,
        parseHTML: (element) => pageImageSide(element.getAttribute("data-natural-height")),
        renderHTML: (attributes) => (pageImageSide(attributes.naturalHeight) ? { "data-natural-height": String(attributes.naturalHeight) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-file-id]" }, { tag: "img[src]", getAttrs: (element) => (/^blob:/i.test((element as HTMLElement).getAttribute("src") ?? "") ? false : null) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { class: "page-image", loading: "lazy" })];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => imageView(node, editor, getPos as () => number | undefined);
  },
});
