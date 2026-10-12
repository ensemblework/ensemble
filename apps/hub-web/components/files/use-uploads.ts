"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { FileRecord, FileUsage } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { emitToast } from "@/lib/toast-bus";
import { invalidateFileLists } from "./use-file";

export type UploadItem = {
  key: string;
  name: string;
  size: number;
  /** 0–1 */
  progress: number;
  state: "waiting" | "uploading" | "done" | "failed";
  error?: string;
  file?: FileRecord;
};

const ROOM = "Delete a file to make room, or use the Ensemble desktop app, which has no limit.";

/** Files that fit the account's limits, and a plain sentence for the ones that do not. */
export function checkUploads(files: File[], usage: FileUsage | undefined): { accepted: File[]; problem: string | null } {
  if (!usage) return { accepted: files, problem: null };
  const tooBig = files.filter((file) => file.size > usage.maxFileBytes);
  let accepted = files.filter((file) => file.size <= usage.maxFileBytes);
  let problem: string | null = null;
  if (tooBig.length) {
    problem =
      tooBig.length === 1
        ? `${tooBig[0]!.name} is ${formatBytes(tooBig[0]!.size)}. Each file can be up to ${formatBytes(usage.maxFileBytes)} here.`
        : `${tooBig.length} files are over ${formatBytes(usage.maxFileBytes)}, the most one file can be here.`;
  }
  if (usage.maxCount !== null && usage.count + accepted.length > usage.maxCount) {
    const room = Math.max(0, usage.maxCount - usage.count);
    accepted = accepted.slice(0, room);
    problem = room
      ? `Only ${room} more ${room === 1 ? "file fits" : "files fit"}: hosted accounts keep up to ${usage.maxCount} files. ${ROOM}`
      : `Files is full: hosted accounts keep up to ${usage.maxCount} files. ${ROOM}`;
  }
  if (usage.maxBytes !== null) {
    let used = usage.bytes;
    const fits: File[] = [];
    for (const file of accepted) {
      if (used + file.size > usage.maxBytes) continue;
      used += file.size;
      fits.push(file);
    }
    if (fits.length < accepted.length) problem = `That would pass the ${formatBytes(usage.maxBytes)} hosted accounts can keep (${formatBytes(usage.bytes)} used). ${ROOM}`;
    accepted = fits;
  }
  return { accepted, problem };
}

/** Uploads one file at a time with progress, and refreshes the file lists when done. */
export function useFileUploads() {
  const client = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const counter = useRef(0);

  const update = (key: string, patch: Partial<UploadItem>) => setItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const start = useCallback(
    (files: File[]): void => {
      if (!files.length) return;
      const usage = client.getQueryData<{ usage: FileUsage }>(FILE_QUERY.list(""))?.usage;
      const { accepted, problem } = checkUploads(files, usage);
      if (problem) emitToast(problem, { tone: "error" });
      if (!accepted.length) return;
      const batch = accepted.map((file) => ({ file, key: `upload-${++counter.current}` }));
      setItems((rows) => [...rows.filter((row) => row.state !== "done"), ...batch.map(({ file, key }) => ({ key, name: file.name, size: file.size, progress: 0, state: "waiting" as const }))]);
      queue.current = queue.current.then(async () => {
        let done = 0;
        for (const { file, key } of batch) {
          update(key, { state: "uploading" });
          try {
            const result = await filesApi.upload(file, { onProgress: (fraction) => update(key, { progress: fraction }) });
            update(key, { state: "done", progress: 1, file: result.file });
            done += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "The upload failed.";
            update(key, { state: "failed", error: message });
            emitToast(`${file.name}: ${message}`, { tone: "error" });
          }
        }
        await invalidateFileLists(client);
        if (done) emitToast(done === 1 ? "Uploaded 1 file." : `Uploaded ${done} files.`, { tone: "ok" });
      });
    },
    [client],
  );

  const dismiss = useCallback((key: string) => setItems((rows) => rows.filter((row) => row.key !== key)), []);
  return { items, start, dismiss };
}
