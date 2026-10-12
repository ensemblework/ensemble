"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FileRecord } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi } from "@/lib/api-files";
import { saveBlob } from "@/lib/export/formats";

/** The file's record. Shares its cache entry with the page embed, so the data is `{ file }`. */
export function useFileRecord(id: string, enabled = true) {
  return useQuery({ queryKey: FILE_QUERY.one(id), queryFn: () => filesApi.get(id), enabled: enabled && Boolean(id), staleTime: 20_000, retry: false });
}

/** The original bytes, cached by content hash so a saved change loads fresh bytes. Never transfer or detach this buffer. */
export function useFileBytes(file: Pick<FileRecord, "id" | "sha256"> | undefined, enabled = true) {
  return useQuery({
    queryKey: FILE_QUERY.original(file?.id ?? "", file?.sha256 ?? ""),
    queryFn: () => filesApi.original(file!.id),
    enabled: enabled && Boolean(file),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/** A blob: URL for bytes, revoked when the bytes change or the component goes away. */
export function useBlobUrl(bytes: ArrayBuffer | Uint8Array | undefined, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, type]);
  return url;
}

/** Refreshes every list of files without refetching any file's bytes. */
export function invalidateFileLists(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "files" && query.queryKey.length === 2 && query.queryKey[1] !== "import-sources" });
}

/** After a save or replace: the new record goes in the cache, and lists refresh. */
export function useFileSaved() {
  const client = useQueryClient();
  return (file: FileRecord) => {
    client.setQueryData(FILE_QUERY.one(file.id), { file });
    void invalidateFileLists(client);
  };
}

/** Downloads the original. Fetching the bytes (rather than linking) works in the desktop app too. */
export async function downloadFile(file: Pick<FileRecord, "id" | "filename" | "mediaType">, bytes?: ArrayBuffer): Promise<void> {
  const data = bytes ?? (await filesApi.original(file.id));
  saveBlob(new Blob([data], { type: file.mediaType || "application/octet-stream" }), file.filename);
}
