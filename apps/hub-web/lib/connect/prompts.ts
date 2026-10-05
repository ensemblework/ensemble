export type AudienceId = "student" | "lawyer" | "researcher" | "engineer";

export const AUDIENCES: Array<{ id: AudienceId; label: string; prompts: string[] }> = [
  {
    id: "student",
    label: "Student",
    prompts: [
      "What do I still need to finish, in the order I should do it?",
      "Who am I meeting this week, and what did we last say about that?",
      "Turn my open tasks into a short study plan for the next three days.",
    ],
  },
  {
    id: "lawyer",
    label: "Lawyer",
    prompts: [
      "What is waiting on me, and which matter is each item tied to?",
      "Find everything we have about this filing, and name the source of each point.",
      "What’s on my calendar before the next deadline, and which tasks are still open?",
    ],
  },
  {
    id: "researcher",
    label: "Researcher",
    prompts: [
      "What did we already decide about the method, and where is that written?",
      "List the people on this project and the last time I worked with each of them.",
      "Search my notes for “control group” and quote the passages you use.",
    ],
  },
  {
    id: "engineer",
    label: "Engineer",
    prompts: [
      "Brief me on this branch: the task, the project, and how I usually write this kind of change.",
      "Which deliverables are due, and what is blocked?",
      "What does this connection not know yet?",
    ],
  },
];
