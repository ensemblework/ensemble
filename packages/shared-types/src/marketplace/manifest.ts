/**
 * Cards for the gallery. No starter rows, no layout documents.
 * The page can import this without pulling the seed text into the client.
 */
export type MarketCard = {
  id: string;
  persona: string;
  name: string;
  blurb: string;
  accent: string | null;
  /** Optional modules this template turns off. */
  removes: string[];
  /** Widget ids placed on any surface. */
  widgets: string[];
  expiresInDays: number | null;
};

export const MARKET_CARDS: readonly MarketCard[] = [
  {
    id: "mkt.semester-desk",
    persona: "student",
    name: "Semester",
    blurb: "The week, the deadlines, and every course, on one desk.",
    accent: "orchid",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["timetable", "assignment-countdown", "focus", "reading-queue", "calendar", "people", "artifacts", "group-load"],
    expiresInDays: null,
  },
  {
    id: "mkt.exam-season",
    persona: "aspirant",
    name: "Exam season",
    blurb: "One date, the syllabus, the mocks and today's revision. A season, not a second life.",
    accent: "rose",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["exam-countdown", "revision-due", "quiz-pile", "reminders", "artifacts", "reading-queue"],
    expiresInDays: 14,
  },
  {
    id: "mkt.literature-desk",
    persona: "researcher",
    name: "Literature desk",
    blurb: "Papers move from To read to Cited, and the chapter grows beside them.",
    accent: "tide",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["reading-queue", "focus", "countdown", "open-questions", "artifacts", "graph", "decisions"],
    expiresInDays: null,
  },
  {
    id: "mkt.chambers",
    persona: "lawyer",
    name: "Chambers",
    blurb: "Limitation dates stay on screen, even when the docket is empty.",
    accent: "brass",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["limitation", "matter-dates", "focus", "time-week", "people", "artifacts", "clause-pair"],
    expiresInDays: null,
  },
  {
    id: "mkt.bench",
    persona: "maker",
    name: "Bench",
    blurb: "The build on a timeline, the parts in hand, and every test by board.",
    accent: "sky",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["change-requests", "test-log", "spec-register", "focus", "artifacts", "people", "decisions"],
    expiresInDays: null,
  },
  {
    id: "mkt.staff-week",
    persona: "manager",
    name: "Staff week",
    blurb: "Who is carrying the week, who you haven't met, and what you already decided.",
    accent: "ember",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["one-on-ones", "person-load", "incident-now", "calendar", "people", "decisions", "okr-strip", "meetings"],
    expiresInDays: null,
  },
  {
    id: "mkt.branch-desk",
    persona: "engineer",
    name: "Branch desk",
    blurb: "The editor, the reviews, and the board, back on.",
    accent: null,
    removes: ["plots"],
    widgets: ["focus", "review-queue", "calendar", "needs-me", "repos", "people", "graph", "column-summary", "wip", "blocked"],
    expiresInDays: null,
  },
  {
    id: "mkt.classes",
    persona: "teacher",
    name: "This week's classes",
    blurb: "The period you're in, the one after, and the marking pile by class.",
    accent: "moss",
    removes: ["code", "metrics", "runs", "skills", "workspace", "plots"],
    widgets: ["timetable", "lesson-next", "grading-queue", "calendar", "class-list", "artifacts", "meetings"],
    expiresInDays: null,
  },
];
