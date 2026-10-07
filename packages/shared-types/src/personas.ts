import type { ActAs } from "./assistant.js";

/** What the person does, as a sentence fragment after their name. General has none. */
const WORK: Record<ActAs, string | null> = {
  general: null,
  student: "is a student",
  engineer: "works as an engineer",
  teacher: "works as a teacher",
  lawyer: "works as a lawyer",
  researcher: "works as a researcher",
  manager: "manages a team",
  aspirant: "is preparing for an exam",
  maker: "builds products",
};

/** What that kind of work usually asks of the assistant. Tone and emphasis only. */
const WANTS: Record<ActAs, string> = {
  general:
    "They have not said what kind of work they do, so take the shape of the work from the request. Cite the source, then suggest the next change.",
  student:
    "an assignment brief turned into a plan with split tasks, quizzes from their notes, citations checked, and a summary of who did what. If teammates are not in People, ask who they are.",
  engineer:
    "an issue triaged into repo-linked tasks, a change explained plainly, the person who knows this code, and release notes drafted from completed work. On a task, summarise the open page and its repo and draft subtasks as proposed todos.",
  teacher: "a lesson plan or rubric drafted, inline feedback, to know who is falling behind, practice questions, and reminders for due dates.",
  lawyer:
    "a clause summarised, two drafts compared, obligations and deadlines pulled into tasks with reminders, and risky wording flagged. Say where you are unsure, and never invent a citation.",
  researcher:
    "to know what a source actually claims and the sentence that supports it, with the open questions kept visible and experiments summarised without smoothing over a gap.",
  manager: "to know who is overloaded and what is blocked, the decision rather than the meeting, and the next 1:1 drafted from the last note.",
  aspirant: "to know what to revise today and which topic a mock missed, quizzes from their notes, and what they saved this week. No rankings and no news.",
  maker: "to know what changed since the last spec, the open changes, a summary of the test, and who needs to see it.",
};

/** Onboarding roles (users.onboarding_role) that imply a persona when Act as is left on general. */
const ROLE_PERSONA = new Map<string, ActAs>([
  ["student", "student"],
  ["teacher", "teacher"],
  ["lawyer", "lawyer"],
  ["engineer", "engineer"],
  ["vibe", "engineer"],
  ["manager", "manager"],
  ["researcher", "researcher"],
]);

const PRESET_ACTIONS: Record<ActAs, string[]> = {
  general: ["Summarise this", "Draft the next step"],
  student: ["Split this into tasks", "Quiz me from my notes", "Check the citations", "Summarise who did what"],
  engineer: ["Find who knows this code", "Explain this plainly", "Triage this into repo-linked tasks", "Release notes from completed work"],
  teacher: ["Draft a lesson plan", "Write inline feedback", "Who is falling behind?", "Practice questions"],
  lawyer: ["Summarise the clause", "Extract obligations and deadlines", "Compare the two drafts", "Flag risky wording"],
  researcher: ["What does this source actually say?", "Where is this claim supported?", "What is still open?", "Summarise the experiment"],
  manager: ["Who is overloaded?", "What did we decide?", "Draft the 1:1", "What is blocked?"],
  aspirant: ["What should I revise today?", "Which topic did the mock miss?", "Quiz me on this", "What did I save this week?"],
  maker: ["What changed since the last spec?", "List the open changes", "Summarise the test", "Who needs to see this?"],
};

const SURFACE_ACTIONS: Record<string, string[]> = {
  board: ["Split the selection into subtasks", "Who is blocked, and by whom?", "Rebalance owners"],
  today: ["Plan my afternoon around the 4pm deadline"],
  needs_me: ["Draft replies for these three"],
  graph: ["Who has worked on this?", "How are these connected?", "What is at risk this week?"],
  code: ["Explain this line", "Find the bug", "Write the test", "Create a linked task"],
  deliverable: [
    "Check this against the brief",
    "What is missing before the due date?",
    "Turn the feedback into tasks",
    "Tell me when all tasks under this deliverable are done",
  ],
  trash: ["What did we finish last month?"],
  completed: ["What did we finish last month?"],
};

/** The persona to use: an explicit Act as wins; on general, the onboarding role decides. */
export function personaFor(actAs: ActAs | null | undefined, onboardingRole?: string | null): ActAs {
  if (actAs && actAs !== "general") return actAs;
  return ROLE_PERSONA.get((onboardingRole ?? "").trim().toLowerCase()) ?? "general";
}

/**
 * A few sentences about the person for the system prompt, e.g. "Mira works as a
 * lawyer; they usually want …". Tone and emphasis only: tools and permissions
 * are decided in code, so the text does not mention them.
 */
export function personaBlock(actAs: ActAs, name?: string | null): string {
  const who = name?.trim().split(/\s+/)[0] || "The person";
  const work = WORK[actAs];
  const about = work ? `${who} ${work}; they usually want ${WANTS[actAs]}` : WANTS.general;
  return `${about} Web research must show sources.`;
}

/** Suggested prompts for one surface. The preset adds its own; neither list changes tools. */
export function quickActions(actAs: ActAs, surface: string, highlights?: readonly string[]): string[] {
  const surfaceActions = SURFACE_ACTIONS[surface] ?? [];
  const preset = PRESET_ACTIONS[actAs] ?? PRESET_ACTIONS.general;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (line: string | undefined) => {
    if (!line || seen.has(line) || out.length >= 4) return;
    seen.add(line);
    out.push(line);
  };
  if (highlights?.length && (surface === "today" || surface === "graph")) {
    for (const line of highlights) add(line);
  }
  add(surfaceActions[0]);
  add(preset[0]);
  add(surfaceActions[1]);
  add(preset[1]);
  for (const line of [...surfaceActions, ...preset]) add(line);
  return out;
}
