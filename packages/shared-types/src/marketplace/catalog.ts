/**
 * Marketplace templates. The web should import ./manifest, which has no starter rows.
 * Apply reads this module on the server and ignores any body the client sends.
 */
import { OPTIONAL_MODULES, serializeModules, type OptionalModule } from "../modules.js";
import type { AccentPreset, ActAs } from "../assistant.js";
import type { LayoutDocument, Size, WidgetId } from "../widgets.js";

export const MARKET_ID = /^mkt\.[a-z0-9-]{1,40}$/;
export const LABEL_KEYS = ["project", "projects", "task", "tasks", "deliverable", "deliverables", "board", "people"] as const;
export type ChromeLabelKey = (typeof LABEL_KEYS)[number];
export type ChromeLabels = Partial<Record<ChromeLabelKey, string>>;

export type MarketPersona = "student" | "teacher" | "lawyer" | "researcher" | "manager" | "aspirant" | "maker" | "engineer";

export type MarketLens = {
  groupBy: "kind" | "project";
  kinds: Array<"people" | "projects" | "repos" | "meetings" | "artifacts">;
};

export type MarketTask = {
  slug: string;
  title: string;
  taskType?: string;
  dueInDays?: number;
  page?: string;
  measure?: number;
  /** Deliverable slug this task produces. */
  deliverable?: string;
};

export type MarketProject = {
  slug: string;
  name: string;
  summary?: string;
  people?: Array<{ slug: string; name: string; role?: string }>;
  tasks?: MarketTask[];
  deliverables?: Array<{ slug: string; title: string; dueInDays?: number | null }>;
  artifacts?: Array<{ slug: string; title: string; kind?: "file" | "pr"; task?: string }>;
  reminders?: Array<{ slug: string; title: string; dueInDays: number }>;
  notes?: Array<{ slug: string; title: string; body: string; people?: string[] }>;
  repo?: { slug: string; fullName: string };
};

export type MarketTemplate = {
  id: string;
  version: number;
  persona: MarketPersona;
  name: string;
  blurb: string;
  accent?: AccentPreset;
  actAs: ActAs;
  highlights: string[];
  modules: OptionalModule[];
  labels?: ChromeLabels;
  lens?: MarketLens;
  expiresInDays?: number;
  layouts: { today: LayoutDocument; context: LayoutDocument; board?: LayoutDocument };
  starters: MarketProject[];
};

/** Desks drop the engineering modules but keep diagrams, which suit every role. */
const DESK: OptionalModule[] = ["diagrams"];
const ALL: OptionalModule[] = ["code", "workspace", "runs", "metrics", "skills", "diagrams"];

function lay(rows: Array<[WidgetId, Size]>, config?: LayoutDocument["config"]): LayoutDocument {
  return { v: 2, placements: rows.map(([type, size]) => ({ type, size })), ...(config ? { config } : {}) };
}

const STUDENT = ["Split this into tasks", "Quiz me from my notes", "Check the citations", "Summarise who did what"];
const TEACHER = ["Draft a lesson plan", "Write inline feedback", "Who is falling behind?", "Practice questions"];
const LAWYER = ["Summarise the clause", "Extract obligations and deadlines", "Compare the two drafts", "Flag risky wording"];
const ENGINEER = ["Triage this into repo-linked tasks", "Find who knows this code", "Explain this plainly", "Release notes from completed work"];
const RESEARCHER = ["What does this source actually say?", "Where is this claim supported?", "What is still open?", "Summarise the experiment"];
const MANAGER = ["Who is overloaded?", "What did we decide?", "Draft the 1:1", "What is blocked?"];
const ASPIRANT = ["What should I revise today?", "Which topic did the mock miss?", "Quiz me on this", "What did I save this week?"];
const MAKER = ["What changed since the last spec?", "List the open changes", "Summarise the test", "Who needs to see this?"];

export const MARKETPLACE: readonly MarketTemplate[] = [
  {
    id: "mkt.semester-desk",
    version: 1,
    persona: "student",
    name: "Semester",
    blurb: "The week, the deadlines, and every course, on one desk.",
    accent: "orchid",
    actAs: "student",
    labels: { board: "Coursework", project: "Course", projects: "Courses" },
    highlights: [...STUDENT],
    modules: DESK,
    lens: { groupBy: "project", kinds: ["people", "artifacts"] },
    layouts: {
      today: lay([
        ["timetable", "m"],
        ["assignment-countdown", "m"],
        ["focus", "m"],
        ["reading-queue", "m"],
        ["calendar", "m"],
      ]),
      context: lay([
        ["people", "m"],
        ["artifacts", "l"],
        ["group-load", "m"],
      ]),
    },
    starters: [
      {
        slug: "semester",
        name: "This semester",
        summary: "The course in front of you.",
        people: [{ slug: "instructor", name: "Instructor" }],
        tasks: [
          { slug: "brief", title: "Read the brief", taskType: "reading" },
          { slug: "rubric", title: "List what the rubric grades", taskType: "reading" },
          { slug: "seminar", title: "Seminar notes", taskType: "reading" },
          { slug: "sources", title: "Find two sources", taskType: "reading" },
          { slug: "outline", title: "Outline the essay", dueInDays: 7 },
        ],
        deliverables: [
          { slug: "essay", title: "Essay draft", dueInDays: 14 },
          { slug: "problem", title: "Problem set", dueInDays: 4 },
        ],
      },
    ],
  },
  {
    id: "mkt.exam-season",
    version: 1,
    persona: "aspirant",
    name: "Exam season",
    blurb: "One date, the syllabus, the mocks and today's revision. A season, not a second life.",
    accent: "rose",
    actAs: "aspirant",
    highlights: [...ASPIRANT],
    modules: DESK,
    labels: { board: "Plan" },
    lens: { groupBy: "project", kinds: ["artifacts"] },
    layouts: {
      today: lay([
        ["exam-countdown", "m"],
        ["revision-due", "m"],
        ["quiz-pile", "m"],
        ["reminders", "m"],
      ]),
      context: lay([
        ["artifacts", "m"],
        ["reading-queue", "m"],
      ]),
    },
    starters: [
      {
        slug: "exam",
        name: "Exam",
        summary: "The date, and the practice before it.",
        tasks: [
          { slug: "final", title: "Final", taskType: "exam", dueInDays: 5 },
          { slug: "practice", title: "Practice set 1", taskType: "revision", dueInDays: 2 },
          { slug: "weak", title: "Weak spots", taskType: "revision", dueInDays: 3 },
          { slug: "practice-2", title: "Practice set 2", taskType: "revision", dueInDays: 4 },
          {
            slug: "prompts",
            title: "Prompts",
            page: ["Define the term.", "Give the exception.", "Name the case.", "State the rule.", "Apply it to the facts.", "What would change the result?", "Compare the two tests.", "Where is the citation?", "What did you miss last time?", "One sentence, from memory."].join("\n"),
          },
        ],
        deliverables: [{ slug: "final-date", title: "Final", dueInDays: 5 }],
        reminders: [{ slug: "night-before", title: "Night before the final", dueInDays: 4 }],
      },
    ],
  },
  {
    id: "mkt.literature-desk",
    version: 1,
    persona: "researcher",
    name: "Literature desk",
    blurb: "Papers move from To read to Cited, and the chapter grows beside them.",
    accent: "tide",
    actAs: "researcher",
    labels: { board: "Papers", project: "Paper", projects: "Papers" },
    highlights: [...RESEARCHER],
    modules: DESK,
    lens: { groupBy: "project", kinds: ["artifacts", "people"] },
    layouts: {
      today: lay([
        ["reading-queue", "m"],
        ["focus", "m"],
        ["countdown", "s"],
        ["open-questions", "m"],
      ]),
      context: lay([
        ["artifacts", "l"],
        ["graph", "m"],
        ["decisions", "m"],
      ]),
    },
    starters: [
      {
        slug: "paper",
        name: "Paper",
        summary: "One claim, and the sources under it.",
        tasks: [
          { slug: "source-a", title: "Source A notes", taskType: "reading", page: "Claim.\n\nQuote.\n\nPage." },
          { slug: "claim", title: "The claim", taskType: "reading", page: "The sentence we are willing to defend." },
          { slug: "open", title: "What is still open?", taskType: "question" },
          { slug: "edition", title: "Which edition?", taskType: "question" },
          { slug: "margin", title: "Margin notes", taskType: "reading" },
          { slug: "gap", title: "Where is the gap?", taskType: "question" },
        ],
        deliverables: [{ slug: "draft", title: "Draft", dueInDays: 21 }],
      },
    ],
  },
  {
    id: "mkt.chambers",
    version: 1,
    persona: "lawyer",
    name: "Chambers",
    blurb: "Limitation dates stay on screen, even when the docket is empty.",
    accent: "brass",
    actAs: "lawyer",
    highlights: [...LAWYER],
    modules: DESK,
    labels: { project: "Matter", projects: "Matters", deliverable: "Filing", board: "Matters" },
    lens: { groupBy: "project", kinds: ["people", "projects", "artifacts"] },
    layouts: {
      today: lay([
        ["limitation", "m"],
        ["matter-dates", "m"],
        ["focus", "m"],
        ["time-week", "s"],
      ]),
      context: lay([
        ["people", "m"],
        ["artifacts", "l"],
        ["clause-pair", "m"],
      ]),
    },
    starters: [
      {
        slug: "matter",
        name: "Rao v. Sunrise Hospital",
        summary: "Pleadings, the limitation date, and who is on the record.",
        people: [
          { slug: "rao", name: "Sunita Rao", role: "Client" },
          { slug: "sen", name: "Adv. Kavita Sen", role: "Senior counsel" },
          { slug: "yadav", name: "Suresh Yadav", role: "Clerk · filings" },
        ],
        tasks: [
          { slug: "limitation", title: "Limitation", taskType: "limitation", dueInDays: 10, deliverable: "filing" },
          { slug: "draft-a", title: "Draft A", page: "The first draft." },
          { slug: "draft-b", title: "Draft B", page: "The second draft." },
          { slug: "client-call", title: "Call the client", taskType: "time", measure: 25 },
          { slug: "drafting", title: "Drafting the reply", taskType: "time", measure: 40 },
          { slug: "follow-up", title: "Follow-up call", taskType: "time", measure: 15 },
          { slug: "cite-check", title: "Check the citations", dueInDays: 4 },
          { slug: "hearing", title: "Hearing date", taskType: "limitation", dueInDays: 21 },
        ],
        deliverables: [{ slug: "filing", title: "Filing", dueInDays: 10 }],
        reminders: [{ slug: "limitation-reminder", title: "Limitation", dueInDays: 10 }],
        notes: [{ slug: "conference", title: "Conference with Sunita Rao", body: "Limitation, the draft, and what we still owe.", people: ["rao"] }],
        repo: { slug: "briefs", fullName: "chambers/rao-sunrise" },
        artifacts: [
          { slug: "order", title: "HC order dt. 8 Jul 2026 · certified copy.pdf", kind: "file", task: "draft-a" },
          { slug: "pr", title: "rao-sunrise #12 · vakalatnama", kind: "pr", task: "limitation" },
        ],
      },
    ],
  },
  {
    id: "mkt.bench",
    version: 1,
    persona: "maker",
    name: "Bench",
    blurb: "The build on a timeline, the parts in hand, and every test by board.",
    accent: "sky",
    actAs: "maker",
    highlights: [...MAKER],
    modules: DESK,
    labels: { deliverable: "Spec", task: "Change", board: "Build" },
    lens: { groupBy: "project", kinds: ["artifacts", "projects"] },
    layouts: {
      today: lay([
        ["change-requests", "m"],
        ["test-log", "m"],
        ["spec-register", "m"],
        ["focus", "m"],
      ]),
      context: lay([
        ["artifacts", "l"],
        ["people", "s"],
        ["decisions", "m"],
      ]),
    },
    starters: [
      {
        slug: "bench",
        name: "Bench",
        summary: "The work on the bench.",
        tasks: [
          { slug: "tolerance", title: "Change: tolerance", taskType: "change" },
          { slug: "finish", title: "Change: finish", taskType: "change" },
          { slug: "radius", title: "Change: corner radius", taskType: "change" },
          { slug: "first-run", title: "Test: first run", taskType: "test", measure: 70 },
          { slug: "drop", title: "Test: drop", taskType: "test", measure: 40 },
        ],
        artifacts: [{ slug: "spec", title: "Spec" }],
      },
    ],
  },
  {
    id: "mkt.staff-week",
    version: 1,
    persona: "manager",
    name: "Staff week",
    blurb: "Who is carrying the week, who you haven't met, and what you already decided.",
    accent: "ember",
    actAs: "manager",
    labels: { board: "Team board" },
    highlights: [...MANAGER],
    modules: DESK,
    lens: { groupBy: "project", kinds: ["people", "projects"] },
    layouts: {
      today: lay([
        ["one-on-ones", "m"],
        ["person-load", "m"],
        ["incident-now", "m"],
        ["calendar", "m"],
      ]),
      context: lay([
        ["people", "l"],
        ["decisions", "m"],
        ["okr-strip", "m"],
        ["meetings", "m"],
      ]),
    },
    starters: [
      {
        slug: "team",
        name: "Team",
        summary: "The people, and the decision.",
        people: [
          { slug: "teammate", name: "Teammate" },
          { slug: "asha", name: "Asha Rao" },
          { slug: "dev", name: "Dev Iyer" },
        ],
        tasks: [
          { slug: "one-on-one", title: "1:1 notes", taskType: "decision" },
          { slug: "asha", title: "1:1 with Asha", taskType: "decision" },
          { slug: "dev", title: "1:1 with Dev", taskType: "decision" },
          { slug: "ship-date", title: "Decision: ship date", taskType: "decision" },
          { slug: "hiring", title: "Decision: hiring", taskType: "decision" },
        ],
        deliverables: [{ slug: "objective", title: "Objective", dueInDays: 30 }],
      },
    ],
  },
  {
    id: "mkt.branch-desk",
    version: 1,
    persona: "engineer",
    name: "Branch desk",
    blurb: "The editor, the reviews, and the board, back on.",
    actAs: "engineer",
    highlights: [...ENGINEER],
    modules: ALL,
    lens: { groupBy: "kind", kinds: ["repos", "people", "projects"] },
    layouts: {
      today: lay([
        ["focus", "m"],
        ["review-queue", "m"],
        ["calendar", "m"],
        ["needs-me", "s"],
        ["repos", "m"],
      ]),
      context: lay([
        ["repos", "l"],
        ["people", "m"],
        ["graph", "l"],
      ]),
      board: lay(
        [
          ["column-summary", "s"],
          ["wip", "m"],
          ["blocked", "m"],
        ],
        { wipCap: 3 },
      ),
    },
    starters: [
      {
        slug: "current",
        name: "Current work",
        summary: "What is in front of you. No invented repo.",
        tasks: [
          { slug: "review", title: "Open the review" },
          { slug: "test", title: "Write the test" },
          { slug: "notes", title: "Write the release notes" },
          { slug: "flaky", title: "Look at the flaky check" },
        ],
      },
    ],
  },
  {
    id: "mkt.classes",
    version: 1,
    persona: "teacher",
    name: "This week's classes",
    blurb: "The period you're in, the one after, and the marking pile by class.",
    accent: "moss",
    actAs: "teacher",
    highlights: [...TEACHER],
    modules: DESK,
    labels: { project: "Class", board: "Lessons" },
    lens: { groupBy: "project", kinds: ["people", "artifacts"] },
    layouts: {
      today: lay([
        ["timetable", "m"],
        ["lesson-next", "m"],
        ["grading-queue", "m"],
        ["calendar", "m"],
      ]),
      context: lay([
        ["class-list", "l"],
        ["artifacts", "m"],
        ["meetings", "m"],
      ]),
    },
    starters: [
      {
        slug: "week",
        name: "This week",
        summary: "The class in front of you.",
        people: [{ slug: "student", name: "Student" }],
        tasks: [
          { slug: "lesson", title: "Draft the lesson", taskType: "lesson" },
          { slug: "marking", title: "Mark set 1", taskType: "marking" },
          { slug: "mark-2", title: "Mark set 2", taskType: "marking" },
          { slug: "mark-3", title: "Mark set 3", taskType: "marking" },
        ],
        deliverables: [{ slug: "worksheet", title: "Worksheet", dueInDays: 7 }],
      },
    ],
  },
];

export function templateByMarketId(id: string): MarketTemplate | undefined {
  return MARKETPLACE.find((row) => row.id === id);
}

export function modulesRemoved(template: MarketTemplate): OptionalModule[] {
  const on = new Set(template.modules);
  return OPTIONAL_MODULES.filter((id) => !on.has(id));
}

export function moduleSetFor(template: MarketTemplate): string {
  return serializeModules(template.modules);
}

const ALLOWED_URL = /^(\/(today|board|context|meetings)(\/|$)|\/(tasks|projects)\/)/;

export function textSafe(value: string): boolean {
  if (/[<>]/.test(value)) return false;
  const urls = value.match(/https?:\/\/\S+|\/[a-z0-9][^\s]*/gi) ?? [];
  return urls.every((url) => url.startsWith("/") && ALLOWED_URL.test(url));
}
