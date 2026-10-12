"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { FileRecord } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi } from "@/lib/api-files";
import { emitToast } from "@/lib/toast-bus";
import { Dialog, Spinner } from "../ui";
import { invalidateFileLists } from "./use-file";

/** "Delete this file?" for the Files list and a file's own screen. `file` null keeps it closed. */
export function DeleteFileDialog({ file, onClose, onDeleted }: { file: Pick<FileRecord, "id" | "filename"> | null; onClose: () => void; onDeleted?: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await filesApi.remove(file.id);
      client.removeQueries({ queryKey: FILE_QUERY.one(file.id) });
      await invalidateFileLists(client);
      onDeleted?.();
      onClose();
      emitToast(`Deleted ${file.filename}.`);
    } catch (error) {
      emitToast(error instanceof Error ? error.message : "Could not delete the file.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={file !== null} onClose={onClose} title="Delete this file?" width={440}>
      <div className="space-y-3 text-[13px] leading-5">
        <p>
          <span className="font-medium">{file?.filename}</span> will be deleted from Ensemble. Pages it is attached to will show that it was removed. Pages made from it stay.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="btn-danger" disabled={busy} onClick={() => void remove()}>
            {busy ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden />} Delete
          </button>
        </div>
      </div>
    </Dialog>
  );
}
