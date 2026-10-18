import { templateCard } from "@ensemble/shared-types/manifest";
import { deskIdFromTemplate, type DeskId } from "./desks";
import type { Role } from "../onboarding/roles";

export const TILE_CATEGORIES = ["All tiles", "Progress & insights", "Planning & calendar", "People & meetings", "Work & resources"] as const;
export type TileCategory = (typeof TILE_CATEGORIES)[number];

const SHARED = new Set("day focus proposed needs dels reminders brief deadlines people follow meet questions decisions wip blocked blockers done objectives progress workload calendar agenda time-split due-week".split(" "));
const ROLE_TILES: Record<Role, string> = {
  student: "week courses streak now plan group reading countdown target affairs syllabus mocks revision hours accuracy pipeline words cites read advisor venue concepts",
  teacher: "week periods marking syllabus attendance duty paper countdown mocks accuracy read reading cites ones concepts hours courses now",
  lawyer: "limitation hearings billable stages filings drafts cause unbilled cites read reading ones hours",
  engineer: "reviews repos checks deploys issues ones load tests result build next log concepts hours",
  vibe: "build parts tests log count lead result next issues concepts hold hours",
  manager: "load ones out build next hours reviews issues",
};

export function deskRole(desk: DeskId, onboardingId?: string | null): Role {
  const card = onboardingId ? templateCard(onboardingId) : undefined;
  if (card) return card.role;
  return ({ default: "engineer", semester: "student", exam: "student", literature: "student", classes: "teacher", chambers: "lawyer", staff: "manager", branch: "engineer", bench: "vibe" } as const)[desk];
}

/** The profile the shell's templates describe: the sign-up card's role, else the desk's. Null before the shell loads. */
export function shellProfile(shell: { activeTemplateId?: string | null; onboardingTemplateId?: string | null } | null | undefined): Role | null {
  if (!shell) return null;
  return deskRole(deskIdFromTemplate(shell.activeTemplateId ?? null) ?? "default", shell.onboardingTemplateId);
}

export function tileFitsRole(key: string, role: Role): boolean {
  return SHARED.has(key) || ROLE_TILES[role].split(" ").includes(key);
}

export function tileCategory(key: string): TileCategory {
  if ("progress workload time-split due-week marking attendance streak accuracy mocks hours billable unbilled objectives stages words checks tests result parts count".split(" ").includes(key)) return "Progress & insights";
  if ("calendar agenda week periods now countdown deadlines dels reminders brief paper cause hearings limitation venue next lead build plan revision syllabus target".split(" ").includes(key)) return "Planning & calendar";
  if ("people group advisor follow ones out load meet".split(" ").includes(key)) return "People & meetings";
  return "Work & resources";
}

const DESCRIPTIONS: Record<string, string> = {
  progress: "See recent completed, active, planned, and waiting work in one donut chart.",
  workload: "Compare recent work in each status with a clear column chart.",
  agenda: "Upcoming meetings and events from your connected Google or Outlook calendar.",
  calendar: "Explore a month of deadlines and reminders. Select a day to see what is due.",
  "time-split": "See where your logged hours go, grouped by subject or activity.",
  "due-week": "Balance the next seven days using a daily chart of dated work.",
  marking: "Compare marked and remaining submissions for each class.",
  mocks: "Compare recorded mock scores on a 0–100% scale, grouped by subject.",
  attendance: "Present and absent counts, with the attendance rate calculated from both.",
  syllabus: "See completed units and the next phase without guessing at progress.",
  read: "A reading shelf with each source's current status.",
  reading: "A reading shelf with each source's current status.",
  drafts: "Compare document stages and open each draft from its card.",
  cites: "Keep claims connected to the sources that support them.",
  ones: "See the next check-in from each person's cadence and last interaction.",
  meet: "Keep meeting notes within reach, ready for the next conversation.",
  people: "People cards with roles and the last recorded interaction.",
  follow: "Return to recent meetings and the people around your work.",
  checks: "A pass, fail, and unknown breakdown backed by your recorded checks.",
};

export function tileDescription(spec: { key: string; ghost: string; sub?: string }): string {
  return DESCRIPTIONS[spec.key] ?? spec.sub ?? spec.ghost;
}
