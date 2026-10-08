import type { OnboardingRole } from "./catalog.js";

/** The persona desks a signup template can land on. Hub-web owns what each desk draws. */
export const TEMPLATE_DESKS = ["semester", "exam", "literature", "chambers", "classes", "staff", "branch", "bench"] as const;
export type TemplateDesk = (typeof TEMPLATE_DESKS)[number];

/** A live Today tile: its key in the hub-web tile pool, then columns (of 12) and rows. */
export type DeskTile = readonly [key: string, c: number, r: number];

/** Cards only. Signup must not import starter rows or the widget canvas. */
export type TemplateCard = {
  id: string;
  role: OnboardingRole;
  name: string;
  blurb: string;
  desk: TemplateDesk;
  /** The Today arrangement this template starts with. Every template in a role draws a different one. */
  tiles: readonly DeskTile[];
  /** Three short things the template is built around, shown on the card. */
  features: readonly [string, string, string];
};

export const DESK_MARKET_ID: Record<TemplateDesk, string> = {
  semester: "mkt.semester-desk",
  exam: "mkt.exam-season",
  literature: "mkt.literature-desk",
  chambers: "mkt.chambers",
  classes: "mkt.classes",
  staff: "mkt.staff-week",
  branch: "mkt.branch-desk",
  bench: "mkt.bench",
};

const card = (
  role: OnboardingRole,
  id: string,
  name: string,
  blurb: string,
  desk: TemplateDesk,
  tiles: DeskTile[],
  features: [string, string, string],
): TemplateCard => ({ id, role, name, blurb, desk, tiles, features });

export const TEMPLATE_CARDS: readonly TemplateCard[] = [
  card("student", "semester-desk", "Semester desk", "Several courses, one desk. The essay, the instructor, and what is due sit on the same graph.", "semester",
    [["week", 12, 4], ["deadlines", 4, 4], ["plan", 4, 4], ["courses", 4, 2], ["now", 4, 2], ["reading", 6, 3], ["streak", 6, 3]],
    ["Your week as a timetable", "Deadlines on one rail", "Attendance streak"]),
  card("student", "exam-week", "Exam week", "Seven days, a final, and a reminder the evening before. Nothing else.", "exam",
    [["countdown", 8, 4], ["target", 4, 2], ["hours", 4, 2], ["syllabus", 6, 3], ["mocks", 6, 3], ["revision", 8, 3], ["accuracy", 4, 3]],
    ["Days-to-exam countdown", "Mock scores as a line", "Revision by subject"]),
  card("student", "group-project", "Group project", "Names on the work. Who did what is a task with a person, not a spreadsheet.", "semester",
    [["group", 6, 4], ["plan", 6, 4], ["follow", 4, 3], ["deadlines", 4, 3], ["questions", 4, 3]],
    ["Who is on what", "One shared plan", "Follow-ups you owe"]),
  card("student", "reading-pile", "Reading pile", "Notes that should become tasks. The quote lives on the task, not in a second notebook.", "literature",
    [["read", 8, 4], ["cites", 4, 4], ["questions", 6, 3], ["dels", 6, 3]],
    ["Reading queue", "Claims linked to sources", "Open questions"]),
  card("student", "application-season", "Application season", "Many deadlines, little daily class. Due dates already enter focus.", "exam",
    [["dels", 8, 4], ["deadlines", 4, 4], ["reminders", 4, 3], ["follow", 4, 3], ["plan", 4, 3]],
    ["Every deadline in one place", "Referee follow-ups", "Reminders the day before"]),
  card("student", "thesis-year", "Thesis year", "Papers move from to-read to drafted. The advisor and the word count stay in view.", "literature",
    [["pipeline", 12, 4], ["words", 4, 3], ["cites", 4, 3], ["advisor", 4, 3], ["questions", 6, 2], ["venue", 6, 2]],
    ["Paper pipeline", "Word count that moves", "Advisor and co-authors"]),

  card("teacher", "weeks-lessons", "This week's lessons", "Plan, then assign. The lesson page and the worksheet share a project.", "classes",
    [["periods", 12, 4], ["syllabus", 6, 3], ["duty", 3, 3], ["paper", 3, 3], ["marking", 4, 2], ["meet", 4, 2], ["attendance", 4, 2]],
    ["Timetable by period", "Lesson plan per class", "Next paper date"]),
  card("teacher", "check-ins", "Who needs a check-in", "People before content. Placeholder students, so rename or delete them.", "classes",
    [["people", 8, 4], ["attendance", 4, 2], ["meet", 4, 2], ["follow", 6, 3], ["ones", 6, 3]],
    ["Students who need you", "Attendance at a glance", "A check-in cadence"]),
  card("teacher", "marking-pile", "Marking pile", "Feedback is the work. The shape of a comment is already on the page.", "classes",
    [["marking", 8, 4], ["paper", 4, 4], ["focus", 6, 3], ["deadlines", 6, 3]],
    ["Sets left to mark", "Feedback as tasks", "Return-by dates"]),
  card("teacher", "office-hours", "Office hours", "The calendar is the queue. Notes from last time stay on the project.", "classes",
    [["week", 12, 4], ["questions", 6, 3], ["meet", 3, 3], ["people", 3, 3]],
    ["Office hours on the week", "Questions students asked", "Who came by"]),
  card("teacher", "course-hub", "Course hub", "Context is the course. People, the reading, and the unit share one project.", "classes",
    [["syllabus", 8, 4], ["read", 4, 4], ["periods", 6, 3], ["paper", 3, 3], ["duty", 3, 3]],
    ["Units and phases", "Course reading", "Periods this week"]),
  card("teacher", "exam-setter", "Exam setter", "Set the paper, mark it, and see which class needs another pass.", "classes",
    [["countdown", 8, 4], ["marking", 4, 4], ["mocks", 6, 3], ["attendance", 3, 3], ["duty", 3, 3]],
    ["Countdown to the paper", "Marking progress", "Class mock scores"]),

  card("lawyer", "matter-desk", "Matter desk", "One matter, its dates, its people. Rename Client before a sync.", "chambers",
    [["limitation", 12, 4], ["stages", 3, 3], ["hearings", 5, 3], ["billable", 4, 3], ["filings", 6, 3], ["follow", 6, 3]],
    ["Limitation band", "Hearings by court", "Billable hours"]),
  card("lawyer", "two-drafts", "Two drafts", "Two pages you will replace with the real clauses.", "chambers",
    [["drafts", 8, 4], ["filings", 4, 4], ["cites", 6, 3], ["follow", 6, 3]],
    ["Drafts side by side", "Filing dates", "Citations per clause"]),
  card("lawyer", "deadline-wall", "Deadline wall", "Dates ahead of narrative. Three reminders, one response.", "chambers",
    [["reminders", 8, 4], ["cause", 4, 4], ["limitation", 12, 3]],
    ["Reminders before each date", "Today's cause list", "Every limitation date"]),
  card("lawyer", "client-morning", "Client morning", "Who, then what they are waiting on.", "chambers",
    [["follow", 8, 4], ["people", 4, 4], ["billable", 4, 3], ["unbilled", 4, 3], ["focus", 4, 3]],
    ["Clients and what they wait on", "Unbilled time", "Today's focus"]),
  card("lawyer", "research-trail", "Research trail", "Every claim points at a source. The citation list starts empty on purpose.", "chambers",
    [["cites", 8, 4], ["read", 4, 4], ["questions", 6, 3], ["drafts", 6, 3]],
    ["Claim to source trail", "Reading list", "Open questions"]),
  card("lawyer", "in-house-counsel", "In-house counsel", "Contracts in review, what the business decided, and who is waiting on legal.", "chambers",
    [["drafts", 6, 4], ["decisions", 6, 4], ["needs", 4, 3], ["filings", 4, 3], ["reminders", 4, 3]],
    ["Contract review queue", "Decisions on record", "Who is waiting on you"]),

  card("engineer", "branch-desk", "Branch desk", "Daily driver. The repo tile stays empty until a real repo is connected.", "branch",
    [["reviews", 8, 4], ["repos", 4, 2], ["checks", 4, 2], ["issues", 6, 3], ["deploys", 6, 3], ["wip", 4, 2], ["blocked", 4, 2], ["done", 4, 2]],
    ["Reviews waiting on you", "Checks and deploys", "Work in progress"]),
  card("engineer", "inbox-triage", "Inbox triage", "Proposals first. Accept, hand to an agent, snooze, or drop.", "branch",
    [["proposed", 8, 4], ["needs", 4, 4], ["issues", 6, 3], ["blocked", 6, 3]],
    ["Proposals to accept or drop", "What needs you", "Blockers"]),
  card("engineer", "release-desk", "Release desk", "Cut notes from work that is actually done.", "branch",
    [["deploys", 8, 4], ["done", 4, 4], ["checks", 4, 3], ["reviews", 8, 3]],
    ["Deploy log", "Done this week", "Checks before release"]),
  card("engineer", "on-call-morning", "On-call morning", "What is blocked, then what is due.", "branch",
    [["blocked", 8, 4], ["checks", 4, 4], ["deploys", 6, 3], ["issues", 6, 3]],
    ["Blocked first", "Failing checks", "Recent deploys"]),
  card("engineer", "partner-work", "Partner work", "People and the last conversation, ahead of the repo.", "branch",
    [["follow", 8, 4], ["people", 4, 4], ["decisions", 6, 3], ["wip", 6, 3]],
    ["People and the last conversation", "Decisions", "Shared work in flight"]),
  card("engineer", "tech-lead", "Tech lead", "Reviews, the team's 1:1s, and the objectives the quarter is measured on.", "branch",
    [["reviews", 8, 4], ["decisions", 4, 4], ["ones", 6, 3], ["objectives", 6, 3], ["blocked", 12, 2]],
    ["Review queue", "1:1 cadence", "Objective progress"]),

  card("vibe", "one-idea", "One idea", "One project, three tasks, a page. Not a portfolio.", "bench",
    [["focus", 8, 4], ["next", 4, 4], ["questions", 6, 3], ["log", 6, 3]],
    ["One focus list", "The next milestone", "What shipped"]),
  card("vibe", "weekend-build", "Weekend build", "A date, a demo, then stop.", "bench",
    [["build", 12, 4], ["next", 4, 3], ["log", 4, 3], ["tests", 4, 3]],
    ["Milestones to the demo", "Ship log", "Test runs"]),
  card("vibe", "show-someone", "Show someone", "The work is explaining it, in sentences a friend can follow.", "bench",
    [["day", 8, 4], ["people", 4, 4], ["log", 6, 3], ["follow", 6, 3]],
    ["Today's plan", "Who to show it to", "Follow-ups"]),
  card("vibe", "learn-by-shipping", "Learn by shipping", "What broke lives on the task, next to the fix.", "bench",
    [["concepts", 8, 4], ["tests", 4, 4], ["log", 6, 3], ["result", 3, 3], ["next", 3, 3]],
    ["What you are learning", "Tests that broke", "Ship log"]),
  card("vibe", "keep-it-small", "Keep it small", "For people who hate dashboards. One task. Room around it.", "bench",
    [["focus", 12, 4], ["next", 6, 2], ["reminders", 6, 2]],
    ["One list", "One next step", "Nothing else"]),
  card("vibe", "launch-week", "Launch week", "A checklist, the people trying it, and the bugs they found.", "bench",
    [["dels", 8, 4], ["people", 4, 4], ["issues", 6, 3], ["log", 6, 3]],
    ["Launch checklist", "Beta testers", "Bugs to fix"]),

  card("manager", "staff-week", "Staff week", "Who is carrying the week, who you haven't met, and what you already decided.", "staff",
    [["load", 8, 4], ["blockers", 4, 4], ["ones", 6, 3], ["decisions", 6, 3], ["objectives", 6, 3], ["out", 6, 3]],
    ["Team load", "1:1 cadence", "Decisions on record"]),
  card("manager", "one-on-ones", "1:1s", "Every report, when you last met, and what you promised them.", "staff",
    [["ones", 8, 4], ["people", 4, 4], ["follow", 6, 3], ["decisions", 6, 3]],
    ["Who is due a 1:1", "Notes per person", "Follow-ups you owe"]),
  card("manager", "okr-quarter", "Quarter goals", "Objectives with real progress, and what is in the way.", "staff",
    [["objectives", 8, 4], ["dels", 4, 4], ["blockers", 6, 3], ["decisions", 6, 3]],
    ["Objectives with progress", "Key deliverables", "What is in the way"]),
  card("manager", "hiring-loop", "Hiring loop", "Candidates are people, interviews are meetings, and the call is a decision.", "staff",
    [["people", 8, 4], ["decisions", 4, 4], ["reminders", 4, 3], ["meet", 4, 3], ["follow", 4, 3]],
    ["Candidates in one place", "Hire or no-hire decisions", "Interview reminders"]),
  card("manager", "project-launch", "Project launch", "Milestones to a launch date, with blockers where you can see them.", "staff",
    [["build", 12, 4], ["blocked", 4, 3], ["dels", 4, 3], ["decisions", 4, 3]],
    ["Milestones to launch", "Blockers", "Deliverables"]),
  card("manager", "team-standup", "Team standup", "Today across the team: in progress, done, and stuck.", "staff",
    [["day", 8, 4], ["blockers", 4, 4], ["wip", 4, 3], ["done", 4, 3], ["out", 4, 3]],
    ["Today across the team", "In progress and done", "Who is stuck"]),
];

const BY_ID = new Map(TEMPLATE_CARDS.map((row) => [row.id, row]));

export function cardsForRole(role: string): TemplateCard[] {
  return TEMPLATE_CARDS.filter((row) => row.role === role);
}

export function templateCard(id: string): TemplateCard | undefined {
  return BY_ID.get(id);
}

/** The Today layout a template writes on signup. `exact` means the desk's other tiles start hidden. */
export function templateDeskLayout(id: string): { desk: TemplateDesk; key: string; value: { v: 1; exact: true; tiles: Array<{ key: string; c: number; r: number }>; hidden: string[] } } | null {
  const row = BY_ID.get(id);
  if (!row) return null;
  return {
    desk: row.desk,
    key: `desk.layout.${row.desk}`,
    value: { v: 1, exact: true, tiles: row.tiles.map(([key, c, r]) => ({ key, c, r })), hidden: [] },
  };
}
