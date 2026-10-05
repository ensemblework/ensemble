import type { OnboardingRole } from "./catalog.js";

/** Cards only. Signup must not import starter rows or the widget canvas. */
export type TemplateCard = {
  id: string;
  role: OnboardingRole;
  name: string;
  blurb: string;
  image: string;
  imageLight: string;
};

const cards: Array<[OnboardingRole, string, string, string]> = [
  ["student", "semester-desk", "Semester desk", "Several courses, one desk. The essay, the instructor, and what is due sit on the same graph."],
  ["student", "exam-week", "Exam week", "Seven days, a final, and a reminder the evening before. Nothing else."],
  ["student", "group-project", "Group project", "Names on the work. Who did what is a task with a person, not a spreadsheet."],
  ["student", "reading-pile", "Reading pile", "Notes that should become tasks. The quote lives on the task, not in a second notebook."],
  ["student", "application-season", "Application season", "Many deadlines, little daily class. Due dates already enter focus."],
  ["engineer", "branch-desk", "Branch desk", "Daily driver. The repo tile stays empty until a real repo is connected."],
  ["engineer", "inbox-triage", "Inbox triage", "Proposals first. Accept, hand to an agent, snooze, or drop."],
  ["engineer", "release-desk", "Release desk", "Cut notes from work that is actually done."],
  ["engineer", "on-call-morning", "On-call morning", "What is blocked, then what is due."],
  ["engineer", "partner-work", "Partner work", "People and the last conversation, ahead of the repo."],
  ["vibe", "one-idea", "One idea", "One project, three tasks, a page. Not a portfolio."],
  ["vibe", "weekend-build", "Weekend build", "A date, a demo, then stop."],
  ["vibe", "show-someone", "Show someone", "The work is explaining it, in sentences a friend can follow."],
  ["vibe", "learn-by-shipping", "Learn by shipping", "What broke lives on the task, next to the fix."],
  ["vibe", "keep-it-small", "Keep it small", "For people who hate dashboards. One task. Room around it."],
  ["teacher", "weeks-lessons", "This week's lessons", "Plan, then assign. The lesson page and the worksheet share a project."],
  ["teacher", "check-ins", "Who needs a check-in", "People before content. Placeholder students — rename or delete them."],
  ["teacher", "marking-pile", "Marking pile", "Feedback is the work. The shape of a comment is already on the page."],
  ["teacher", "office-hours", "Office hours", "The calendar is the queue. Notes from last time stay on the project."],
  ["teacher", "course-hub", "Course hub", "Context is the course. People, the reading, and the unit share one project."],
  ["lawyer", "matter-desk", "Matter desk", "One matter, its dates, its people. Rename Client before a sync."],
  ["lawyer", "two-drafts", "Two drafts", "Two pages you will replace with the real clauses."],
  ["lawyer", "deadline-wall", "Deadline wall", "Dates ahead of narrative. Three reminders, one response."],
  ["lawyer", "client-morning", "Client morning", "Who, then what they are waiting on."],
  ["lawyer", "research-trail", "Research trail", "Every claim points at a source. The citation list starts empty on purpose."],
  ["manager", "staff-week", "Staff week", "Who is carrying the week, who you haven't met, and what you already decided."],
];

export const TEMPLATE_CARDS: readonly TemplateCard[] = cards.map(([role, id, name, blurb]) => ({
  id,
  role,
  name,
  blurb,
  image: `/templates/${id}.svg`,
  imageLight: `/templates/${id}-light.svg`,
}));

export function cardsForRole(role: string): TemplateCard[] {
  return TEMPLATE_CARDS.filter((card) => card.role === role);
}
