"use client";

/**
 * Heavy editors stay in their own chunks. Pages that can open a task or a
 * review warm them after the page is interactive, and again on hover or
 * focus. Other routes do not download TipTap or CodeMirror.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";

type PeekModule = typeof import("@/components/shell/peek-panel");
type EditorModule = typeof import("@/components/editor/block-editor");
type FileModule = typeof import("@/components/code/file-editor");

let peekPromise: Promise<PeekModule> | null = null;
let editorPromise: Promise<EditorModule> | null = null;
let filePromise: Promise<FileModule> | null = null;

export let peekPanel: PeekModule["PeekPanel"] | null = null;
export let blockEditor: EditorModule["BlockEditor"] | null = null;
export let fileEditor: FileModule["FileEditor"] | null = null;

export function warmPeek(): Promise<unknown> {
  peekPromise ??= import("@/components/shell/peek-panel").then((mod) => {
    peekPanel = mod.PeekPanel;
    return mod;
  });
  editorPromise ??= import("@/components/editor/block-editor").then((mod) => {
    blockEditor = mod.BlockEditor;
    return mod;
  });
  return Promise.all([peekPromise, editorPromise]);
}

/** Editor chunk plus the two reads a peek blocks on, started from hover or focus. */
export function warmTask(client: QueryClient, id: string): void {
  void warmPeek();
  void client.prefetchQuery({ queryKey: ["task", id], queryFn: () => api.task(id), staleTime: 20_000 });
  void client.prefetchQuery({ queryKey: ["page", id], queryFn: () => api.page(id), staleTime: 20_000 });
}

export function warmFileEditor(): Promise<FileModule> {
  filePromise ??= import("@/components/code/file-editor").then((mod) => {
    fileEditor = mod.FileEditor;
    return mod;
  });
  return filePromise;
}

type NetworkInfo = { saveData?: boolean; effectiveType?: string };

/** Save-Data and 2G skip speculative chunk downloads. Hover and focus still warm. */
function allowSpeculative(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== "slow-2g" && conn.effectiveType !== "2g";
}

export function useWarmEditors(kind: "peek" | "file"): void {
  useEffect(() => {
    if (!allowSpeculative()) return;
    const run = () => {
      if (kind === "peek") void warmPeek();
      else void warmFileEditor();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 300);
    return () => window.clearTimeout(id);
  }, [kind]);
}
