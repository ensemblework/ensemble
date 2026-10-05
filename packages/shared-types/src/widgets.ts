/**
 * Widget registry, size spans, and layout checks.
 * No Zod here: the Hub client imports this module, and the API schema lives beside the routes.
 */

export const SIZES = ["s", "m", "l", "xl"] as const;
export type Size = (typeof SIZES)[number];

export const LAYOUT_SURFACES = ["today", "context", "board"] as const;
export type LayoutSurface = (typeof LAYOUT_SURFACES)[number];

export const SIZE_RANK: Record<Size, number> = { s: 0, m: 1, l: 2, xl: 3 };

export const MAX_PLACEMENTS = 12;
export const MAX_DOCUMENT_BYTES = 16 * 1024;
/** Fixed track. Content scrolls inside the tile instead of stretching the row. */
export const ROW_PX = 100;

export const WIDGET_IDS = [
  "orbit",
  "focus",
  "proposals",
  "calendar",
  "deliverables",
  "reminders",
  "needs-me",
  "meeting-cues",
  "stale-nudges",
  "morning-brief",
  "week-recap",
  "people",
  "meetings",
  "repos",
  "artifacts",
  "graph",
  "recent-links",
  "column-summary",
  "wip",
  "blocked",
  "week-done",
  "countdown",
  "reading-queue",
  "decisions",
  "open-questions",
  "person-load",
  "quiz-pile",
  "timetable",
  "assignment-countdown",
  "exam-countdown",
  "group-load",
  "lesson-next",
  "grading-queue",
  "class-list",
  "matter-dates",
  "limitation",
  "clause-pair",
  "time-week",
  "syllabus",
  "mock-log",
  "revision-due",
  "daily-target",
  "affairs",
  "spec-register",
  "change-requests",
  "test-log",
  "one-on-ones",
  "okr-strip",
  "incident-now",
  "review-queue",
  "completed",
  "saved-plots",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

export type WidgetPersona =
  | "student"
  | "teacher"
  | "lawyer"
  | "researcher"
  | "manager"
  | "aspirant"
  | "maker"
  | "engineer";

export type WidgetSpec = {
  label: string;
  surfaces: readonly LayoutSurface[];
  min: Size;
  max: Size;
  defaultSize: Size;
  /** Empty data removes the cell so the grid closes up. Loading does the same. */
  collapsesWhenEmpty: boolean;
  ensemble: { surface: "today" | "needs_me" | "graph" | "board" | "deliverable"; anchor: string };
  /** A second slot is legal. Countdown and matter dates only. */
  repeatable?: boolean;
  /** Absent from the gallery when this module is off. */
  requires?: "code" | "workspace" | "runs" | "metrics" | "skills" | "plots";
  persona?: WidgetPersona;
  /** One line in the gallery. */
  blurb?: string;
  /** Empty-state sentence. The tile stays up. */
  empty?: string;
};

const spec = (
  label: string,
  surfaces: readonly LayoutSurface[],
  min: Size,
  max: Size,
  defaultSize: Size,
  ensemble: WidgetSpec["ensemble"]["surface"],
  collapsesWhenEmpty = false,
  extra: Partial<Pick<WidgetSpec, "repeatable" | "requires" | "persona" | "blurb" | "empty">> = {},
): WidgetSpec => ({
  label,
  surfaces,
  min,
  max,
  defaultSize,
  collapsesWhenEmpty,
  ensemble: { surface: ensemble, anchor: `widget:${label.toLowerCase().replace(/\s+/g, "-")}` },
  ...extra,
});

export const WIDGET_REGISTRY: Record<WidgetId, WidgetSpec> = {
  orbit: spec("Orbit", ["today"], "s", "m", "m", "today"),
  focus: spec("Focus", ["today"], "m", "xl", "l", "today"),
  proposals: spec("Proposals", ["today"], "m", "l", "m", "today"),
  calendar: spec("Calendar", ["today"], "s", "l", "m", "today"),
  deliverables: spec("Deliverables", ["today"], "s", "xl", "m", "deliverable"),
  reminders: spec("Reminders", ["today"], "s", "xl", "s", "today"),
  "needs-me": spec("Needs me", ["today"], "s", "s", "s", "needs_me"),
  "meeting-cues": spec("Meetings", ["today"], "s", "l", "m", "today", true),
  "stale-nudges": spec("Still relevant", ["today"], "m", "l", "m", "today", true),
  "morning-brief": spec("Morning brief", ["today"], "s", "m", "s", "today"),
  "week-recap": spec("Week recap", ["today"], "s", "s", "s", "today"),
  people: spec("People", ["today", "context"], "s", "l", "m", "graph"),
  meetings: spec("Meetings", ["context"], "s", "l", "m", "graph"),
  repos: spec("Repos", ["today", "context"], "s", "l", "m", "graph"),
  artifacts: spec("Artifacts", ["context"], "s", "l", "m", "graph"),
  graph: spec("Graph", ["context"], "m", "xl", "l", "graph"),
  "recent-links": spec("Recent links", ["context"], "s", "m", "m", "graph"),
  "column-summary": spec("Columns", ["board"], "s", "s", "s", "board"),
  wip: spec("WIP", ["board"], "s", "m", "m", "board"),
  blocked: spec("Blocked", ["board"], "s", "m", "m", "board"),
  "week-done": spec("Week done", ["board"], "s", "l", "m", "board"),
  countdown: spec("Countdown", ["today", "context"], "s", "m", "s", "deliverable", false, {
    repeatable: true,
    blurb: "The next dated deliverable, and how many days are left.",
    empty: "Nothing dated.",
  }),
  "reading-queue": spec("Reading", ["today", "context"], "s", "l", "m", "today", false, {
    blurb: "What you still mean to read.",
    empty: "Nothing in the pile.",
  }),
  decisions: spec("Decisions", ["today", "context"], "s", "l", "m", "today", false, {
    blurb: "Choices that are still open.",
    empty: "No decisions yet.",
  }),
  "open-questions": spec("Questions", ["today", "context"], "s", "l", "m", "today", false, {
    blurb: "Questions nobody has answered.",
    empty: "No open questions.",
  }),
  "person-load": spec("Load", ["today", "context"], "m", "l", "l", "graph", false, {
    blurb: "Who is carrying the most open work.",
    empty: "No one is on this yet.",
  }),
  "quiz-pile": spec("Quiz", ["today", "context"], "s", "m", "m", "today", false, {
    blurb: "Prompts from one page, ready to ask.",
    empty: "Add a page of prompts.",
  }),
  timetable: spec("Timetable", ["today"], "s", "l", "m", "today", false, {
    persona: "student",
    blurb: "What is next on the calendar.",
    empty: "Nothing on the timetable.",
  }),
  "assignment-countdown": spec("Coursework", ["today"], "s", "l", "m", "deliverable", false, {
    persona: "student",
    blurb: "The nearest piece of coursework.",
    empty: "No assignment dated.",
  }),
  "exam-countdown": spec("Exam", ["today", "context"], "s", "l", "l", "today", false, {
    persona: "student",
    blurb: "One date, large enough to see from across the room.",
    empty: "No exam date.",
  }),
  "group-load": spec("Group", ["context"], "s", "l", "m", "graph", false, {
    persona: "student",
    blurb: "Open tasks across the group.",
    empty: "Add the group as people.",
  }),
  "lesson-next": spec("Next lesson", ["today"], "m", "l", "l", "today", false, {
    persona: "teacher",
    blurb: "The next lesson and its page.",
    empty: "No lesson this week.",
  }),
  "grading-queue": spec("Marking", ["today"], "s", "l", "m", "today", false, {
    persona: "teacher",
    blurb: "Sets that still need a mark.",
    empty: "Nothing to mark.",
  }),
  "class-list": spec("Class", ["context"], "m", "l", "l", "graph", false, {
    persona: "teacher",
    blurb: "People on the course.",
    empty: "Add the class as people.",
  }),
  "matter-dates": spec("Dates", ["today"], "m", "l", "l", "today", false, {
    persona: "lawyer",
    repeatable: true,
    blurb: "Filings and the reminders beside them.",
    empty: "No date on this matter.",
  }),
  limitation: spec("Limitation", ["today"], "m", "l", "l", "today", false, {
    persona: "lawyer",
    blurb: "Limitation dates. An empty docket stays on screen.",
    empty: "No limitation date.",
  }),
  "clause-pair": spec("Drafts", ["context"], "s", "m", "m", "graph", false, {
    persona: "lawyer",
    blurb: "The two latest drafts, side by side.",
    empty: "Add the two drafts.",
  }),
  "time-week": spec("Time", ["today"], "s", "m", "s", "today", false, {
    persona: "lawyer",
    blurb: "Minutes noted this week.",
    empty: "No time noted.",
  }),
  syllabus: spec("Syllabus", ["today", "context"], "s", "l", "m", "today", false, {
    persona: "aspirant",
    blurb: "Done against everything on one subject.",
    empty: "Name the subject.",
  }),
  "mock-log": spec("Mocks", ["today"], "s", "l", "m", "today", false, {
    persona: "aspirant",
    blurb: "Recent scores, newest first.",
    empty: "No mock yet.",
  }),
  "revision-due": spec("Revision", ["today"], "m", "l", "l", "today", false, {
    persona: "aspirant",
    blurb: "What is due to revise inside the horizon.",
    empty: "Nothing due to revise.",
  }),
  "daily-target": spec("Today's target", ["today"], "s", "m", "s", "today", false, {
    persona: "aspirant",
    blurb: "Done today against the number you set.",
    empty: "0 of 20",
  }),
  affairs: spec("Saved", ["today"], "s", "m", "s", "today", false, {
    persona: "aspirant",
    blurb: "What you saved in the last two days.",
    empty: "Nothing saved.",
  }),
  "spec-register": spec("Specs", ["today"], "s", "l", "m", "graph", false, {
    persona: "maker",
    blurb: "Specs and drawings.",
    empty: "No spec yet.",
  }),
  "change-requests": spec("Changes", ["today"], "m", "l", "l", "today", false, {
    persona: "maker",
    blurb: "Open changes on the bench.",
    empty: "No open change.",
  }),
  "test-log": spec("Tests", ["today"], "s", "l", "m", "today", false, {
    persona: "maker",
    blurb: "Recent test notes.",
    empty: "No test logged.",
  }),
  "one-on-ones": spec("1:1s", ["today"], "m", "l", "l", "today", false, {
    persona: "manager",
    blurb: "The latest note with each person.",
    empty: "No 1:1 notes.",
  }),
  "okr-strip": spec("Objectives", ["context"], "s", "m", "m", "deliverable", false, {
    persona: "manager",
    blurb: "The objectives you are actually tracking.",
    empty: "No objectives.",
  }),
  "incident-now": spec("Incidents", ["today"], "s", "l", "m", "today", true, {
    persona: "manager",
    blurb: "Blocked work, or anything marked incident.",
    empty: "Nothing is blocked.",
  }),
  "review-queue": spec("Reviews", ["today"], "s", "l", "m", "today", false, {
    persona: "engineer",
    requires: "code",
    blurb: "Open reviews.",
    empty: "Nothing to review.",
  }),
  completed: spec("Completed", ["today"], "s", "l", "m", "today", false, {
    blurb: "Finished tasks from the last few days.",
    empty: "Nothing finished recently.",
  }),
  "saved-plots": spec("Saved plots", ["today"], "s", "l", "m", "today", false, {
    requires: "plots",
    blurb: "Charts you saved in Plots.",
    empty: "No plots yet.",
  }),
};

// Anchors follow the widget id, not the label.
for (const id of WIDGET_IDS) {
  WIDGET_REGISTRY[id].ensemble.anchor = `widget:${id}`;
}

export const TILE_ACCENTS = ["people", "project", "repo", "note", "deliverable", "accent"] as const;
export type TileAccent = (typeof TILE_ACCENTS)[number];
export type TileDensity = "comfortable" | "compact";
export const HORIZON_DAYS = [1, 7, 14, 30] as const;

export type TileConfig = {
  title?: string;
  density?: TileDensity;
  accent?: TileAccent;
  horizonDays?: (typeof HORIZON_DAYS)[number];
  taskType?: string;
  source?: string;
  projectId?: string;
  target?: number;
};

export type Placement = { type: WidgetId; size: Size; slot?: 0 | 1; config?: TileConfig };

export type LayoutConfig = { wipCap?: number; graphNodeCap?: number };

export type LayoutDocument = {
  v: 1 | 2;
  placements: Placement[];
  config?: LayoutConfig;
};

/** Slot 0 keeps the bare widget id so existing tiles stay stable keys. */
export function placementKey(row: { type: string; slot?: number }): string {
  return row.slot ? `${row.type}#${row.slot}` : row.type;
}

export function tileLabel(row: { type: WidgetId; config?: TileConfig }): string {
  const custom = row.config?.title?.trim();
  return custom || WIDGET_REGISTRY[row.type].label;
}

export type Rect = Placement & { x: number; y: number; w: number; h: number };

export type Span = { w: number; h: number };

const WIDE: Record<Size, Span> = { s: { w: 3, h: 2 }, m: { w: 6, h: 2 }, l: { w: 6, h: 4 }, xl: { w: 12, h: 4 } };
const DESK: Record<Size, Span> = { s: { w: 2, h: 2 }, m: { w: 4, h: 2 }, l: { w: 4, h: 4 }, xl: { w: 8, h: 4 } };
const TABLET: Record<Size, Span> = { s: { w: 2, h: 2 }, m: { w: 4, h: 2 }, l: { w: 4, h: 3 }, xl: { w: 4, h: 4 } };
const PHONE: Record<Size, Span> = { s: { w: 2, h: 2 }, m: { w: 4, h: 2 }, l: { w: 4, h: 4 }, xl: { w: 4, h: 5 } };

/** One saved layout. Width only changes how many columns a class spans. */
export function spanFor(size: Size, columns: number, phone = false): Span {
  if (columns >= 12) return WIDE[size];
  if (columns >= 8) return DESK[size];
  return phone ? PHONE[size] : TABLET[size];
}

export function columnsForWidth(width: number): number {
  if (width >= 1000) return 12;
  if (width >= 700) return 8;
  return 4;
}

export function phoneWidth(width: number): boolean {
  return width < 480;
}

function occupies(rect: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

/** Row-major pack. Returns null when a span cannot sit inside the column count. */
export function packPlacements(placements: readonly Placement[], columns: number, phone = false): Rect[] | null {
  if (columns < 1) return null;
  const taken = new Set<string>();
  const packed: Rect[] = [];
  for (const placement of placements) {
    const span = spanFor(placement.size, columns, phone);
    if (span.w > columns || span.w < 1 || span.h < 1) return null;
    let found: Rect | null = null;
    for (let y = 0; y < 64 && !found; y += 1) {
      for (let x = 0; x <= columns - span.w; x += 1) {
        let clear = true;
        for (let dy = 0; dy < span.h && clear; dy += 1) {
          for (let dx = 0; dx < span.w; dx += 1) {
            if (taken.has(`${x + dx},${y + dy}`)) {
              clear = false;
              break;
            }
          }
        }
        if (!clear) continue;
        found = {
          type: placement.type,
          size: placement.size,
          ...(placement.slot ? { slot: placement.slot } : {}),
          ...(placement.config ? { config: placement.config } : {}),
          x,
          y,
          w: span.w,
          h: span.h,
        };
        for (let dy = 0; dy < span.h; dy += 1) {
          for (let dx = 0; dx < span.w; dx += 1) taken.add(`${x + dx},${y + dy}`);
        }
        break;
      }
    }
    if (!found) return null;
    if (found.x < 0 || found.y < 0 || found.x + found.w > columns) return null;
    packed.push(found);
  }
  return packed;
}

/** Index pairs whose rectangles share a cell. */
export function findCollisions(rects: readonly { x: number; y: number; w: number; h: number }[]): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  const owner = new Map<string, number>();
  rects.forEach((rect, index) => {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const key = `${x},${y}`;
        const previous = owner.get(key);
        if (previous !== undefined) hits.push([previous, index]);
        else owner.set(key, index);
      }
    }
  });
  return hits;
}

export function isWidgetId(value: string): value is WidgetId {
  return (WIDGET_IDS as readonly string[]).includes(value);
}

export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}

export function isLayoutSurface(value: string): value is LayoutSurface {
  return (LAYOUT_SURFACES as readonly string[]).includes(value);
}

function sizeAllowed(id: WidgetId, size: Size): boolean {
  const row = WIDGET_REGISTRY[id];
  return SIZE_RANK[size] >= SIZE_RANK[row.min] && SIZE_RANK[size] <= SIZE_RANK[row.max];
}

const TILE_KEYS = new Set(["title", "density", "accent", "horizonDays", "taskType", "source", "projectId", "target"]);

function readTile(value: unknown): { config?: TileConfig; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "placement.config: expected an object" };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !TILE_KEYS.has(key))) return { error: "placement.config: unknown field" };
  if (JSON.stringify(raw).length > 512) return { error: "placement.config: larger than 512 bytes" };
  const config: TileConfig = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.length > 40 || /[<>]/.test(raw.title)) return { error: "placement.config.title: expected at most 40 characters" };
    if (raw.title.trim()) config.title = raw.title.trim();
  }
  if (raw.density !== undefined) {
    if (raw.density !== "comfortable" && raw.density !== "compact") return { error: "placement.config.density: unknown" };
    if (raw.density === "compact") config.density = "compact";
  }
  if (raw.accent !== undefined) {
    if (!(TILE_ACCENTS as readonly string[]).includes(String(raw.accent))) return { error: "placement.config.accent: unknown" };
    config.accent = raw.accent as TileAccent;
  }
  if (raw.horizonDays !== undefined) {
    if (!(HORIZON_DAYS as readonly number[]).includes(raw.horizonDays as number)) return { error: "placement.config.horizonDays: expected 1, 7, 14, or 30" };
    config.horizonDays = raw.horizonDays as TileConfig["horizonDays"];
  }
  if (raw.taskType !== undefined) {
    if (typeof raw.taskType !== "string" || raw.taskType.length > 24 || /[<>]/.test(raw.taskType)) return { error: "placement.config.taskType: expected a short label" };
    config.taskType = raw.taskType;
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string" || raw.source.length > 24 || /[<>]/.test(raw.source)) return { error: "placement.config.source: expected a short label" };
    config.source = raw.source;
  }
  if (raw.projectId !== undefined) {
    if (typeof raw.projectId !== "string" || raw.projectId.length < 8 || raw.projectId.length > 80) return { error: "placement.config.projectId: unknown project" };
    config.projectId = raw.projectId;
  }
  if (raw.target !== undefined) {
    if (typeof raw.target !== "number" || !Number.isInteger(raw.target) || raw.target < 1 || raw.target > 50) return { error: "placement.config.target: expected an integer from 1 to 50" };
    config.target = raw.target;
  }
  return Object.keys(config).length ? { config } : {};
}

function readConfig(value: unknown): { config?: LayoutConfig; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "config: expected an object" };
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "wipCap" && key !== "graphNodeCap")) return { error: "config: unknown field" };
  const config: LayoutConfig = {};
  if (raw.wipCap !== undefined) {
    if (typeof raw.wipCap !== "number" || !Number.isInteger(raw.wipCap) || raw.wipCap < 1 || raw.wipCap > 20) {
      return { error: "config.wipCap: expected an integer from 1 to 20" };
    }
    config.wipCap = raw.wipCap;
  }
  if (raw.graphNodeCap !== undefined) {
    if (typeof raw.graphNodeCap !== "number" || !Number.isInteger(raw.graphNodeCap) || raw.graphNodeCap < 4 || raw.graphNodeCap > 80) {
      return { error: "config.graphNodeCap: expected an integer from 4 to 80" };
    }
    config.graphNodeCap = raw.graphNodeCap;
  }
  return { config };
}

/** Rejects unknown types, illegal sizes, duplicates, a second XL, and a document over 16 KB. */
export function validateLayout(surface: string, input: unknown): { ok: true; document: LayoutDocument } | { ok: false; error: string } {
  if (!isLayoutSurface(surface)) return { ok: false, error: "surface: unknown" };
  const encoded = JSON.stringify(input ?? null);
  if (encoded.length > MAX_DOCUMENT_BYTES) return { ok: false, error: "document: larger than 16 KB" };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "document: expected an object" };
  const body = input as Record<string, unknown>;
  if (body.v !== 1 && body.v !== 2) return { ok: false, error: "v: expected 1 or 2" };
  if (!Array.isArray(body.placements)) return { ok: false, error: "placements: expected an array" };
  if (body.placements.length > MAX_PLACEMENTS) return { ok: false, error: "placements: at most 12 widgets" };
  const seen = new Set<string>();
  const typeCount = new Map<string, number>();
  let xl = 0;
  let rich = body.v === 2;
  const placements: Placement[] = [];
  for (const row of body.placements) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, error: "placements: expected objects" };
    const item = row as Record<string, unknown>;
    if (typeof item.type !== "string" || !isWidgetId(item.type)) return { ok: false, error: `type: unknown widget ${String(item.type)}` };
    if (!WIDGET_REGISTRY[item.type].surfaces.includes(surface)) return { ok: false, error: `type: ${item.type} is not on ${surface}` };
    if (typeof item.size !== "string" || !isSize(item.size)) return { ok: false, error: `size: unknown size ${String(item.size)}` };
    if (!sizeAllowed(item.type, item.size)) return { ok: false, error: `size: ${item.type} cannot be ${item.size}` };
    let slot: 0 | 1 = 0;
    if (item.slot !== undefined) {
      if (item.slot !== 0 && item.slot !== 1) return { ok: false, error: "slot: expected 0 or 1" };
      slot = item.slot;
      if (body.v === 1) return { ok: false, error: "slot: version 2 layouts only" };
    }
    if (slot === 1 && !WIDGET_REGISTRY[item.type].repeatable) return { ok: false, error: `slot: ${item.type} is not repeatable` };
    const key = placementKey({ type: item.type, slot });
    const count = typeCount.get(item.type) ?? 0;
    const cap = body.v === 2 && WIDGET_REGISTRY[item.type].repeatable ? 2 : 1;
    if (seen.has(key) || count >= cap) return { ok: false, error: `type: duplicate ${item.type}` };
    seen.add(key);
    typeCount.set(item.type, count + 1);
    if (item.size === "xl") xl += 1;
    const tile = readTile(item.config);
    if (tile.error) return { ok: false, error: tile.error };
    if (tile.config) rich = true;
    placements.push({ type: item.type, size: item.size, ...(slot ? { slot } : {}), ...(tile.config ? { config: tile.config } : {}) });
  }
  if (xl > 1) return { ok: false, error: "placements: at most one extra-large widget" };
  const config = readConfig(body.config);
  if (config.error) return { ok: false, error: config.error };
  const packed = packPlacements(placements, 12, false);
  if (!packed || findCollisions(packed).length) return { ok: false, error: "placements: do not fit" };
  const document: LayoutDocument = {
    v: rich ? 2 : 1,
    placements,
    ...(config.config && Object.keys(config.config).length ? { config: config.config } : {}),
  };
  return { ok: true, document };
}

/** Drops unknown or illegal widgets on read. They are not written back. */
export function sanitizeLayout(surface: LayoutSurface, input: unknown): { document: LayoutDocument; ignored: string[] } {
  const ignored: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { document: defaultLayout(surface), ignored: ["document"] };
  const body = input as Record<string, unknown>;
  const rows = Array.isArray(body.placements) ? body.placements : [];
  const seen = new Set<string>();
  let xl = false;
  let rich = body.v === 2;
  const placements: Placement[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      ignored.push("placement");
      continue;
    }
    const item = row as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const slot: 0 | 1 = item.slot === 1 ? 1 : 0;
    const key = placementKey({ type, slot });
    if (!isWidgetId(type) || !WIDGET_REGISTRY[type].surfaces.includes(surface) || seen.has(key) || (slot === 1 && !WIDGET_REGISTRY[type].repeatable)) {
      ignored.push(type || "placement");
      continue;
    }
    const size = typeof item.size === "string" && isSize(item.size) && sizeAllowed(type, item.size) ? item.size : WIDGET_REGISTRY[type].defaultSize;
    if (size === "xl" && xl) {
      ignored.push(type);
      continue;
    }
    if (size === "xl") xl = true;
    if (placements.length >= MAX_PLACEMENTS) {
      ignored.push(type);
      continue;
    }
    seen.add(key);
    const tile = readTile(item.config);
    if (tile.error) ignored.push(`${type}:config`);
    if (slot || tile.config) rich = true;
    placements.push({ type, size, ...(slot ? { slot } : {}), ...(tile.config ? { config: tile.config } : {}) });
  }
  const config = readConfig(body.config);
  if (config.error) ignored.push("config");
  return {
    document: {
      v: rich ? 2 : 1,
      placements,
      ...(config.config && !config.error && Object.keys(config.config).length ? { config: config.config } : {}),
    },
    ignored,
  };
}

export function stepSize(id: WidgetId, size: Size, direction: 1 | -1): Size {
  const row = WIDGET_REGISTRY[id];
  const rank = Math.max(SIZE_RANK[row.min], Math.min(SIZE_RANK[row.max], SIZE_RANK[size] + direction));
  return SIZES[rank] ?? size;
}

function indexOfKey(placements: readonly Placement[], key: string): number {
  const exact = placements.findIndex((row) => placementKey(row) === key);
  if (exact >= 0) return exact;
  return placements.findIndex((row) => row.type === key);
}

export function withSize(placements: readonly Placement[], key: string, size: Size, columns: number, phone = false): Placement[] {
  const type = key.split("#")[0] ?? key;
  if (!isWidgetId(type) || !sizeAllowed(type, size)) return placements.slice();
  if (size === "xl" && placements.some((row) => placementKey(row) !== key && row.size === "xl")) return placements.slice();
  const next = placements.map((row) => (placementKey(row) === key || (row.type === key && !row.slot) ? { ...row, size } : row));
  return packPlacements(next, columns, phone) ? next : placements.slice();
}

/**
 * Drop `type` onto the tile at `index`. The dropped tile takes that slot.
 * Moving forward used to insert one past the target, so a drop on the last
 * tile appended. An immediate forward neighbour would then be a no-op, so
 * that drop swaps instead.
 */
export function moveToIndex(placements: readonly Placement[], type: string, index: number): Placement[] {
  const from = indexOfKey(placements, type);
  if (from < 0 || index < 0 || index >= placements.length || from === index) return placements.slice();
  const copy = placements.slice();
  const [item] = copy.splice(from, 1);
  let dest = from < index ? index - 1 : index;
  if (dest === from) dest = Math.min(index, copy.length);
  copy.splice(dest, 0, item!);
  return copy;
}

export function moveOrder(placements: readonly Placement[], type: string, direction: -1 | 1): Placement[] {
  const index = indexOfKey(placements, type);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= placements.length) return placements.slice();
  const copy = placements.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item!);
  return copy;
}

/** Swap with the tile that owns the neighbouring cell. Order-only documents have no stored x/y. */
export function moveByCell(
  placements: readonly Placement[],
  type: string,
  dx: number,
  dy: number,
  columns: number,
  phone = false,
): Placement[] {
  const packed = packPlacements(placements, columns, phone);
  if (!packed) return placements.slice();
  const self = packed.find((row) => placementKey(row) === type || (row.type === type && !row.slot));
  if (!self) return placements.slice();
  const tx = dx < 0 ? self.x - 1 : dx > 0 ? self.x + self.w : self.x;
  const ty = dy < 0 ? self.y - 1 : dy > 0 ? self.y + self.h : self.y + Math.floor(self.h / 2);
  const hit = packed.find((row) => placementKey(row) !== placementKey(self) && occupies(row, tx, ty));
  if (!hit) return moveOrder(placements, type, dx + dy >= 0 ? 1 : -1);
  const copy = placements.slice();
  const a = indexOfKey(copy, type);
  const b = indexOfKey(copy, placementKey(hit));
  if (a < 0 || b < 0) return copy;
  const swap = copy[a]!;
  copy[a] = copy[b]!;
  copy[b] = swap;
  return copy;
}

function place(rows: Array<[WidgetId, Size]>, config?: LayoutConfig): LayoutDocument {
  return { v: 1, placements: rows.map(([type, size]) => ({ type, size })), ...(config ? { config } : {}) };
}

/** Accounts with no template keep the post-cowork Today stack, plus the morning brief. */
export function defaultLayout(surface: LayoutSurface): LayoutDocument {
  if (surface === "today") {
    return place([
      ["orbit", "m"],
      ["meeting-cues", "m"],
      ["morning-brief", "s"],
      ["calendar", "m"],
      ["stale-nudges", "m"],
      ["focus", "l"],
      ["proposals", "m"],
      ["deliverables", "m"],
      ["reminders", "s"],
    ]);
  }
  if (surface === "context") {
    return place([
      ["people", "m"],
      ["meetings", "m"],
      ["repos", "m"],
      ["artifacts", "l"],
      ["graph", "l"],
      ["recent-links", "m"],
    ]);
  }
  return { v: 1, placements: [] };
}

export function widgetIdsFor(surface: LayoutSurface): WidgetId[] {
  return WIDGET_IDS.filter((id) => WIDGET_REGISTRY[id].surfaces.includes(surface));
}
