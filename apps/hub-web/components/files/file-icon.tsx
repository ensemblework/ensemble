"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { File, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, FileVideo, Presentation, type LucideIcon } from "lucide-react";
import type { FileKind } from "@ensemble/shared-types";
import { toneStyle, type Tone } from "@/lib/format";
import { cx } from "../ui";

const KIND: Record<FileKind, { icon: LucideIcon; tone: Tone }> = {
  pdf: { icon: FileText, tone: "red" },
  document: { icon: FileType2, tone: "blue" },
  slides: { icon: Presentation, tone: "orange" },
  sheet: { icon: FileSpreadsheet, tone: "green" },
  image: { icon: FileImage, tone: "purple" },
  text: { icon: FileText, tone: "gray" },
  code: { icon: FileCode2, tone: "yellow" },
  audio: { icon: FileAudio, tone: "pink" },
  video: { icon: FileVideo, tone: "pink" },
  other: { icon: File, tone: "gray" },
};

/** A small coloured tile with the icon for a kind of file. */
export function FileIcon({ kind, size = 32, className }: { kind: FileKind; size?: number; className?: string }) {
  const spec = KIND[kind] ?? KIND.other;
  const Icon = spec.icon;
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-lg", className)} style={{ ...toneStyle(spec.tone), width: size, height: size }} aria-hidden>
      <Icon size={Math.round(size * 0.55)} strokeWidth={1.8} />
    </span>
  );
}
