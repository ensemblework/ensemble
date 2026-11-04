"use client";
import { BrandMorph } from "@/components/motion/brand-morph";

import { useState } from "react";
import { ChevronDown, Copy, Download, FileCode2, FileImage, FileText, Image as ImageIcon, MoreHorizontal, Shapes, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { parseDiagram, toMermaid, type DiagramModel } from "@ensemble/block-diagrams";

import { api } from "@/lib/api";
import { Popover } from "../ui";
import { useToast } from "../toast";
import { copyDiagramPng, downloadDiagram, type DiagramExportKind } from "./export-image";

export const EXPORT_KINDS: Array<{ id: DiagramExportKind; label: string; icon: LucideIcon }> = [
  { id: "png", label: "PNG image", icon: ImageIcon },
  { id: "svg", label: "SVG vector", icon: Shapes },
  { id: "pdf", label: "PDF", icon: FileText },
  { id: "jpg", label: "JPG image", icon: FileImage },
];

function MenuRow({ icon: Icon, label, busy, danger, disabled, onClick }: { icon: LucideIcon; label: string; busy?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="dg-pop-item" data-danger={danger || undefined}>
      {busy ? <BrandMorph size={15} kind="beacon" loader state="loop" /> : <Icon size={15} aria-hidden className="dg-pop-icon" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuLabel({ children }: { children: string }) {
  return <div className="dg-pop-label">{children}</div>;
}

/** A diagram card's ⋯ menu on the list: download in any format without opening it, or delete. */
export function DiagramCardMenu({ id, title, onDelete }: { id: string; title: string; onDelete: () => void }) {
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
      width={208}
      trigger={(open, toggle) => (
        <button type="button" className="dg-card-more" aria-label={`Actions for ${title}`} aria-haspopup="menu" aria-expanded={open} title="Download or delete" onClick={toggle}>
          <MoreHorizontal size={16} aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={`Actions for ${title}`} className="dg-pop-menu">
          <MenuLabel>Download</MenuLabel>
          {EXPORT_KINDS.map((kind) => (
            <MenuRow key={kind.id} icon={kind.icon} label={kind.label} busy={busy === kind.id} disabled={busy !== null} onClick={() => void run(kind.id, close)} />
          ))}
          <div className="dg-pop-sep" role="separator" />
          <MenuRow
            icon={Trash2}
            label="Delete…"
            danger
            onClick={() => {
              close();
              onDelete();
            }}
          />
        </div>
      )}
    </Popover>
  );
}

/** The editor's one primary action: download the drawing, or copy it as an image or as Mermaid. */
export function DiagramExportMenu({ model, exporting, onExport }: { model: DiagramModel; exporting: boolean; onExport: (kind: DiagramExportKind) => void }) {
  const toast = useToast();
  return (
    <Popover
      align="right"
      width={212}
      trigger={(open, toggle) => (
        <button type="button" className="btn-primary dg-primary" aria-haspopup="menu" aria-expanded={open} disabled={exporting} onClick={toggle}>
          {exporting ? <BrandMorph size={14} kind="beacon" loader state="loop" /> : <Download size={15} aria-hidden />}
          {exporting ? "Exporting…" : "Export"}
          <ChevronDown size={14} aria-hidden className="dg-primary-chevron" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Export" className="dg-pop-menu">
          <MenuLabel>Download</MenuLabel>
          {EXPORT_KINDS.map((kind) => (
            <MenuRow
              key={kind.id}
              icon={kind.icon}
              label={kind.label}
              onClick={() => {
                close();
                onExport(kind.id);
              }}
            />
          ))}
          <div className="dg-pop-sep" role="separator" />
          <MenuLabel>Copy</MenuLabel>
          <MenuRow
            icon={Copy}
            label="Copy as image"
            onClick={() => {
              close();
              void copyDiagramPng(model).then(
                () => toast("Copied image."),
                () => toast("Couldn't copy the image.", { tone: "error" }),
              );
            }}
          />
          <MenuRow
            icon={FileCode2}
            label="Copy as Mermaid"
            onClick={() => {
              close();
              void navigator.clipboard.writeText(toMermaid(model)).then(
                () => toast("Copied Mermaid."),
                () => toast("Couldn't copy Mermaid.", { tone: "error" }),
              );
            }}
          />
        </div>
      )}
    </Popover>
  );
}
