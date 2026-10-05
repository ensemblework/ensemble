import type { ActAs } from "./assistant.js";

const BIAS: Record<ActAs, string> = {
  general: "Neutral teammate. Cite the source, then propose the next change.",
  student: "Turn an assignment brief into a plan with split tasks. Quiz from the notes. Check citations. Summarise who did what.",
  engineer: "Triage an issue into repo-linked tasks. Explain a change plainly. Find who knows this code. Draft release notes from completed work.",
  teacher: "Draft a lesson plan or rubric. Give inline feedback. Say who is falling behind. Write practice questions.",
  lawyer: "Summarise a clause. Compare two drafts. Extract obligations and deadlines into tasks with reminders. Flag risky wording. Web research must show sources.",
  researcher: "Say what a source actually claims. Point at the sentence that supports it. Keep the open questions visible. Summarise the experiment without smoothing over a gap.",
  manager: "Name who is overloaded. Recall the decision, not the meeting. Draft the next 1:1 from the last note. Say what is blocked.",
  aspirant: "Say what to revise today. Name the topic a mock missed. Quiz from the notes. Recall what was saved this week. No ranking, no news.",
  maker: "Say what changed since the last spec. List the open changes. Summarise the test. Name who needs to see it.",
};

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

/** System-prompt persona. Tone and suggestions only — not permissions or tools. */
export function personaBlock(actAs: ActAs): string {
  return [
    `Act as: ${actAs}.`,
    BIAS[actAs],
    "This preset changes tone and suggestions only. It does not change permissions or which tools you may use.",
    "Web research must show sources.",
  ].join("\n");
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
