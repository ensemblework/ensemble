import type { ActAs } from "../assistant.js";
import { type LayoutConfig, type LayoutDocument, type Size, type WidgetId } from "../widgets.js";

export const ONBOARDING_ROLES = ["student", "teacher", "lawyer", "engineer", "vibe", "manager"] as const;
export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

export type StarterTask = {
  slug: string;
  title: string;
  status?: "todo" | "proposed";
  people?: string[];
  page?: string;
  /** Deliverable slug this task produces. */
  deliverable?: string;
};

export type TemplateStarter = {
  project: string;
  summary: string;
  taskType: string;
  tasks: StarterTask[];
  deliverables?: Array<{ slug: string; title: string; dueInDays: number | null }>;
  reminders?: Array<{ slug: string; title: string; dueInDays: number; time?: string }>;
  people?: Array<{ slug: string; name: string; role?: string }>;
  notes?: Array<{ slug: string; title: string; body: string; people?: string[] }>;
  repo?: { slug: string; fullName: string };
  artifacts?: Array<{ slug: string; title: string; kind?: "file" | "pr"; task?: string }>;
};

export type RoleTemplate = {
  id: string;
  role: OnboardingRole;
  name: string;
  blurb: string;
  actAs: ActAs;
  highlights: readonly string[];
  today: LayoutDocument;
  context: LayoutDocument;
  /** Null keeps the board strip off. Reset will not invent one. */
  board: LayoutDocument | null;
  starter: TemplateStarter;
};

const HIGHLIGHTS: Record<OnboardingRole, readonly string[]> = {
  student: ["Split this into tasks", "Quiz me from my notes", "Check the citations", "Summarise who did what"],
  teacher: ["Draft a lesson plan", "Write inline feedback", "Who is falling behind?", "Practice questions"],
  lawyer: ["Summarise the clause", "Extract obligations and deadlines", "Compare the two drafts", "Flag risky wording"],
  engineer: ["Triage this into repo-linked tasks", "Find who knows this code", "Explain this plainly", "Release notes from completed work"],
  vibe: ["Explain this plainly", "Draft the next step", "What is missing before the due date?", "Split this into tasks"],
  manager: ["Who is overloaded?", "What did we decide?", "Draft the 1:1", "What is blocked?"],
};

function layout(rows: Array<[WidgetId, Size]>, config?: LayoutConfig): LayoutDocument {
  return { v: 1, placements: rows.map(([type, size]) => ({ type, size })), ...(config ? { config } : {}) };
}

function template(
  role: OnboardingRole,
  id: string,
  name: string,
  blurb: string,
  today: Array<[WidgetId, Size]>,
  context: Array<[WidgetId, Size]>,
  starter: TemplateStarter,
  board: Array<[WidgetId, Size]> | null = null,
  config?: LayoutConfig,
): RoleTemplate {
  return {
    id,
    role,
    name,
    blurb,
    actAs: role === "vibe" ? "engineer" : role,
    highlights: HIGHLIGHTS[role],
    today: layout(today),
    context: layout(context, config?.graphNodeCap ? { graphNodeCap: config.graphNodeCap } : undefined),
    board: board ? layout(board, config?.wipCap ? { wipCap: config.wipCap } : undefined) : null,
    starter,
  };
}

export const TEMPLATES: readonly RoleTemplate[] = [
  template(
    "student",
    "semester-desk",
    "Semester desk",
    "Several courses, one desk. The essay, the instructor, and what is due sit on the same graph.",
    [["orbit", "m"], ["focus", "l"], ["deliverables", "l"], ["calendar", "m"], ["reminders", "s"]],
    [["people", "m"], ["meetings", "m"], ["artifacts", "l"], ["recent-links", "m"]],
    {
      project: "This semester",
      summary: "Courses in progress. Rename this to the term you are actually in.",
      taskType: "course",
      people: [{ slug: "instructor", name: "Instructor" }],
      tasks: [
        { slug: "read-brief", title: "Read the brief" },
        { slug: "rubric", title: "List what the rubric grades" },
        { slug: "office-hours", title: "Office hours question" },
      ],
      deliverables: [{ slug: "essay", title: "Essay draft", dueInDays: 14 }],
    },
  ),
  template(
    "student",
    "exam-week",
    "Exam week",
    "Seven days, a final, and a reminder the evening before. Nothing else.",
    [["reminders", "l"], ["focus", "l"], ["calendar", "m"], ["deliverables", "m"], ["stale-nudges", "m"]],
    [["artifacts", "m"], ["people", "s"], ["recent-links", "m"]],
    {
      project: "Exam week",
      summary: "The week of the test. Drop this project when the exam is over.",
      taskType: "exam",
      tasks: [
        { slug: "practice-1", title: "Practice set 1" },
        { slug: "practice-2", title: "Practice set 2" },
        {
          slug: "weak-spots",
          title: "One page of weak spots",
          page: "Ten things to ask about\n\n1. The definition I keep mixing up\n2. A problem I got wrong\n3. What the rubric actually grades\n4. A worked example I can redo\n5. The formula I cannot derive\n6. A case I cannot place\n7. The date of the exam\n8. What I may bring in\n9. One question for office hours\n10. The smallest thing I can still learn tonight",
        },
      ],
      deliverables: [{ slug: "final", title: "Final", dueInDays: 5 }],
      reminders: [{ slug: "eve", title: "Exam tomorrow — stop adding topics", dueInDays: 4, time: "18:00" }],
    },
  ),
  template(
    "student",
    "group-project",
    "Group project",
    "Names on the work. Who did what is a task with a person, not a spreadsheet.",
    [["focus", "m"], ["proposals", "m"], ["people", "l"], ["meeting-cues", "m"]],
    [["people", "l"], ["graph", "l"], ["meetings", "m"], ["recent-links", "m"]],
    {
      project: "Group project",
      summary: "Shared work. Replace the placeholder names before you rely on them.",
      taskType: "group",
      people: [
        { slug: "teammate", name: "Teammate" },
        { slug: "instructor", name: "Instructor" },
      ],
      tasks: [
        {
          slug: "outline",
          title: "Agree the outline",
          people: ["Teammate"],
          page: "Who did what\n\nOutline owner: me\nSection A: Teammate\nSection B: me\nReview: Instructor\n\nReplace these lines when the work is real.",
        },
        { slug: "my-section", title: "My section", people: ["Teammate"] },
        { slug: "their-section", title: "Their section", people: ["Teammate"] },
      ],
    },
  ),
  template(
    "student",
    "reading-pile",
    "Reading pile",
    "Notes that should become tasks. The quote lives on the task, not in a second notebook.",
    [["focus", "l"], ["reminders", "s"], ["deliverables", "s"]],
    [["artifacts", "l"], ["recent-links", "m"], ["people", "s"], ["graph", "m"]],
    {
      project: "Reading",
      summary: "Sources you still owe a note.",
      taskType: "reading",
      tasks: [
        { slug: "source-a", title: "Source A notes", page: "Claim\n\nQuote\n\nPage" },
        { slug: "source-b", title: "Source B notes", page: "Claim\n\nQuote\n\nPage" },
      ],
      deliverables: [{ slug: "bib", title: "Annotated bibliography", dueInDays: 21 }],
    },
  ),
  template(
    "student",
    "application-season",
    "Application season",
    "Many deadlines, little daily class. Due dates already enter focus.",
    [["deliverables", "xl"], ["calendar", "m"], ["reminders", "m"], ["focus", "m"]],
    [["people", "m"], ["artifacts", "m"], ["meetings", "s"], ["recent-links", "m"]],
    {
      project: "Applications",
      summary: "Forms, writing, and the person you asked for a letter.",
      taskType: "application",
      people: [{ slug: "referee", name: "Referee" }],
      tasks: [
        { slug: "ask", title: "Ask for the recommendation", people: ["Referee"] },
        { slug: "short", title: "Draft the short answer" },
      ],
      deliverables: [
        { slug: "form", title: "Form", dueInDays: 10 },
        { slug: "sample", title: "Writing sample", dueInDays: 18 },
        { slug: "letter", title: "Recommendation", dueInDays: 25 },
      ],
    },
  ),
  template(
    "engineer",
    "branch-desk",
    "Branch desk",
    "Daily driver. The repo tile stays empty until a real repo is connected.",
    [["focus", "l"], ["proposals", "m"], ["calendar", "m"], ["needs-me", "s"], ["repos", "m"]],
    [["repos", "l"], ["people", "m"], ["graph", "l"], ["recent-links", "m"]],
    {
      project: "Current work",
      summary: "The branch you are on. No fake repository is created.",
      taskType: "branch",
      tasks: [
        { slug: "review", title: "Open the review" },
        { slug: "test", title: "Write the test" },
        { slug: "notes", title: "Update the notes" },
      ],
    },
    [
      ["column-summary", "s"],
      ["wip", "m"],
      ["blocked", "m"],
    ],
    { wipCap: 3 },
  ),
  template(
    "engineer",
    "inbox-triage",
    "Inbox triage",
    "Proposals first. Accept, hand to an agent, snooze, or drop.",
    [["proposals", "l"], ["focus", "m"], ["people", "s"], ["needs-me", "s"]],
    [["people", "m"], ["artifacts", "m"], ["recent-links", "m"], ["meetings", "s"]],
    {
      project: "Inbox",
      summary: "Things that might be tasks. Decide them.",
      taskType: "triage",
      tasks: [
        { slug: "mail", title: "Mail that might be a task", status: "proposed" },
        { slug: "question", title: "A question to accept or drop", status: "proposed" },
      ],
    },
  ),
  template(
    "engineer",
    "release-desk",
    "Release desk",
    "Cut notes from work that is actually done.",
    [["deliverables", "l"], ["focus", "m"], ["reminders", "m"], ["calendar", "s"]],
    [["repos", "m"], ["artifacts", "m"], ["people", "s"], ["recent-links", "m"]],
    {
      project: "Release",
      summary: "What ships, and the note that says so.",
      taskType: "release",
      tasks: [
        { slug: "changed", title: "List what changed" },
        { slug: "notes", title: "Write the notes" },
        { slug: "review", title: "Ask for review" },
      ],
      deliverables: [{ slug: "ship", title: "Ship", dueInDays: 7 }],
    },
    [
      ["week-done", "m"],
      ["column-summary", "s"],
    ],
  ),
  template(
    "engineer",
    "on-call-morning",
    "On-call morning",
    "What is blocked, then what is due.",
    [["focus", "l"], ["reminders", "s"], ["calendar", "m"], ["people", "m"], ["stale-nudges", "m"]],
    [["people", "l"], ["meetings", "m"], ["graph", "m"], ["repos", "s"]],
    {
      project: "On call",
      summary: "The morning page. Blocked work stays visible on the board strip.",
      taskType: "oncall",
      people: [{ slug: "teammate", name: "Teammate" }],
      tasks: [
        { slug: "blocked", title: "Check what is blocked", people: ["Teammate"] },
        { slug: "reply", title: "Reply to the page" },
      ],
    },
    [
      ["blocked", "m"],
      ["wip", "m"],
      ["column-summary", "s"],
    ],
    { wipCap: 3 },
  ),
  template(
    "engineer",
    "partner-work",
    "Partner work",
    "People and the last conversation, ahead of the repo.",
    [["people", "l"], ["meeting-cues", "m"], ["focus", "m"], ["calendar", "s"]],
    [["meetings", "l"], ["people", "m"], ["artifacts", "m"], ["graph", "m"]],
    {
      project: "Partner",
      summary: "A person and a conversation. Rename Partner when you know who.",
      taskType: "partner",
      people: [{ slug: "partner", name: "Partner" }],
      tasks: [
        { slug: "recap", title: "Send the recap", people: ["Partner"] },
        { slug: "next", title: "Next question", people: ["Partner"] },
      ],
      notes: [{ slug: "last", title: "Last conversation", body: "What they asked\n\nWhat we said\n\nWhat is still open" }],
    },
  ),
  template(
    "vibe",
    "one-idea",
    "One idea",
    "One project, three tasks, a page. Not a portfolio.",
    [["focus", "xl"], ["calendar", "s"], ["reminders", "s"]],
    [["artifacts", "m"], ["recent-links", "m"], ["people", "s"]],
    {
      project: "The idea",
      summary: "The thing you are making. Keep it to one.",
      taskType: "idea",
      tasks: [
        {
          slug: "describe",
          title: "Describe it in five lines",
          page: "What it is\n\nProblem\n\nWho it is for\n\nThe smallest demo",
        },
        { slug: "demo", title: "Build the smallest demo" },
        { slug: "show", title: "Show it to one person" },
      ],
      deliverables: [{ slug: "demo", title: "Demo", dueInDays: 10 }],
    },
  ),
  template(
    "vibe",
    "weekend-build",
    "Weekend build",
    "A date, a demo, then stop.",
    [["focus", "l"], ["deliverables", "m"], ["reminders", "m"], ["calendar", "s"]],
    [["artifacts", "m"], ["recent-links", "s"]],
    {
      project: "Weekend",
      summary: "Scope you can finish before Monday.",
      taskType: "weekend",
      tasks: [
        { slug: "cut", title: "Cut scope" },
        { slug: "build", title: "Build" },
        { slug: "stop", title: "Stop" },
      ],
      deliverables: [{ slug: "demo", title: "Demo", dueInDays: 3 }],
      reminders: [{ slug: "sunday", title: "Stop and show what runs", dueInDays: 2, time: "18:00" }],
    },
  ),
  template(
    "vibe",
    "show-someone",
    "Show someone",
    "The work is explaining it, in sentences a friend can follow.",
    [["focus", "l"], ["people", "m"], ["calendar", "m"]],
    [["people", "m"], ["artifacts", "l"], ["recent-links", "m"]],
    {
      project: "Show and tell",
      summary: "A person who will look at it, and the path you will walk them through.",
      taskType: "demo",
      people: [{ slug: "friend", name: "Friend" }],
      tasks: [
        { slug: "path", title: "Record the path" },
        {
          slug: "plain",
          title: "Write what it does",
          people: ["Friend"],
          page: "Script\n\nWhat you open first.\n\nWhat you click.\n\nWhat it is supposed to do, in one sentence.\n\nWhat you will not apologise for.",
        },
        { slug: "send", title: "Send the link", people: ["Friend"] },
      ],
    },
  ),
  template(
    "vibe",
    "learn-by-shipping",
    "Learn by shipping",
    "What broke lives on the task, next to the fix.",
    [["focus", "xl"], ["reminders", "s"]],
    [["artifacts", "m"], ["graph", "m"], ["recent-links", "m"]],
    {
      project: "Learning",
      summary: "Make it run, then write down the part you do not understand.",
      taskType: "learn",
      tasks: [
        { slug: "run", title: "Make it run" },
        { slug: "broke", title: "Write down what broke", page: "What I don't understand yet\n\nThe error\n\nWhat I tried\n\nWhat I will ask next" },
      ],
    },
  ),
  template(
    "vibe",
    "keep-it-small",
    "Keep it small",
    "For people who hate dashboards. One task. Room around it.",
    [["focus", "m"], ["reminders", "s"], ["deliverables", "s"]],
    [["recent-links", "m"]],
    {
      project: "Now",
      summary: "The next hour.",
      taskType: "now",
      tasks: [{ slug: "hour", title: "The next hour" }],
      deliverables: [{ slug: "open", title: "When it is done", dueInDays: null }],
    },
    null,
  ),
  template(
    "teacher",
    "weeks-lessons",
    "This week's lessons",
    "Plan, then assign. The lesson page and the worksheet share a project.",
    [["calendar", "l"], ["deliverables", "l"], ["focus", "m"], ["reminders", "s"]],
    [["meetings", "m"], ["artifacts", "m"], ["people", "m"], ["recent-links", "m"]],
    {
      project: "This week",
      summary: "The lessons you will actually teach.",
      taskType: "lesson",
      tasks: [
        { slug: "draft", title: "Draft the lesson", page: "Aim\n\nSteps\n\nCheck" },
        { slug: "questions", title: "Write five questions" },
        { slug: "post", title: "Print or post" },
      ],
      deliverables: [{ slug: "sheet", title: "Worksheet", dueInDays: 4 }],
    },
  ),
  template(
    "teacher",
    "check-ins",
    "Who needs a check-in",
    "People before content. Placeholder students — rename or delete them.",
    [["people", "l"], ["focus", "m"], ["calendar", "m"]],
    [["people", "l"], ["graph", "l"], ["meetings", "m"]],
    {
      project: "Check-ins",
      summary: "Who you still need to talk to.",
      taskType: "checkin",
      people: [
        { slug: "student-a", name: "Student A" },
        { slug: "student-b", name: "Student B" },
      ],
      tasks: [
        { slug: "a", title: "Check in with A", people: ["Student A"] },
        { slug: "b", title: "Check in with B", people: ["Student B"] },
      ],
    },
  ),
  template(
    "teacher",
    "marking-pile",
    "Marking pile",
    "Feedback is the work. The shape of a comment is already on the page.",
    [["focus", "l"], ["reminders", "m"], ["deliverables", "m"]],
    [["artifacts", "l"], ["people", "m"], ["recent-links", "m"]],
    {
      project: "Marking",
      summary: "Sets still waiting for a comment.",
      taskType: "marking",
      tasks: [
        { slug: "set-1", title: "Mark set 1" },
        { slug: "comments", title: "Write the comments", page: "What worked\n\nWhat next" },
        { slug: "return", title: "Return them" },
      ],
    },
  ),
  template(
    "teacher",
    "office-hours",
    "Office hours",
    "The calendar is the queue. Notes from last time stay on the project.",
    [["calendar", "l"], ["people", "m"], ["reminders", "s"], ["focus", "m"], ["meeting-cues", "m"]],
    [["meetings", "l"], ["people", "m"], ["recent-links", "s"]],
    {
      project: "Office hours",
      summary: "Questions you still owe an example.",
      taskType: "hours",
      tasks: [
        { slug: "prep", title: "Prep the example" },
        { slug: "follow", title: "Follow up" },
      ],
      notes: [{ slug: "last", title: "Questions from last time", body: "Question\n\nWhat I said\n\nWhat I still owe" }],
    },
  ),
  template(
    "teacher",
    "course-hub",
    "Course hub",
    "Context is the course. People, the reading, and the unit share one project.",
    [["focus", "m"], ["deliverables", "m"], ["calendar", "m"], ["people", "s"]],
    [["people", "l"], ["artifacts", "l"], ["graph", "m"], ["meetings", "m"]],
    {
      project: "Course",
      summary: "The unit you are teaching. Add the real cohort when you have names.",
      taskType: "course",
      people: [
        { slug: "student-a", name: "Student A" },
        { slug: "student-b", name: "Student B" },
      ],
      tasks: [
        { slug: "reading", title: "Post the reading" },
        { slug: "discussion", title: "Open the discussion" },
      ],
      deliverables: [{ slug: "unit", title: "End of unit", dueInDays: 28 }],
    },
  ),
  template(
    "lawyer",
    "matter-desk",
    "Matter desk",
    "One matter, its dates, and the people on the record.",
    [["deliverables", "l"], ["reminders", "l"], ["focus", "m"], ["people", "m"]],
    [["people", "m"], ["artifacts", "l"], ["meetings", "m"], ["recent-links", "m"]],
    {
      project: "Rao v. Sunrise Hospital",
      summary: "Pleadings, the limitation date, and who is on the record.",
      taskType: "matter",
      people: [
        { slug: "rao", name: "Sunita Rao", role: "Client" },
        { slug: "sen", name: "Adv. Kavita Sen", role: "Senior counsel" },
        { slug: "yadav", name: "Suresh Yadav", role: "Clerk · filings" },
      ],
      tasks: [
        { slug: "read", title: "Read the draft", page: "Facts\n\nDates\n\nOpen questions", people: ["Sunita Rao"] },
        { slug: "dates", title: "List the dates", people: ["Suresh Yadav"] },
        { slug: "question", title: "Send the question", people: ["Adv. Kavita Sen"], deliverable: "filing" },
      ],
      deliverables: [{ slug: "filing", title: "Filing", dueInDays: 12 }],
      reminders: [{ slug: "filing", title: "Filing date", dueInDays: 12, time: "09:00" }],
      notes: [{ slug: "conference", title: "Conference with Sunita Rao", body: "Limitation, the draft, and what we still owe.", people: ["Sunita Rao"] }],
      repo: { slug: "briefs", fullName: "chambers/rao-sunrise" },
      artifacts: [
        { slug: "order", title: "HC order dt. 8 Jul 2026 · certified copy.pdf", kind: "file", task: "read" },
        { slug: "pr", title: "rao-sunrise #12 · vakalatnama", kind: "pr", task: "question" },
      ],
    },
  ),
  template(
    "lawyer",
    "two-drafts",
    "Two drafts",
    "Two pages you will replace with the real clauses.",
    [["focus", "m"], ["reminders", "s"], ["deliverables", "s"]],
    [["artifacts", "l"], ["recent-links", "m"], ["people", "s"], ["graph", "m"]],
    {
      project: "Drafts",
      summary: "A comparison, not a folder of files.",
      taskType: "draft",
      tasks: [
        { slug: "draft-a", title: "Draft A", page: "Sample clause — replace this\n\nThe party shall …" },
        { slug: "draft-b", title: "Draft B", page: "Sample clause — replace this\n\nThe party may …" },
      ],
    },
  ),
  template(
    "lawyer",
    "deadline-wall",
    "Deadline wall",
    "Dates ahead of narrative. Three reminders, one response.",
    [["reminders", "xl"], ["calendar", "m"], ["deliverables", "m"], ["stale-nudges", "m"]],
    [["meetings", "m"], ["artifacts", "m"], ["people", "s"], ["recent-links", "m"]],
    {
      project: "Deadlines",
      summary: "Dates you cannot miss.",
      taskType: "deadline",
      tasks: [{ slug: "confirm", title: "Confirm the date" }],
      deliverables: [{ slug: "response", title: "Response due", dueInDays: 9 }],
      reminders: [
        { slug: "d1", title: "First date", dueInDays: 2, time: "09:00" },
        { slug: "d2", title: "Second date", dueInDays: 5, time: "09:00" },
        { slug: "d3", title: "Response reminder", dueInDays: 8, time: "09:00" },
      ],
    },
  ),
  template(
    "lawyer",
    "client-morning",
    "Client morning",
    "Who, then what they are waiting on.",
    [["people", "m"], ["focus", "l"], ["calendar", "m"], ["meeting-cues", "s"]],
    [["meetings", "l"], ["people", "m"], ["artifacts", "m"], ["recent-links", "s"]],
    {
      project: "Client work",
      summary: "The client is a person on the graph, not a URL.",
      taskType: "client",
      people: [{ slug: "client", name: "Client" }],
      tasks: [
        { slug: "answer", title: "Answer the question", people: ["Client"] },
        { slug: "summary", title: "Send the summary", people: ["Client"] },
      ],
      notes: [{ slug: "call", title: "Last call", body: "What they asked\n\nWhat we promised\n\nDate" }],
    },
  ),
  template(
    "lawyer",
    "research-trail",
    "Research trail",
    "Every claim points at a source. The citation list starts empty on purpose.",
    [["focus", "l"], ["reminders", "s"]],
    [["artifacts", "l"], ["graph", "l"], ["recent-links", "m"], ["people", "s"]],
    {
      project: "Research",
      summary: "A clause and the source it came from.",
      taskType: "research",
      tasks: [
        { slug: "clause", title: "Pull the clause" },
        { slug: "source", title: "Note the source", page: "Citations\n\n1.\n2.\n3." },
      ],
    },
  ),
  template(
    "manager",
    "staff-week",
    "Staff week",
    "Who is carrying the week, who you haven't met, and what you already decided.",
    [["one-on-ones", "m"], ["person-load", "m"], ["incident-now", "m"], ["calendar", "m"]],
    [["people", "m"], ["decisions", "m"], ["okr-strip", "m"], ["meetings", "m"]],
    {
      project: "Team",
      summary: "The people, and the decision.",
      taskType: "decision",
      people: [
        { slug: "teammate", name: "Teammate" },
        { slug: "asha", name: "Asha Rao" },
      ],
      tasks: [
        { slug: "one-on-one", title: "1:1 notes" },
        { slug: "ship-date", title: "Decision: ship date" },
      ],
      deliverables: [{ slug: "objective", title: "Objective", dueInDays: 30 }],
    },
  ),
];

const BY_ID = new Map(TEMPLATES.map((row) => [row.id, row]));

export function templateById(id: string): RoleTemplate | undefined {
  return BY_ID.get(id);
}

export function templatesForRole(role: string): RoleTemplate[] {
  return TEMPLATES.filter((row) => row.role === role);
}

export function isOnboardingRole(value: string): value is OnboardingRole {
  return (ONBOARDING_ROLES as readonly string[]).includes(value);
}

/**
 * The desk a new account lands on. The starters stay; this only chooses the bento.
 * Student splits into Semester or Exam season. Reading pile is the research desk.
 * Vibe coder is the non-dev engineer, so it lands on Bench. Unknown ids use Default.
 */
const SIGNUP_DESK: Record<string, string> = {
  "semester-desk": "mkt.semester-desk",
  "group-project": "mkt.semester-desk",
  "exam-week": "mkt.exam-season",
  "application-season": "mkt.exam-season",
  "reading-pile": "mkt.literature-desk",
  "matter-desk": "mkt.chambers",
  "two-drafts": "mkt.chambers",
  "deadline-wall": "mkt.chambers",
  "client-morning": "mkt.chambers",
  "research-trail": "mkt.chambers",
  "weeks-lessons": "mkt.classes",
  "check-ins": "mkt.classes",
  "marking-pile": "mkt.classes",
  "office-hours": "mkt.classes",
  "course-hub": "mkt.classes",
  "branch-desk": "mkt.branch-desk",
  "inbox-triage": "mkt.branch-desk",
  "release-desk": "mkt.branch-desk",
  "on-call-morning": "mkt.branch-desk",
  "partner-work": "mkt.branch-desk",
  "one-idea": "mkt.bench",
  "weekend-build": "mkt.bench",
  "show-someone": "mkt.bench",
  "learn-by-shipping": "mkt.bench",
  "keep-it-small": "mkt.bench",
  "staff-week": "mkt.staff-week",
};

export function signupDeskId(templateId: string): string {
  return SIGNUP_DESK[templateId] ?? "default";
}
