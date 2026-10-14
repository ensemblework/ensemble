"use client";
import { BrandMorph } from "@/components/motion/brand-morph";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useState } from "react";
import { FileOutput } from "lucide-react";
import { fileFormat, type PageDocument } from "@ensemble/shared-types";
import { inItemView, type PageSourceFile } from "@/lib/api";
import { exportBack, exportBackFormats, type ExportBackFormat } from "@/lib/files/export-back";
import type { ExportExtra } from "../export-menu";
import { useToast } from "../toast";
import { OpenFileLink, fileKindIcon } from "./file-embed";

const FORMAT: Record<ExportBackFormat, { label: string; hint: string; note: string }> = {
  pdf: { label: "PDF", hint: ".pdf", note: "PDF keeps page size, margins, sizes and colours (fonts matched to the nearest standard font)." },
  docx: { label: "Word", hint: ".docx", note: "Word keeps the original's styles, fonts, page setup, headers and footers." },
};

type PageNow = () => { title: string; doc: PageDocument };

/** Download-menu items that turn the page back into its original's format. */
export function exportBackItems(source: PageSourceFile | null | undefined, page: PageNow, run = exportBack): ExportExtra[] {
  if (!source) return [];
  return exportBackFormats(source).map((format) => ({
    id: format,
    label: FORMAT[format].label,
    hint: FORMAT[format].hint,
    run: () => run({ ...page(), fileId: source.id, format }),
  }));
}

/** "Made from report.pdf" over a page converted from a file: the original, and the way back to its format. */
export function SourceFileBanner({ source, page, run = exportBack }: { source: PageSourceFile; page: PageNow; run?: typeof exportBack }) {
  const toast = useToast();
  const [busy, setBusy] = useState<ExportBackFormat | null>(null);
  const formats = exportBackFormats(source);
  const Icon = fileKindIcon(fileFormat(source.filename).kind);
  const exportAs = async (format: ExportBackFormat) => {
    setBusy(format);
    try {
      await run({ ...page(), fileId: source.id, format });
    } catch (error) {
      toast(error instanceof Error ? `Export failed: ${error.message}` : "Export failed", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div role="note" aria-label="Made from a file" className="mb-4 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] text-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Icon size={13} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          Made from <span className="font-medium text-ink">{source.filename}</span>
        </span>
        <span aria-hidden>·</span>
        <OpenFileLink id={source.id} filename={source.filename} className="text-accent hover:underline">
          {inItemView() ? "Download the original" : "Open the original"}
        </OpenFileLink>
        {formats.length ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {formats.map((format) => (
              <button
                key={format}
                type="button"
                className="btn-ghost h-6 px-2 text-[12px]"
                disabled={busy !== null}
                title={`Export back as ${FORMAT[format].label} with the original's formatting`}
                onClick={() => void exportAs(format)}
              >
                {busy === format ? <BrandMorph size={12} kind="beacon" loader state="loop" /> : <FileOutput size={12} />}
                Export back as {FORMAT[format].label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {formats.length ? <p className="mt-1 text-[12px] text-faint">{formats.map((format) => FORMAT[format].note).join(" ")}</p> : null}
    </div>
  );
}
