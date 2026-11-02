import { watch } from "chokidar";
import { relative } from "node:path";
import type { HostedClient } from "../remote/client.js";
import { reportChangedPaths } from "../remote/node-files.js";
import { credentialPathReason } from "../evidence/limits.js";
import { refusedPath } from "../workspace/folder-read.js";
import type { ToolFolder } from "./folders.js";

const OMIT = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".turbo", ".cache", ".parcel-cache", ".gradle", ".idea"]);

export function fileWatchFailure(error: unknown): string | null {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  return ["EACCES", "EPERM", "ENOSPC", "ENOSYS", "ENOTSUP", "EMFILE", "ENFILE"].includes(code) ? `Edited-file tracking is unavailable in this folder (${code}). The command can still run, but its file list may need to be refreshed manually.` : null;
}

/** Watches metadata, not contents, only while a node's command is alive. */
export async function trackFileChanges(client: Pick<HostedClient, "reportFileChanges">, request: { nodeId: string; operationId?: string }, folder: ToolFolder, warn: (error: unknown) => void): Promise<() => Promise<void>> {
  const paths = new Set<string>();
  const watcher = watch(folder.path, {
    ignoreInitial: true, followSymlinks: false, persistent: false,
    ignored: path => {
      const inner = relative(folder.path, path).replace(/\\/g, "/");
      return inner.split("/").some(part => OMIT.has(part) || part.startsWith(".ensemble-save-")) || Boolean(refusedPath(inner) || credentialPathReason(inner));
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = Promise.resolve();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = [...paths]; paths.clear();
    pending = pending.then(() => reportChangedPaths(client, request, folder, next)).catch(warn);
    return pending;
  };
  watcher.on("all", (event, path) => {
    if (event !== "add" && event !== "change" && event !== "unlink") return;
    paths.add(relative(folder.path, path));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 600);
    timer.unref();
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  }).catch(async error => { await watcher.close(); throw error; });
  watcher.removeAllListeners("error");
  watcher.on("error", warn);
  return async () => {
    // Let the last filesystem event reach the watcher before closing a short-lived command.
    await new Promise(resolve => setTimeout(resolve, 120));
    await watcher.close();
    await flush();
  };
}
