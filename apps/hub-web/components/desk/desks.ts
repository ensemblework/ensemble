import type { AccentId } from "./ui";

export const DESK_IDS = ["default", "semester", "exam", "literature", "chambers", "classes", "staff", "branch", "bench"] as const;
export type DeskId = (typeof DESK_IDS)[number];

export type DeskMeta = {
  id: DeskId;
  name: string;
  persona: string;
  accent: AccentId;
  board?: string;
  line: string;
  empty: string;
  steps: Array<{ l: string; s: string }>;
  /** Column, row. `on` includes the reserved Plots slot. */
  spans: { off: Array<[number, number]>; on: Array<[number, number]> };
};

const pair = (rows: Array<[number, number]>) => rows;

export const DESKS: Record<DeskId, DeskMeta> = {
  default: {
    id: "default",
    name: "Your desk",
    persona: "Default",
    accent: "indigo",
    line: "Good morning, Prajwal. Priya is waiting on the latency numbers; the ranker ADR has your 10 am block.",
    empty: "You're on Your desk. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add what needs you", s: "a decision or a review" },
      { l: "Connect your calendar", s: "the day fills in" },
      { l: "Name a deliverable", s: "so the date stays visible" },
    ],
    spans: {
      off: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [4, 3], [4, 3], [4, 3]]),
      on: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [3, 3], [3, 3], [3, 3], [3, 3]]),
    },
  },
  semester: {
    id: "semester",
    name: "Semester",
    persona: "Student",
    accent: "orchid",
    board: "Coursework",
    line: "CN assignment 2 is due tonight. You're in OS until 12:15, and attendance in CN is at 72%.",
    empty: "You're on Semester. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add your timetable", s: "a photo of the PDF works" },
      { l: "Forward one Moodle email", s: "deadlines pin themselves" },
      { l: "Name your group", s: "for the mini-project" },
    ],
    spans: {
      off: pair([[12, 4], [4, 4], [8, 2], [5, 2], [3, 2], [4, 3], [4, 3], [4, 3]]),
      on: pair([[12, 4], [4, 4], [8, 2], [5, 2], [3, 2], [3, 3], [3, 3], [3, 3], [3, 3]]),
    },
  },
  exam: {
    id: "exam",
    name: "Exam season",
    persona: "Aspirant",
    accent: "rose",
    board: "Plan",
    line: "235 days to Prelims. Five topics are due for revision, and mock 10 moved you to 106.",
    empty: "You're on Exam season. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Set the exam date", s: "the countdown starts" },
      { l: "Load the syllabus", s: "coverage has a home" },
      { l: "Add a mock score", s: "two points make a line" },
    ],
    spans: {
      off: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [5, 3], [4, 3], [3, 3]]),
      on: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [5, 3], [4, 3], [3, 3]]),
    },
  },
  literature: {
    id: "literature",
    name: "Literature desk",
    persona: "Researcher",
    accent: "tide",
    board: "Papers",
    line: "Chapter 2 is at 7,840 words. ARR closes in 15 days, and Dr. Iyer meets you Monday.",
    empty: "You're on Literature desk. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add a paper", s: "it starts in To read" },
      { l: "Link your draft", s: "the word count follows" },
      { l: "Pick a venue", s: "the deadline stays up" },
    ],
    spans: {
      off: pair([[12, 4], [4, 3], [4, 3], [4, 3], [6, 3], [3, 3], [3, 3]]),
      on: pair([[12, 4], [3, 3], [3, 3], [3, 3], [3, 3], [6, 3], [3, 3], [3, 3]]),
    },
  },
  chambers: {
    id: "chambers",
    name: "Chambers",
    persona: "Legal",
    accent: "brass",
    board: "Matters",
    line: "Good morning, Prajwal. Two limitation dates fall inside a week, and Khanna is item 14 in Court 32.",
    empty: "You're on Chambers. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add a matter", s: "with its order date" },
      { l: "Connect your calendar", s: "hearings fill in" },
      { l: "Set a billable target", s: "40 h is typical" },
    ],
    spans: {
      off: pair([[12, 4], [6, 3], [3, 3], [3, 3], [5, 4], [4, 4], [3, 2], [3, 2], [6, 3], [6, 3]]),
      on: pair([[12, 4], [6, 3], [3, 3], [3, 3], [5, 4], [4, 4], [3, 2], [3, 2], [6, 3], [6, 3]]),
    },
  },
  classes: {
    id: "classes",
    name: "This week's classes",
    persona: "Teacher",
    accent: "moss",
    board: "Lessons",
    line: "Period 5 with 10-B in Lab 2, 20 minutes left. 85 copies to mark, and 12-A's pre-board is due Friday.",
    empty: "You're on This week's classes. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add today's periods", s: "the timetable fills" },
      { l: "Add a set to mark", s: "the pile has a class" },
      { l: "Set the next paper", s: "the date stays visible" },
    ],
    spans: {
      off: pair([[12, 4], [4, 3], [4, 3], [4, 3], [3, 2], [3, 2], [3, 2], [3, 2]]),
      on: pair([[12, 4], [4, 3], [4, 3], [4, 3], [3, 2], [3, 2], [6, 4], [3, 2], [3, 2]]),
    },
  },
  staff: {
    id: "staff",
    name: "Staff week",
    persona: "Manager",
    accent: "ember",
    board: "Team board",
    line: "Two people are over capacity, and you haven't met Divya in 29 days. Four blockers are open.",
    empty: "You're on Staff week. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Add your team", s: "load has a name" },
      { l: "Set a 1:1 cadence", s: "overdue meetings show" },
      { l: "Log a decision", s: "so it stays decided" },
    ],
    spans: {
      off: pair([[8, 4], [4, 4], [6, 3], [6, 3], [7, 3], [5, 3]]),
      on: pair([[8, 4], [4, 4], [4, 3], [4, 3], [4, 3], [7, 3], [5, 3]]),
    },
  },
  branch: {
    id: "branch",
    name: "Branch desk",
    persona: "Developer",
    accent: "indigo",
    line: "Three reviews are waiting on you, #479 has a failing check, and v0.42.1 went to prod two hours ago.",
    empty: "You're on Branch desk. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Link a repo", s: "reviews and CI show up" },
      { l: "Connect deploys", s: "what shipped stays visible" },
      { l: "Name the work in progress", s: "the cap stays honest" },
    ],
    spans: {
      off: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [4, 2], [4, 2], [4, 2]]),
      on: pair([[8, 4], [4, 2], [4, 2], [6, 3], [6, 3], [3, 2], [3, 2], [3, 2], [3, 2]]),
    },
  },
  bench: {
    id: "bench",
    name: "Bench",
    persona: "Maker",
    accent: "sky",
    board: "Build",
    line: "Rev C boards are in transit, B2 failed thermal at 6 A, and 7 parts are still out.",
    empty: "You're on Bench. Every tile below is waiting for its first entry.",
    steps: [
      { l: "Paste a BOM", s: "parts get a status" },
      { l: "Log a test run", s: "pass and fail show" },
      { l: "Name the next milestone", s: "the date stays up" },
    ],
    spans: {
      off: pair([[12, 4], [4, 4], [4, 4], [4, 4], [3, 2], [3, 2], [3, 2], [3, 2]]),
      on: pair([[12, 4], [4, 4], [4, 4], [4, 4], [3, 2], [3, 2], [6, 4], [3, 2], [3, 2]]),
    },
  },
};

const TEMPLATE_DESK: Record<string, DeskId> = {
  default: "default",
  "mkt.semester-desk": "semester",
  "mkt.exam-season": "exam",
  "mkt.exam-sprint": "exam",
  "mkt.prelims-season": "exam",
  "mkt.literature-desk": "literature",
  "mkt.chambers": "chambers",
  "mkt.classes": "classes",
  "mkt.staff-week": "staff",
  "mkt.branch-desk": "branch",
  "mkt.bench": "bench",
};

export const MARKET_ID: Record<DeskId, string> = {
  default: "default",
  semester: "mkt.semester-desk",
  exam: "mkt.exam-season",
  literature: "mkt.literature-desk",
  chambers: "mkt.chambers",
  classes: "mkt.classes",
  staff: "mkt.staff-week",
  branch: "mkt.branch-desk",
  bench: "mkt.bench",
};

/** A marketplace id, including Default, uses the bento. Signup ids are not desks. */
export function deskIdFromTemplate(id: string | null | undefined): DeskId | null {
  if (!id) return null;
  return TEMPLATE_DESK[id] ?? null;
}
