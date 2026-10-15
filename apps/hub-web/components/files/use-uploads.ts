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

export type Duplicate = {
  file: File;
  /** The file already in Files that this one repeats. */
  match: FileRecord;
  /** "content": the same bytes. "name": the same name with different bytes, such as a newer version. */
  same: "content" | "name";
};

export type DuplicateChoice = "skip" | "keep" | "replace";

type Candidate = { name: string; size: number; sha256: string | null };

/**
 * Which picked files are already in Files: the same content (by SHA-256, which every file record
 * carries), else the same name. A second copy inside one batch counts against the first.
 */
export function findDuplicates<T extends Candidate>(picked: T[], existing: FileRecord[]): { fresh: T[]; duplicates: Array<{ item: T; match: FileRecord | null; same: "content" | "name" }> } {
  const fresh: T[] = [];
  const duplicates: Array<{ item: T; match: FileRecord | null; same: "content" | "name" }> = [];
  const seen = new Set<string>();
  for (const item of picked) {
    const byContent = item.sha256 ? existing.find((file) => file.sha256 === item.sha256) : undefined;
    const byName = existing.find((file) => file.filename.toLowerCase() === item.name.toLowerCase());
    const key = item.sha256 ?? `${item.name.toLowerCase()}:${item.size}`;
    if (byContent) duplicates.push({ item, match: byContent, same: "content" });
    else if (byName) duplicates.push({ item, match: byName, same: byName.byteSize === item.size && !item.sha256 ? "content" : "name" });
    else if (seen.has(key)) duplicates.push({ item, match: null, same: "content" });
    else fresh.push(item);
    seen.add(key);
  }
  return { fresh, duplicates };
}

async function sha256(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Uploads one file at a time with progress, and refreshes the file lists when done. A file already in Files waits for a choice. */
export function useFileUploads() {
  const client = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [review, setReview] = useState<{ duplicates: Duplicate[]; fresh: File[] } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const counter = useRef(0);

  const update = (key: string, patch: Partial<UploadItem>) => setItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const send = useCallback(
    (files: File[], replacing: Array<{ file: File; match: FileRecord }> = []): void => {
      const usage = client.getQueryData<{ usage: FileUsage }>(FILE_QUERY.list(""))?.usage;
      const { accepted, problem } = checkUploads(files, usage);
      if (problem) emitToast(problem, { tone: "error" });
      if (!accepted.length && !replacing.length) return;
      const batch = [
        ...accepted.map((file) => ({ file, match: null as FileRecord | null, key: `upload-${++counter.current}` })),
        ...replacing.map(({ file, match }) => ({ file, match, key: `upload-${++counter.current}` })),
      ];
      setItems((rows) => [...rows.filter((row) => row.state !== "done"), ...batch.map(({ file, key }) => ({ key, name: file.name, size: file.size, progress: 0, state: "waiting" as const }))]);
      queue.current = queue.current.then(async () => {
        let done = 0;
        let replaced = 0;
        for (const { file, match, key } of batch) {
          update(key, { state: "uploading" });
          try {
            const result = match
              ? await filesApi.replace(match.id, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, mediaType: file.type || undefined })
              : await filesApi.upload(file, { onProgress: (fraction) => update(key, { progress: fraction }) });
            update(key, { state: "done", progress: 1, file: result.file });
            if (match) replaced += 1;
            else done += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "The upload failed.";
            update(key, { state: "failed", error: message });
            emitToast(`${file.name}: ${message}`, { tone: "error" });
          }
        }
        await invalidateFileLists(client);
        const said = [done ? (done === 1 ? "Uploaded 1 file." : `Uploaded ${done} files.`) : "", replaced ? (replaced === 1 ? "Replaced 1 file." : `Replaced ${replaced} files.`) : ""].filter(Boolean).join(" ");
        if (said) emitToast(said, { tone: "ok" });
      });
    },
    [client],
  );

  const start = useCallback(
    (files: File[]): void => {
      if (!files.length) return;
      const existing = client.getQueryData<{ files: FileRecord[] }>(FILE_QUERY.list(""))?.files ?? [];
      void (async () => {
        // Only a file the size of one already here can have its content; the others are not read twice.
        const sizes = new Set(existing.map((file) => file.byteSize));
        const picked = await Promise.all(files.map(async (file) => ({ file, name: file.name, size: file.size, sha256: sizes.has(file.size) || files.some((other) => other !== file && other.size === file.size) ? await sha256(file) : null })));
        const { fresh, duplicates } = findDuplicates(picked, existing);
        const inBatch = duplicates.filter((row) => !row.match);
        if (inBatch.length) emitToast(inBatch.length === 1 ? `${inBatch[0]!.item.name} was picked twice, so it is added once.` : `${inBatch.length} files were picked twice, so each is added once.`);
        const known = duplicates.flatMap((row) => (row.match ? [{ file: row.item.file, match: row.match, same: row.same }] : []));
        if (known.length) setReview({ duplicates: known, fresh: fresh.map((row) => row.file) });
        else send(fresh.map((row) => row.file));
      })();
    },
    [client, send],
  );

  /** The choice for every file in the review: skip them, add them as new files, or put a new version's bytes into the file with its name. */
  const resolve = useCallback(
    (choice: DuplicateChoice | "cancel"): void => {
      const current = review;
      setReview(null);
      if (!current || choice === "cancel") return;
      const { duplicates, fresh } = current;
      if (choice === "keep") return send([...fresh, ...duplicates.map((row) => row.file)]);
      const replacing = choice === "replace" ? duplicates.filter((row) => row.same === "name") : [];
      const skipped = duplicates.length - replacing.length;
      if (skipped) emitToast(skipped === 1 ? `Skipped ${duplicates.find((row) => !replacing.includes(row))!.file.name}: it is already in Files.` : `Skipped ${skipped} files already in Files.`);
      send(fresh, replacing);
    },
    [review, send],
  );

  const dismiss = useCallback((key: string) => setItems((rows) => rows.filter((row) => row.key !== key)), []);
  return { items, start, dismiss, review, resolve };
}
