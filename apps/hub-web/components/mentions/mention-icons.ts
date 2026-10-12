import { fileFormat, type FileKind } from "@ensemble/shared-types";
import {
  AtSign,
  Calendar,
  ChartSpline,
  CheckSquare,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderKanban,
  GitBranch,
  Paperclip,
  Presentation,
  Target,
  User,
  Wand2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MentionMenuItem } from "@/lib/mentions/menu";

const KIND_ICON: Record<string, LucideIcon> = {
  people: User,
  project: FolderKanban,
  repo: GitBranch,
  task: CheckSquare,
  deliverable: Target,
  skill: Wand2,
  diagram: Waypoints,
  plot: ChartSpline,
  "plot-space": ChartSpline,
  dataset: ChartSpline,
  file: Paperclip,
  ensemble: Wand2,
  date: Calendar,
};

const FILE_ICON: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  document: FileText,
  slides: Presentation,
  sheet: FileSpreadsheet,
  image: FileImage,
  text: FileText,
  code: FileCode,
  audio: FileAudio,
  video: FileVideo,
  other: File,
};

/** The icon for an @ menu row. Groups and hints show a plain "@" instead. */
export function mentionIcon(item: MentionMenuItem): LucideIcon | null {
  if (item.type === "group" || item.type === "hint") return null;
  if (item.type === "entity" && item.kind === "file") return FILE_ICON[fileFormat(item.label).kind] ?? File;
  return KIND_ICON[item.kind] ?? AtSign;
}

/** The small text at the end of a row: the kind ("Person") or the group's prefix ("@people:"). */
export function mentionBadge(item: MentionMenuItem): string | null {
  if (item.type === "entity") return item.kindLabel ?? null;
  if (item.type === "group") return item.shortcut ?? null;
  return null;
}
