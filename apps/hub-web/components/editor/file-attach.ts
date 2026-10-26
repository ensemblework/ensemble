import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { QueryClient } from "@tanstack/react-query";
import {
  PAGE_IMAGE_ACCEPT,
  PAGE_IMAGE_MAX_BYTES,
  checkPageImage,
  dataUrlBytes,
  looksLikePageImage,
  pageImageFileProblem,
  pageImageTooLarge,
  type FileRecord,
} from "@ensemble/shared-types";
import { inItemView } from "@/lib/api";
import { FILE_QUERY, filesApi } from "@/lib/api-files";
import { pastedFiles } from "@/lib/files/pasted";
import { emitToast } from "@/lib/toast-bus";

export type FileAttachOptions = {
  /** The app's query cache. Uploads refresh the file lists and the @ menu through it. */
  client: () => QueryClient | null;
  /** Opens the /file chooser for a document position. */
  choose: (editor: Editor, pos: number) => void;
  /** Opens the system file picker for `/image`. Tests replace it. */
  pickImages: (accept: string, done: (files: File[]) => void) => void;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileAttach: {
      /** Opens the /file chooser at a position, the cursor by default. */
      chooseFile: (pos?: number) => ReturnType;
      /** Opens the image picker; the images chosen upload into the page at the position. */
      chooseImage: (pos?: number) => ReturnType;
    };
  }
}

/**
 * How dropped, pasted or chosen files land: "auto" makes PNG, JPEG, GIF and WebP images into
 * images in the page and everything else a file card; "image" (`/image`) takes images only;
 * "file" (`/file`) makes a card of anything.
 */
export type UploadAs = "auto" | "image" | "file";

type UploadMeta = { add?: Array<{ id: string; pos: number; dom: HTMLElement }>; remove?: string };

const UPLOADS = new PluginKey<DecorationSet>("fileUploads");

type Placeholder = { dom: HTMLElement; progress: (fraction: number) => void; shape: (width: number, height: number) => void; dispose: () => void };

function filePlaceholder(name: string): Placeholder {
  const dom = document.createElement("span");
  dom.className = "file-upload-placeholder inline-flex items-center rounded border border-dashed border-line px-2 py-0.5 text-[12.5px] text-muted";
  dom.contentEditable = "false";
  dom.setAttribute("role", "status");
  dom.textContent = `Uploading ${name}…`;
  let percent: HTMLElement | null = null;
  return {
    dom,
    progress(fraction) {
      if (!percent) {
        percent = document.createElement("span");
        percent.className = "ml-1 tabular-nums";
        percent.setAttribute("aria-hidden", "true");
        dom.append(percent);
      }
      percent.textContent = `${Math.round(fraction * 100)}%`;
    },
    shape: () => undefined,
    dispose: () => undefined,
  };
}

/** Where an image will go: the picture itself, dimmed, with how much of it is sent. */
function imagePlaceholder(file: File): Placeholder {
  const dom = document.createElement("span");
  dom.className = "image-upload-placeholder";
  dom.contentEditable = "false";
  dom.setAttribute("role", "status");
  const preview = document.createElement("span");
  preview.className = "image-upload-preview";
  const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
  if (url) {
    const picture = document.createElement("img");
    picture.src = url;
    picture.alt = "";
    preview.append(picture);
  }
  const bar = document.createElement("span");
  bar.className = "image-upload-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", `Uploading ${file.name}`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", "0");
  const fill = document.createElement("span");
  bar.append(fill);
  const label = document.createElement("span");
  label.className = "image-upload-text";
  label.textContent = `Uploading ${file.name}…`;
  const percent = document.createElement("span");
  percent.className = "image-upload-percent";
  percent.setAttribute("aria-hidden", "true");
  percent.textContent = "0%";
  label.append(" ", percent);
  dom.append(preview, bar, label);
  return {
    dom,
    progress(fraction) {
      const value = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      fill.style.width = `${value}%`;
      bar.setAttribute("aria-valuenow", String(value));
      percent.textContent = `${value}%`;
    },
    shape(width, height) {
      preview.style.aspectRatio = `${width} / ${height}`;
      preview.style.maxWidth = `${width}px`;
    },
    dispose: () => {
      if (url) URL.revokeObjectURL(url);
    },
  };
}

/** "Uploading report.pdf…" where each file will go. Decorations, so nothing is saved until the file is in. */
function uploadsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: UPLOADS,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(UPLOADS) as UploadMeta | undefined;
        if (meta?.add) {
          // Rising sides keep files dropped together in order, and push the rest past each card as it lands.
          next = next.add(tr.doc, meta.add.map((upload, index) => Decoration.widget(upload.pos, upload.dom, { id: upload.id, side: index + 1 })));
        }
        if (meta?.remove) next = next.remove(next.find(undefined, undefined, (spec) => spec.id === meta.remove));
        return next;
      },
    },
    props: {
      decorations: (state) => UPLOADS.getState(state),
    },
  });
}

function placeholderPos(state: EditorState, id: string): number | null {
  const found = UPLOADS.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0]!.from : null;
}

export function fileMentionContent(file: Pick<FileRecord, "id" | "filename">) {
  return [
    { type: "mention", attrs: { id: file.id, label: file.filename, kind: "file" } },
    { type: "text", text: " " },
  ];
}

/** Puts a card for a file that is already in Files. */
export function insertFile(editor: Editor, file: Pick<FileRecord, "id" | "filename">, pos: number): void {
  editor.chain().focus().insertContentAt(Math.min(pos, editor.state.doc.content.size), fileMentionContent(file)).run();
}

let uploads = 0;

const SHARED_PAGE = "Images can't be added from a shared page or link. Ask its owner to add the image.";

/** Follows a position through later edits until `stop`, `ms` passes, or the editor goes. */
function followPos(editor: Editor, pos: number, ms?: number): { at: () => number; stop: () => void } {
  let at = pos;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    at = transaction.mapping.map(at);
  };
  const stop = () => {
    clearTimeout(timer);
    editor.off("transaction", follow);
    editor.off("destroy", stop);
  };
  const timer = ms === undefined ? undefined : setTimeout(stop, ms);
  editor.on("transaction", follow);
  editor.on("destroy", stop);
  return { at: () => Math.min(at, editor.state.doc.content.size), stop };
}

type Pending = { id: string; file: File; image: boolean; alt: string; view: Placeholder };

type Refuse = (message: string, more?: { file?: File; pos?: number; reason?: string }) => void;

/**
 * Says why a file was not added, once per reason: a limit stops every file after it with the same
 * words. A refused image can still go in as a file card, from the toast.
 */
function refusals(editor: Editor, client: QueryClient | null | undefined): Refuse {
  const told = new Set<string>();
  return (message, { file, pos, reason = message } = {}) => {
    if (told.has(reason)) return;
    told.add(reason);
    const attach = file && pos !== undefined && /attach it as a file with \/file/.test(message);
    const where = attach ? followPos(editor, pos, 10_000) : null;
    emitToast(message, {
      tone: "error",
      ...(attach && where
        ? {
            durationMs: 10_000,
            action: {
              label: "Attach as file",
              run: () => {
                const at = where.at();
                where.stop();
                if (!editor.isDestroyed) void uploadFiles(editor, [file], { pos: at, client, as: "file" });
              },
            },
          }
        : {}),
    });
  };
}

/** Checks each file before anything is sent and makes its placeholder. Refused files are told about and left out. */
function prepare(files: Array<{ file: File; alt?: string }>, as: UploadAs, refuse: (message: string, file?: File) => void): Pending[] {
  const queue: Pending[] = [];
  for (const { file, alt } of files) {
    const image = as === "image" || (as === "auto" && looksLikePageImage(file));
    if (image) {
      if (inItemView()) {
        refuse(SHARED_PAGE);
        continue;
      }
      const problem = pageImageFileProblem(file);
      if (problem) {
        refuse(problem, file);
        continue;
      }
    }
    queue.push({ id: `upload-${++uploads}`, file, image, alt: alt ?? "", view: image ? imagePlaceholder(file) : filePlaceholder(file.name) });
  }
  return queue;
}

/** Where a block image goes for a position in text: before or after its line when at either end. */
function imagePos(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos);
  const type = state.schema.nodes.image;
  if (!type || !$pos.parent.isTextblock || !$pos.parent.content.size || $pos.depth === 0) return pos;
  const edge = $pos.parentOffset === 0 ? $pos.before() : $pos.parentOffset === $pos.parent.content.size ? $pos.after() : null;
  if (edge === null) return pos;
  const $edge = state.doc.resolve(edge);
  return $edge.parent.canReplaceWith($edge.index(), $edge.index(), type) ? edge : pos;
}

/** Uploads one at a time; each lands where its placeholder is now, as one undoable step. */
async function send(editor: Editor, queue: Pending[], client: QueryClient | null | undefined, refuse: Refuse): Promise<FileRecord[]> {
  const done: FileRecord[] = [];
  for (const item of queue) {
    let record: FileRecord | null = null;
    let content: JSONContent | JSONContent[] | null = null;
    let sentName = item.file.name;
    try {
      if (item.image) {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const checked = checkPageImage({ filename: item.file.name, bytes, mediaType: item.file.type });
        if (!checked.ok) throw new Error(checked.message);
        sentName = checked.filename;
        item.view.shape(checked.width, checked.height);
        const sent = await filesApi.upload({ name: checked.filename, type: checked.mime, bytes }, { purpose: "page-image", onProgress: item.view.progress });
        record = sent.file;
        content = { type: "image", attrs: { src: null, fileId: record.id, alt: item.alt, naturalWidth: sent.image?.width ?? checked.width, naturalHeight: sent.image?.height ?? checked.height } };
      } else {
        record = (await filesApi.upload(item.file, { onProgress: item.view.progress })).file;
        content = fileMentionContent(record);
      }
      done.push(record);
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "Upload failed.";
      const at = editor.isDestroyed ? null : placeholderPos(editor.state, item.id);
      // Page-image refusals already name the file and say what to do.
      const named = item.image && (reason.startsWith(item.file.name) || reason.startsWith(sentName));
      refuse(named ? reason : `Could not upload ${item.file.name}. ${reason}`, { file: item.file, pos: at ?? undefined, reason: named ? undefined : reason });
    }
    item.view.dispose();
    if (editor.isDestroyed) continue;
    const at = placeholderPos(editor.state, item.id);
    const chain = editor.chain().command(({ tr }) => {
      tr.setMeta(UPLOADS, { remove: item.id } satisfies UploadMeta);
      if (content) closeHistory(tr);
      return true;
    });
    if (content && at !== null) chain.insertContentAt(item.image ? imagePos(editor.state, at) : at, content, { updateSelection: false });
    chain.run();
  }
  if (done.length && client) {
    void client.invalidateQueries({ queryKey: FILE_QUERY.all });
    void client.invalidateQueries({ queryKey: ["entities"] });
  }
  return done;
}

/**
 * Uploads files one at a time and puts each where it was dropped, pasted or chosen: an image in
 * the page, or a file card (`as`). A placeholder whose spot was deleted meanwhile drops its
 * file; the file stays in Files.
 */
export async function uploadFiles(editor: Editor, files: File[], options: { pos?: number; client?: QueryClient | null; as?: UploadAs } = {}): Promise<FileRecord[]> {
  if (!files.length || editor.isDestroyed) return [];
  const pos = Math.min(options.pos ?? editor.state.selection.from, editor.state.doc.content.size);
  const refuse = refusals(editor, options.client);
  const queue = prepare(
    files.map((file) => ({ file })),
    options.as ?? "auto",
    (message, file) => refuse(message, { file, pos }),
  );
  if (!queue.length) return [];
  editor.view.dispatch(editor.state.tr.setMeta(UPLOADS, { add: queue.map((item) => ({ id: item.id, pos, dom: item.view.dom })) } satisfies UploadMeta));
  return send(editor, queue, options.client, refuse);
}

function isDataImage(node: ProseMirrorNode): boolean {
  return node.type.name === "image" && typeof node.attrs.src === "string" && /^data:/i.test(node.attrs.src);
}

/** A pasted `data:` image as a file to upload, or null when it cannot be read. */
function dataUrlFile(src: string, index: number): File | null {
  const head = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(src.slice(0, 512));
  if (!head) return null;
  const type = (head[1] || "text/plain").toLowerCase();
  const payload = src.slice(head[0].length);
  let bytes: Uint8Array;
  try {
    if (/;base64/i.test(head[2] ?? "")) {
      const binary = atob(payload.replace(/\s/g, ""));
      bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    } else bytes = new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
  const ext = type === "image/jpeg" ? "jpg" : type === "image/svg+xml" ? "svg" : type.startsWith("image/") ? type.slice(6) : "bin";
  return new File([bytes as BlobPart], `pasted-image${index ? `-${index + 1}` : ""}.${ext}`, { type });
}

function mapLeaves(fragment: Fragment, swap: (node: ProseMirrorNode) => ProseMirrorNode): Fragment {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((child) => children.push(child.isLeaf ? swap(child) : child.copy(mapLeaves(child.content, swap))));
  return Fragment.fromArray(children);
}

/**
 * HTML pasted or dropped with `data:` images in it: the rest goes in as usual and each image is
 * uploaded where it was, under the same rules as any other, so no image bytes go into the page.
 * Returns false when there are none.
 */
function placeDataImages(editor: Editor, view: EditorView, slice: Slice, insert: (tr: Transaction, clean: Slice) => void, uiEvent: "paste" | "drop", client: QueryClient | null): boolean {
  let found = false;
  slice.content.descendants((node) => {
    found ||= isDataImage(node);
    return !found;
  });
  if (!found) return false;
  // Each data image is swapped for a stand-in node, found again once the slice is placed, and removed in the same step.
  const standIns: Array<{ node: ProseMirrorNode; src: string; alt: string }> = [];
  const clean = new Slice(
    mapLeaves(slice.content, (node) => {
      if (!isDataImage(node)) return node;
      const standIn = node.type.create({ src: null, alt: "" });
      standIns.push({ node: standIn, src: String(node.attrs.src), alt: String(node.attrs.alt ?? "") });
      return standIn;
    }),
    slice.openStart,
    slice.openEnd,
  );
  const tr = view.state.tr;
  insert(tr, clean);
  const placed: Array<{ index: number; pos: number }> = [];
  tr.doc.descendants((node, pos) => {
    const index = standIns.findIndex((standIn) => standIn.node === node);
    if (index >= 0) placed.push({ index, pos });
    return true;
  });
  const end = tr.selection.to;
  const removals = placed.sort((a, b) => b.pos - a.pos).map((entry) => {
    const step = tr.steps.length;
    tr.delete(entry.pos, entry.pos + standIns[entry.index]!.node.nodeSize);
    return { ...entry, step };
  });
  const where = (index: number) => {
    const removal = removals.find((entry) => entry.index === index);
    // A stand-in not found again goes where the pasted content ends.
    return removal ? tr.mapping.slice(removal.step + 1).map(removal.pos) : tr.mapping.slice(removals.length ? removals[0]!.step : tr.steps.length).map(end);
  };
  const refuse = refusals(editor, client);
  // Positions here are in the pasted document, so refusals (whose action follows its position) wait for it.
  const told: Array<() => void> = [];
  const items: Array<{ item: Pending; pos: number }> = [];
  standIns.forEach((standIn, index) => {
    const pos = where(index);
    const name = standIn.alt.trim() || "The pasted image";
    const size = dataUrlBytes(standIn.src) ?? 0;
    if (size > PAGE_IMAGE_MAX_BYTES) return told.push(() => refuse(pageImageTooLarge(name, size)));
    const file = dataUrlFile(standIn.src, index);
    if (!file) return told.push(() => refuse(`${name} couldn't be read, so it was left out.`));
    const [item] = prepare([{ file, alt: standIn.alt }], "image", (message) => told.push(() => refuse(message, { file, pos })));
    if (item) items.push({ item, pos });
  });
  if (items.length) tr.setMeta(UPLOADS, { add: items.map(({ item, pos }) => ({ id: item.id, pos, dom: item.view.dom })) } satisfies UploadMeta);
  view.dispatch(tr.scrollIntoView().setMeta(uiEvent === "paste" ? "paste" : "drop", true).setMeta("uiEvent", uiEvent));
  for (const tell of told) tell();
  if (items.length) void send(editor, items.map(({ item }) => item), client, refuse);
  return true;
}

export { pastedFiles };

/** The system file picker, for images. */
function pickImages(accept: string, done: (files: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = true;
  input.addEventListener("change", () => done(Array.from(input.files ?? [])), { once: true });
  input.addEventListener("cancel", () => done([]), { once: true });
  input.click();
}

/**
 * Dropped and pasted files upload into the page (images as images, the rest as cards); `/file`
 * opens the chooser and `/image` the image picker. Read-only editors leave all of it alone.
 */
export const FileAttach = Extension.create<FileAttachOptions>({
  name: "fileAttach",
  addOptions() {
    return { client: () => null, choose: () => undefined, pickImages };
  },
  addCommands() {
    return {
      chooseFile:
        (pos) =>
        ({ editor, state, dispatch }) => {
          if (dispatch) this.options.choose(editor, pos ?? state.selection.from);
          return true;
        },
      chooseImage:
        (pos) =>
        ({ editor, state, dispatch }) => {
          if (!dispatch) return true;
          const at = pos ?? state.selection.from;
          if (inItemView()) {
            emitToast(SHARED_PAGE, { tone: "error" });
            return true;
          }
          // The picker is modal, but a co-editor's changes can still move the spot.
          const where = followPos(editor, at);
          this.options.pickImages(PAGE_IMAGE_ACCEPT, (files) => {
            const pos = where.at();
            where.stop();
            if (files.length && !editor.isDestroyed) void uploadFiles(editor, files, { pos, client: this.options.client(), as: "image" });
          });
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      uploadsPlugin(),
      new Plugin({
        key: new PluginKey("fileDropPaste"),
        props: {
          handlePaste: (view, event, slice) => {
            if (!editor.isEditable) return false;
            const files = pastedFiles(event.clipboardData);
            if (!files.length) {
              return placeDataImages(editor, view, slice, (tr, clean) => {
                const single = clean.openStart === 0 && clean.openEnd === 0 && clean.content.childCount === 1 ? clean.content.firstChild : null;
                if (single) tr.replaceSelectionWith(single, false);
                else tr.replaceSelection(clean);
              }, "paste", options.client());
            }
            if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection());
            void uploadFiles(editor, files, { pos: view.state.selection.from, client: options.client() });
            return true;
          },
          handleDrop: (view, event, slice, moved) => {
            if (moved || !editor.isEditable) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            if (!files.length) {
              const placed = placeDataImages(editor, view, slice, (tr, clean) => {
                const at = dropPoint(tr.doc, pos, clean) ?? pos;
                tr.replaceRange(at, at, clean);
              }, "drop", options.client());
              if (placed) event.preventDefault();
              return placed;
            }
            event.preventDefault();
            void uploadFiles(editor, files, { pos, client: options.client() });
            return true;
          },
        },
      }),
    ];
  },
});
