import { Activity, Bot, CircleCheck, CircleHelp, Clock3, Gauge, Lightbulb, ListTodo, PieChart, Users } from "lucide-react";
import type { InsightId } from "./insight-data";
import type { Role } from "../onboarding/roles";

export const INSIGHT_CATEGORIES = ["All tiles", "Work flow", "Ownership", "Attention"] as const;
export const INSIGHT_CATALOG = {
  flow: { title: "Board progress", category: "Work flow", icon: PieChart, description: "See the balance of planned, active, waiting, and completed work. Select a segment to focus the board." },
  ideas: { title: "Idea inbox", category: "Work flow", icon: Lightbulb, description: "A place for proposed work before you commit to it. Capture an idea as an unassigned proposal, then shape it on the board." },
  ownership: { title: "Who owns what", category: "Ownership", icon: Users, description: "See open work split between you, the agent, teammates, and nobody yet. Select an owner group to find their tasks." },
  agent: { title: "Agent work", category: "Ownership", icon: Bot, description: "Follow agent-owned tasks through planned, active, and waiting states. Counts describe task status, not live execution." },
  "my-work": { title: "On my plate", category: "Ownership", icon: ListTodo, description: "Your open tasks in this workspace. Shared tasks belong to the assigned person, so Me always means you." },
  attention: { title: "Waiting for a next step", category: "Attention", icon: CircleHelp, description: "Bring blocked tasks and tasks awaiting approval into view. Open the task to see the question and who can answer it." },
  stale: { title: "Needs a fresh look", category: "Attention", icon: Clock3, description: "Open work with no updates for seven days or more. This measures time since the last edit, not time in a particular status." },
  deadlines: { title: "Dates to watch", category: "Attention", icon: Activity, description: "Find overdue work and tasks due in the next seven days, before they become a last-minute rush." },
  done: { title: "A week of progress", category: "Work flow", icon: CircleCheck, description: "A seven-day completion chart based on the dates tasks were finished. Open the completed tasks from the tile." },
  capacity: { title: "Work in progress", category: "Work flow", icon: Gauge, description: "Compare active tasks with your board's WIP cap. Keep attention on finishing work before starting more." },
} as const;

export function insightTitle(id: InsightId, role: Role): string {
  if (id === "flow") return { student: "Study progress", teacher: "Teaching workflow", lawyer: "Matter workflow", engineer: "Delivery flow", vibe: "From idea to shipped", manager: "Team progress" }[role];
  if (id === "ideas") return { student: "Ideas to explore", teacher: "Lesson ideas", lawyer: "Work to scope", engineer: "Before the backlog", vibe: "Idea inbox", manager: "Proposals to shape" }[role];
  if (id === "deadlines") return { student: "Assignments ahead", teacher: "Teaching deadlines", lawyer: "Dates to watch", engineer: "Delivery dates", vibe: "Launch dates", manager: "Team deadlines" }[role];
  return INSIGHT_CATALOG[id].title;
}
