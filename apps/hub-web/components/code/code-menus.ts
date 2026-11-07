"use client";

/**
 * The Code tab's right-click menus, as an IDE's: the explorer's files and folders, the folder itself, the
 * editor's tabs and the editor. Beside VS Code's own (new, rename, delete, copy path, reveal, download)
 * they hand code to the assistant and turn it into a task.
 */
import {
  Clipboard,
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileSymlink,
  FolderPlus,
  ListTodo,
  LocateFixed,
  Pencil,
  RefreshCw,
  Scissors,
  ChevronsDownUp,
  Trash2,
  X,
  ArrowUpRight,
  MessageSquarePlus,
  Paperclip,
  Sparkles,
} from "lucide-react";
import { copyText } from "@/components/context-menu/builders";
import type { MenuAction, MenuSection, MenuSpec } from "@/components/context-menu/menu-store";
import { api, type CodeDownload } from "@/lib/api";
import { attachToAssistant, type AssistantAttachment } from "@/lib/assistant-attach";
import type { CodeApi, Source } from "@/lib/code-target";
import { previewOf } from "@/lib/file-kinds";
import type { ToastOptions } from "@/lib/toast-bus";

export const CODE_ASKS = [
  { id: "explain-code", label: "Explain this code", prompt: "Explain what this code does, step by step, and anything surprising in it." },
  { id: "find-bugs", label: "Find bugs", prompt: "Look for bugs, edge cases and risky spots in this code. Say where each is and how to fix it." },
  { id: "improve-code", label: "Suggest improvements", prompt: "How could this code be clearer, safer or faster? Show the changed code." },
  { id: "write-tests", label: "Write tests", prompt: "Write tests for this code, in the framework and style the project already uses." },
  { id: "document-code", label: "Write doc comments", prompt: "Write concise doc comments for this code." },
];

export type CodeMenuContext = {
  code: CodeApi;
  source: Source;
  /** The repository's folder on its computer, for Copy path. */
  repo: string;
  /** Its name, for where an attachment comes from. */
  repoLabel: string;
  viewOnly: boolean;
  toast: (text: string, options?: ToastOptions) => void;
  open: (path: string) => void;
  /** The file's text as the editor has it (unsaved typing included), or read from disk. */
  text: (path: string) => Promise<string>;
  preview?: (path: string) => void;
  newEntry?: (kind: "file" | "folder", folder: string) => void;
  rename?: (path: string) => void;
  removed?: (path: string) => void;
  refresh?: () => void;
  collapse?: () => void;
  reveal?: (path: string) => void;
};

const MAX_ATTACH = 5800;
const fence = (path: string, text: string) => {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  const body = text.length > MAX_ATTACH ? `${text.slice(0, MAX_ATTACH)}\n… (the rest of the file is cut here)` : text;
  return `\`\`\`${ext}\n${body}\n\`\`\``;
};
const absolute = (repo: string, path: string) => (path ? `${repo.replace(/[\\/]+$/, "")}/${path}` : repo);
const nameOf = (path: string) => path.split("/").pop() || path;
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Downloads a file, or a folder (the whole repository for `""`) as a zip, up to 20 MB. */
export async function downloadFromCode(code: CodeApi, source: Source, path: string, toast: CodeMenuContext["toast"]): Promise<void> {
  try {
    const packed: CodeDownload = await code.download(source, path);
    const blob = new Blob([fromBase64(packed.data)], { type: packed.kind === "zip" ? "application/zip" : "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = packed.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error instanceof Error ? error.message : "That could not be downloaded.", { tone: "error" });
  }
}

/** The bytes of an image, for Preview (via the same call as a download). */
export async function codeImageUrl(code: CodeApi, source: Source, path: string): Promise<string> {
  const packed = await code.download(source, path);
  const ext = path.split(".").pop()!.toLowerCase();
  const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : ext === "ico" ? "image/x-icon" : `image/${ext}`;
  return URL.createObjectURL(new Blob([fromBase64(packed.data)], { type }));
}

const attachmentFor = (ctx: CodeMenuContext, path: string, text: string, lines?: string): AssistantAttachment => ({
  text: fence(path, text),
  source: { kind: "file", id: ctx.repoLabel, title: lines ? `${path}:${lines}` : path },
});

/** Ask, attach and make a task from a file (its text read when the item is picked). */
function codeAskItems(ctx: CodeMenuContext, path: string, selection?: { text: string; line: number; endLine: number }): MenuAction[] {
  const lines = selection ? (selection.line === selection.endLine ? `${selection.line}` : `${selection.line}-${selection.endLine}`) : undefined;
  const load = async () => (selection ? selection.text : await ctx.text(path));
  const ask = (prompt?: string) => async () => {
    attachToAssistant({ attachment: attachmentFor(ctx, path, await load(), lines), ...(prompt ? { prompt, send: true } : {}) });
  };
  return [
    {
      id: "ask",
      label: "Ask Ensemble",
      icon: Sparkles,
      submenu: () => ({
        sections: [
          { items: CODE_ASKS.map((preset) => ({ id: `ask-${preset.id}`, label: preset.label, run: ask(preset.prompt) })) },
          { items: [{ id: "ask-own", label: "Ask something else…", icon: MessageSquarePlus, run: ask() }] },
        ],
      }),
    },
    { id: "attach", label: selection ? "Attach selection to assistant" : "Attach file to assistant", icon: Paperclip, run: ask() },
    {
      id: "code-task",
      label: selection ? "New task from selection" : "New task about this file",
      icon: ListTodo,
      run: async () => {
        const text = await load();
        const where = lines ? `${path} (lines ${lines})` : path;
        const { task } = await api.createTask({ title: `Look at ${nameOf(path)}${lines ? `:${lines}` : ""}`, description: `${where} in ${ctx.repoLabel}\n\n${fence(path, text)}` });
        ctx.toast(`Task made: ${task.title}`, { tone: "ok", action: { label: "Open", run: () => window.open(`/tasks/${task.id}`, "_self") } });
      },
    },
  ];
}

function copyItems(ctx: CodeMenuContext, path: string, line?: number): MenuAction[] {
  return [
    { id: "copy-path", label: "Copy path", icon: ClipboardCopy, run: () => copyText(absolute(ctx.repo, path)) },
    { id: "copy-relative", label: "Copy relative path", icon: Copy, run: () => copyText(path || ".") },
    ...(line ? [{ id: "copy-line", label: `Copy path with line (:${line})`, icon: Copy, run: () => copyText(`${path}:${line}`) }] : []),
    ...(path ? [{ id: "copy-name", label: "Copy name", icon: Copy, run: () => copyText(nameOf(path)) }] : []),
  ];
}

/** A file or folder in the explorer. */
export function explorerMenu(ctx: CodeMenuContext, entry: { path: string; dir: boolean }): MenuSpec {
  const { path, dir } = entry;
  const can = !ctx.viewOnly;
  const sections: MenuSection[] = [];
  if (dir) {
    if (can && ctx.newEntry) {
      sections.push({
        items: [
          { id: "new-file", label: "New file…", icon: FilePlus2, run: () => ctx.newEntry!("file", path) },
          { id: "new-folder", label: "New folder…", icon: FolderPlus, run: () => ctx.newEntry!("folder", path) },
        ],
      });
    }
  } else {
    sections.push({
      items: [
        { id: "open", label: "Open", icon: ArrowUpRight, run: () => ctx.open(path) },
        ...(previewOf(path) && ctx.preview ? [{ id: "preview", label: "Open preview", icon: Eye, hint: "Ctrl+Shift+V", run: () => ctx.preview!(path) }] : []),
      ],
    });
    sections.push({ items: codeAskItems(ctx, path) });
  }
  sections.push({ items: copyItems(ctx, path) });
  if (can) {
    sections.push({
      items: [
        ...(ctx.rename ? [{ id: "rename", label: "Rename…", icon: Pencil, hint: "F2", run: () => ctx.rename!(path) }] : []),
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          danger: true,
          hint: "Del",
          confirm: () => ({
            title: `Delete ${nameOf(path)}${dir ? " and everything in it" : ""}?`,
            body: "It is removed from the folder on disk. Git can bring back what was committed.",
            action: "Delete",
            danger: true,
          }),
          run: async () => {
            try {
              await ctx.code.remove(ctx.source, path);
              ctx.removed?.(path);
            } catch (error) {
              ctx.toast(error instanceof Error ? error.message : "That could not be deleted.", { tone: "error" });
            }
          },
        },
      ],
    });
  }
  sections.push({ items: [{ id: "download", label: dir ? "Download as zip" : "Download", icon: Download, run: () => downloadFromCode(ctx.code, ctx.source, path, ctx.toast) }] });
  return { title: nameOf(path), sections };
}

/** The explorer's empty space and the Folder header: the repository itself. */
export function folderMenu(ctx: CodeMenuContext, folder = ""): MenuSpec {
  const can = !ctx.viewOnly;
  return {
    title: ctx.repoLabel,
    sections: [
      ...(can && ctx.newEntry
        ? [
            {
              items: [
                { id: "new-file", label: "New file…", icon: FilePlus2, run: () => ctx.newEntry!("file", folder) },
                { id: "new-folder", label: "New folder…", icon: FolderPlus, run: () => ctx.newEntry!("folder", folder) },
              ],
            },
          ]
        : []),
      {
        items: [
          ...(ctx.refresh ? [{ id: "refresh", label: "Refresh", icon: RefreshCw, run: ctx.refresh }] : []),
          ...(ctx.collapse ? [{ id: "collapse", label: "Collapse folders", icon: ChevronsDownUp, run: ctx.collapse }] : []),
        ],
      },
      { items: copyItems(ctx, folder) },
      { items: [{ id: "download-repo", label: folder ? "Download folder as zip" : "Download repository as zip", icon: Download, hint: "≤ 20 MB", run: () => downloadFromCode(ctx.code, ctx.source, folder, ctx.toast) }] },
    ],
  };
}

/** An editor tab. */
export function tabMenu(ctx: CodeMenuContext, path: string, tabs: string[], close: (paths: string[]) => void): MenuSpec {
  const index = tabs.indexOf(path);
  const right = tabs.slice(index + 1);
  const others = tabs.filter((row) => row !== path);
  return {
    title: nameOf(path),
    sections: [
      {
        items: [
          { id: "close", label: "Close", icon: X, run: () => close([path]) },
          { id: "close-others", label: "Close others", disabled: !others.length, run: () => close(others) },
          { id: "close-right", label: "Close to the right", disabled: !right.length, run: () => close(right) },
          { id: "close-all", label: "Close all", run: () => close(tabs) },
        ],
      },
      { items: copyItems(ctx, path) },
      {
        items: [
          ...(ctx.reveal ? [{ id: "reveal", label: "Reveal in explorer", icon: LocateFixed, run: () => ctx.reveal!(path) }] : []),
          ...(previewOf(path) && ctx.preview ? [{ id: "preview", label: "Open preview", icon: Eye, run: () => ctx.preview!(path) }] : []),
          { id: "download", label: "Download", icon: Download, run: () => downloadFromCode(ctx.code, ctx.source, path, ctx.toast) },
        ],
      },
    ],
  };
}

/** Inside the editor: the selection (or the file), the clipboard, paths. */
export function codeEditorMenu(
  ctx: CodeMenuContext,
  path: string,
  editor: { selected: () => { text: string; line: number; endLine: number }; insert: (text: string) => void },
  readOnly: boolean,
): MenuSpec {
  const picked = editor.selected();
  const selection = picked.text.trim() ? picked : undefined;
  return {
    title: nameOf(path),
    sections: [
      { items: codeAskItems(ctx, path, selection) },
      {
        items: [
          {
            id: "clipboard",
            row: [
              ...(readOnly ? [] : [{ id: "cut", label: "Cut", icon: Scissors, hint: "Ctrl+X", disabled: !selection, run: async () => { await copyText(picked.text); editor.insert(""); } }]),
              { id: "copy", label: "Copy", icon: Copy, hint: "Ctrl+C", disabled: !selection, run: () => copyText(picked.text) },
              ...(readOnly ? [] : [{ id: "paste", label: "Paste", icon: Clipboard, hint: "Ctrl+V", disabled: !navigator.clipboard?.readText, run: async () => editor.insert(await navigator.clipboard.readText()) }]),
            ],
          },
        ],
      },
      { items: copyItems(ctx, path, picked.line) },
      {
        items: [
          ...(ctx.reveal ? [{ id: "reveal", label: "Reveal in explorer", icon: LocateFixed, run: () => ctx.reveal!(path) }] : []),
          ...(previewOf(path) && ctx.preview ? [{ id: "preview", label: "Open preview", icon: Eye, hint: "Ctrl+Shift+V", run: () => ctx.preview!(path) }] : []),
          { id: "download", label: "Download file", icon: FileSymlink, run: () => downloadFromCode(ctx.code, ctx.source, path, ctx.toast) },
        ],
      },
    ],
  };
}

export { folderOf, nameOf };
