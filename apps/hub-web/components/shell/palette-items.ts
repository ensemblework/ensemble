import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  ChartSpline,
  CircleCheck,
  CirclePlay,
  Code2,
  Columns3,
  File,
  FileText,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Inbox,
  Keyboard,
  LayoutGrid,
  ListChecks,
  Package,
  Plug,
  Plus,
  Repeat,
  Settings,
  SquareCheck,
  SquarePen,
  User,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { formatChord, type ShortcutBinding } from "@ensemble/shared-types";

/** Sections of Search and jump, in the order they are drawn. */
export type PaletteGroup = "recent" | "work" | "go" | "actions";
export const PALETTE_GROUPS: readonly PaletteGroup[] = ["recent", "work", "go", "actions"];
export const GROUP_TITLE: Record<PaletteGroup, string> = { recent: "Recent", work: "Your work", go: "Go to", actions: "Actions" };

/** Workspace search kinds (hub-api `searchWorkspace`): the icon, its tint and the label on the right. */
const HIT_KIND: Record<string, { icon: LucideIcon; label: string; tint?: string }> = {
  page: { icon: FileText, label: "Page", tint: "page" },
  task: { icon: SquareCheck, label: "Task", tint: "task" },
  project: { icon: FolderKanban, label: "Project", tint: "project" },
  person: { icon: User, label: "Person", tint: "people" },
  repo: { icon: GitBranch, label: "Repository", tint: "repo" },
  deliverable: { icon: Package, label: "Deliverable", tint: "deliverable" },
  meeting: { icon: CalendarCheck, label: "Meeting", tint: "note" },
  meeting_note: { icon: CalendarCheck, label: "Meeting note", tint: "note" },
  document: { icon: File, label: "File", tint: "artifact" },
  file: { icon: File, label: "File", tint: "artifact" },
  artifact: { icon: Inbox, label: "From your apps", tint: "artifact" },
  skill: { icon: BookOpen, label: "Skill", tint: "skill" },
  diagram: { icon: Workflow, label: "Diagram", tint: "diagram" },
  plot: { icon: ChartSpline, label: "Plot", tint: "diagram" },
};

export function hitKind(kind: string): { icon: LucideIcon; label: string; tint?: string } {
  const known = HIT_KIND[kind];
  if (known) return known;
  const words = kind.replace(/_/g, " ").trim();
  return { icon: FileText, label: words ? words[0]!.toUpperCase() + words.slice(1) : "Result" };
}

/** Same icons as the sidebar, so a destination looks like the tab it opens. */
const ROUTE_ICON: Array<[string, LucideIcon]> = [
  ["/today", CalendarDays],
  ["/board", Columns3],
  ["/needs-me", CircleCheck],
  ["/meetings", CalendarCheck],
  ["/recap", ListChecks],
  ["/runs", CirclePlay],
  ["/context", Users],
  ["/skills", BookOpen],
  ["/code", Code2],
  ["/diagrams", Workflow],
  ["/plots", ChartSpline],
  ["/files", FolderOpen],
  ["/metrics", BarChart3],
  ["/connect", Plug],
  ["/settings?tab=connections", Plug],
  ["/settings", Settings],
  ["/shared", UsersRound],
  ["/routines", Repeat],
  ["/spaces", LayoutGrid],
];

export function destinationIcon(href: string): LucideIcon {
  return ROUTE_ICON.find(([prefix]) => href === prefix || (href.startsWith(prefix) && /[?#/&]/.test(href[prefix.length] ?? "")))?.[1] ?? ArrowRight;
}

export function actionIcon(id: string): LucideIcon {
  if (id === "act-capture") return SquarePen;
  if (id === "act-help") return Keyboard;
  if (id === "act-diagram") return Workflow;
  if (id === "act-plot") return ChartSpline;
  if (id === "act-new-space") return Plus;
  if (id.startsWith("space-")) return ArrowLeftRight;
  if (id.startsWith("desk-")) return LayoutGrid;
  return ArrowRight;
}

/** Destinations and actions that have their own shortcut (shared-types `SHORTCUTS`). */
const SHORTCUT_FOR: Record<string, string> = {
  "/today": "go-today",
  "/board": "go-board",
  "/needs-me": "go-needs",
  "/meetings": "go-meetings",
  "/recap": "go-recap",
  "/settings": "go-settings",
  "/diagrams": "go-diagrams",
  "/plots": "go-plots",
  "act-capture": "capture",
  "act-help": "help",
};

/** The keys to show beside a row: a typed sequence key by key, or one chord. */
export function shortcutKeys(target: string, bindings: readonly ShortcutBinding[], apple: boolean): string[] {
  const id = SHORTCUT_FOR[target];
  const binding = id ? bindings.find((row) => row.id === id) : undefined;
  if (!binding) return [];
  if (binding.sequence?.length) return binding.sequence.map((key) => key.toUpperCase());
  const raw = apple ? binding.mac : binding.other;
  // "?" already means Shift+/, so the Shift is not drawn.
  if (raw?.key === "?" && !raw.mod && !raw.ctrl && !raw.alt && !raw.meta) return ["?"];
  const chord = formatChord(raw, apple);
  return chord ? [chord] : [];
}

/** What Search and jump opened lately, per space, newest first. Kept in this browser only. */
export type PaletteRecent = { label: string; hint: string; href: string; kind?: string };
export const RECENT_KEY = "ensemble.palette.recent";
export const RECENT_LIMIT = 5;

type RecentStore = Record<string, PaletteRecent[]>;

function readStore(storage: Pick<Storage, "getItem"> | undefined): RecentStore {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RecentStore) : {};
  } catch {
    return {};
  }
}

const validRecent = (row: unknown): row is PaletteRecent => {
  const value = row as PaletteRecent | null;
  return Boolean(value) && typeof value!.label === "string" && typeof value!.hint === "string" && typeof value!.href === "string"
    // Only in-app paths: the stored value is pushed to the router as-is.
    && value!.href.startsWith("/") && !value!.href.startsWith("//") && (value!.kind === undefined || typeof value!.kind === "string");
};

export function readRecents(storage: Pick<Storage, "getItem"> | undefined, space: string): PaletteRecent[] {
  const rows = readStore(storage)[space];
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows.filter((row) => validRecent(row) && !seen.has(row.href) && Boolean(seen.add(row.href))).slice(0, RECENT_LIMIT);
}

export function addRecent(list: readonly PaletteRecent[], entry: PaletteRecent): PaletteRecent[] {
  return [entry, ...list.filter((row) => row.href !== entry.href)].slice(0, RECENT_LIMIT);
}

export function rememberRecent(storage: Pick<Storage, "getItem" | "setItem"> | undefined, space: string, entry: PaletteRecent): void {
  if (!storage || !validRecent(entry)) return;
  try {
    const store = readStore(storage);
    store[space] = addRecent(readRecents(storage, space), entry);
    storage.setItem(RECENT_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: the palette works without recents.
  }
}
