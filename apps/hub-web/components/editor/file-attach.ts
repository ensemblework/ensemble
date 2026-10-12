import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { QueryClient } from "@tanstack/react-query";
import type { FileRecord } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi } from "@/lib/api-files";
import { emitToast } from "@/lib/toast-bus";

export type FileAttachOptions = {
  /** The app's query cache. Uploads refresh the file lists and the @ menu through it. */
  client: () => QueryClient | null;
  /** Opens the /file chooser for a document position. */
  choose: (editor: Editor, pos: number) => void;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileAttach: {
      /** Opens the /file chooser at a position, the cursor by default. */
      chooseFile: (pos?: number) => ReturnType;
    };
  }
}

type UploadMeta = { add?: Array<{ id: string; pos: number; name: string }>; remove?: string };

const UPLOADS = new PluginKey<DecorationSet>("fileUploads");

function placeholder(name: string): HTMLElement {
  const dom = document.createElement("span");
  dom.className = "file-upload-placeholder inline-flex items-center rounded border border-dashed border-line px-2 py-0.5 text-[12.5px] text-muted";
  dom.contentEditable = "false";
  dom.setAttribute("role", "status");
  dom.textContent = `Uploading ${name}…`;
  return dom;
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
          next = next.add(tr.doc, meta.add.map((upload, index) => Decoration.widget(upload.pos, () => placeholder(upload.name), { id: upload.id, side: index + 1 })));
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

/**
 * Uploads files one at a time and puts a card for each where it was dropped, pasted or chosen.
 * A placeholder whose spot was deleted meanwhile drops its card; the file stays in Files.
 */
export async function uploadFiles(editor: Editor, files: File[], options: { pos?: number; client?: QueryClient | null } = {}): Promise<FileRecord[]> {
  if (!files.length || editor.isDestroyed) return [];
  const pos = Math.min(options.pos ?? editor.state.selection.from, editor.state.doc.content.size);
  const queue = files.map((file) => ({ id: `upload-${++uploads}`, file }));
  editor.view.dispatch(editor.state.tr.setMeta(UPLOADS, { add: queue.map(({ id, file }) => ({ id, pos, name: file.name })) } satisfies UploadMeta));
  const done: FileRecord[] = [];
  const told = new Set<string>();
  for (const { id, file } of queue) {
    let record: FileRecord | null = null;
    try {
      record = (await filesApi.upload(file)).file;
      done.push(record);
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "Upload failed.";
      // A limit stops every file after it with the same words. Say it once.
      if (!told.has(reason)) emitToast(`Could not upload ${file.name}. ${reason}`, { tone: "error" });
      told.add(reason);
    }
    if (editor.isDestroyed) continue;
    const at = placeholderPos(editor.state, id);
    const chain = editor.chain().command(({ tr }) => {
      tr.setMeta(UPLOADS, { remove: id } satisfies UploadMeta);
      return true;
    });
    if (record && at !== null) chain.insertContentAt(at, fileMentionContent(record), { updateSelection: false });
    chain.run();
  }
  if (done.length && options.client) {
    void options.client.invalidateQueries({ queryKey: FILE_QUERY.all });
    void options.client.invalidateQueries({ queryKey: ["entities"] });
  }
  return done;
}

function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
}

/** Files on the clipboard, unless they ride along with copied text: Word, Excel and browsers add a picture of the selection. */
export function pastedFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  if (!data || !files.length) return [];
  const types = Array.from(data.types ?? []);
  if (types.includes("text/rtf")) return [];
  const html = types.includes("text/html") ? data.getData("text/html") : "";
  return html && htmlText(html) ? [] : files;
}

/** Dropped and pasted files upload into the page; `/file` opens the chooser. Read-only editors leave both alone. */
export const FileAttach = Extension.create<FileAttachOptions>({
  name: "fileAttach",
  addOptions() {
    return { client: () => null, choose: () => undefined };
  },
  addCommands() {
    return {
      chooseFile:
        (pos) =>
        ({ editor, state, dispatch }) => {
          if (dispatch) this.options.choose(editor, pos ?? state.selection.from);
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
          handlePaste: (view, event) => {
            if (!editor.isEditable) return false;
            const files = pastedFiles(event.clipboardData);
            if (!files.length) return false;
            if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection());
            void uploadFiles(editor, files, { pos: view.state.selection.from, client: options.client() });
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !editor.isEditable) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            void uploadFiles(editor, files, { pos, client: options.client() });
            return true;
          },
        },
      }),
    ];
  },
});
