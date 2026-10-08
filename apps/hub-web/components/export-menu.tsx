"use client";

import { useState } from "react";
import { Download, FileCode2, FileText, FileType2, Globe, Loader2, NotebookPen, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { ExportDoc } from "@/lib/export/document";
import { DOC_FORMATS, downloadDocument, type DocFormat } from "@/lib/export/formats";
import { Popover } from "./ui";
import { useToast } from "./toast";

const ICONS: Record<DocFormat, LucideIcon> = {
  pdf: FileText,
  docx: FileType2,
  pages: NotebookPen,
  md: FileCode2,
  html: Globe,
  txt: Type,
};

/**
 * The download button next to Share. `load` builds the document only when a format is picked,
 * so the menu costs nothing until someone uses it.
 */
export function ExportMenu({ load, label = "Download", compact = true }: { load: () => ExportDoc | Promise<ExportDoc>; label?: string; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<DocFormat | null>(null);
  const run = async (format: DocFormat, close: () => void) => {
    setBusy(format);
    try {
      await downloadDocument(await load(), format);
      if (format === "pages") toast("Saved as .docx. Open it in Pages to edit.");
      close();
    } catch (error) {
      toast(error instanceof Error ? `Download failed: ${error.message}` : "Download failed", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Popover
      align="right"
      width={232}
      trigger={(open, toggle) => (
        <button
          type="button"
          className={compact ? "icon-btn" : "btn h-7 gap-1.5 px-2.5 text-[12.5px]"}
          aria-label={label}
          aria-expanded={open}
          title={label}
          onClick={toggle}
        >
          <Download size={compact ? 15 : 13} />
          {compact ? null : label}
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={label}>
          <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-faint">Download as</div>
          {DOC_FORMATS.map((format) => {
            const Icon = ICONS[format.id];
            return (
              <button
                key={format.id}
                type="button"
                role="menuitem"
                disabled={busy !== null}
                onClick={() => void run(format.id, close)}
                className="row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] disabled:opacity-50"
              >
                {busy === format.id ? <Loader2 size={14} className="animate-spin text-muted" /> : <Icon size={14} className="text-muted" />}
                <span className="flex-1">{format.label}</span>
                <span className="text-2xs text-faint">{format.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
