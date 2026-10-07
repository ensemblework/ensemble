"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { ImportDialog } from "@/components/imports/import-dialog";

/** Opens the import flow. `source` preselects an app (an import source or connector id). */
export function ImportLauncher({ open, source, onClose }: { open: boolean; source?: string; onClose: () => void }) {
  return <ImportDialog open={open} onClose={onClose} initialSource={source} />;
}
