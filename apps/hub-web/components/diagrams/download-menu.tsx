"use client";

import { useState } from "react";
import { Download, FileImage, FileText, Image as ImageIcon, Loader2, Shapes } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { parseDiagram } from "@ensemble/block-diagrams";

import { api } from "@/lib/api";
import { Popover } from "../ui";
import { useToast } from "../toast";
import { downloadDiagram, type DiagramExportKind } from "./export-image";

const KINDS: Array<{ id: DiagramExportKind; label: string; icon: LucideIcon }> = [
  { id: "png", label: "PNG image", icon: ImageIcon },
  { id: "svg", label: "SVG vector", icon: Shapes },
  { id: "pdf", label: "PDF", icon: FileText },
  { id: "jpg", label: "JPG image", icon: FileImage },
];

/** Download a diagram straight from the list, without opening it. */
export function DiagramDownloadMenu({ id }: { id: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<DiagramExportKind | null>(null);
  const run = async (kind: DiagramExportKind, close: () => void) => {
    setBusy(kind);
    try {
      const { diagram } = await api.diagram(id);
      await downloadDiagram(parseDiagram(diagram.source).model, kind);
      close();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Download failed", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Popover
      align="right"
      width={196}
      trigger={(open, toggle) => (
        <button type="button" className="icon-btn" aria-label="Download diagram" aria-expanded={open} title="Download" onClick={toggle}>
          <Download size={15} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Download diagram">
          {KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void run(kind.id, close)}
              className="row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] disabled:opacity-50"
            >
              {busy === kind.id ? <Loader2 size={14} className="animate-spin text-muted" /> : <kind.icon size={14} className="text-muted" />}
              {kind.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
