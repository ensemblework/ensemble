import type { DeskId } from "./desks";
import { deskRole } from "./tile-catalog";
import type { Role } from "../onboarding/roles";

export const PROFILE_CONTEXT: Record<Role, { fixed: string[]; optional: string[] }> = {
  engineer: { fixed: ["Overview", "People", "Projects", "Repos", "Graph"], optional: ["Builds", "Parts", "Tests", "Mocks", "Reviews", "Deploys", "Learning"] },
  student: { fixed: ["Overview", "People", "Projects", "Graph"], optional: ["Assignments", "Courses", "Subjects", "Revision", "Papers", "Learning"] },
  teacher: { fixed: ["Overview", "People", "Projects", "Graph"], optional: ["Classes", "Marking", "Courses", "Learning"] },
  lawyer: { fixed: ["Overview", "People", "Projects", "Graph"], optional: ["Matters", "Hearings", "Filings", "Reading"] },
  manager: { fixed: ["Overview", "People", "Projects", "Graph"], optional: ["Team", "Decisions", "Workload", "Objectives"] },
  vibe: { fixed: ["Overview", "People", "Projects", "Graph"], optional: ["Builds", "Parts", "Tests", "Milestones", "Learning"] },
};
export function tabKey(label: string) { return label.toLowerCase().split(" ")[0] ?? "overview"; }
export function selectedContextTabs(role: Role, value: unknown): string[] {
  const profile = PROFILE_CONTEXT[role];
  const selected = Array.isArray(value) ? profile.optional.filter(label => value.includes(label)) : [];
  return [...profile.fixed.filter(label => label !== "Graph"), ...selected, "Graph"];
}
export function contextTabs(desk: DeskId, _learning = false): string[] { return selectedContextTabs(deskRole(desk), []); }
export const CONTEXT_DESCRIPTIONS: Record<string, string> = {
  Overview: "A view of the people and work you have added to Ensemble. Connections save files only when you ask.",
  People: "People you add, or real contacts found when you choose Sync people. Shops, newsletters and bots are filtered out.",
  Projects: "Your projects and the work linked to each one. Add a project to start connecting tasks, people and files.",
  Repos: "Repositories you have added or explicitly asked Ensemble to find. Add a repository from Today or ask the assistant.",
  Graph: "Explore connections between your people, projects and work. Optional tabs appear here while they are enabled.",
  Builds: "Milestones and completed builds you record. Add a milestone or log a build from Today.",
  Parts: "Parts and stock you record for your builds. Add a part from Today.",
  Tests: "Checks and test results you record. Add a test result from Today.",
  Mocks: "Mock services and test doubles for engineering work. Add a service, endpoint or test double below.",
  Assignments: "Coursework you add as tasks. Add an assignment on your board or in Today.",
  Courses: "Courses and their dated work. Add a course or coursework from Today.",
  Reviews: "Review requests you save or add as tasks. Ask Ensemble to find a review, or add one from Today.",
  Deploys: "Deployments you record. Log a deployment from Today to keep track of what shipped.",
  Subjects: "Subjects and targets you record for study. Add them from Today.",
  Revision: "Your revision plan and recorded practice. Add a revision session from Today.",
  Papers: "Papers and reading you chose to save. Upload a file or ask Ensemble to find a paper.",
  Classes: "Classes and teaching work you record. Add a class from Today.",
  Marking: "Submissions and marking progress you record. Add a marking item from Today.",
  Matters: "Your legal matters and their linked work. Add a matter as a project.",
  Hearings: "Hearings and court dates you record. Add a hearing from Today.",
  Filings: "Filings and drafts you add. Upload a document or add a filing from Today.",
  Reading: "Sources you choose to keep for your work. Upload a file or ask Ensemble to find one.",
  Team: "People and check-ins you record for your team. Add a person or check-in from Today.",
  Decisions: "Decisions and questions you record. Add a decision from Today.",
  Workload: "Your recorded workload and work in progress. Add tasks on your board.",
  Objectives: "Objectives and progress you record. Add an objective from Today.",
  Milestones: "Your next milestones and deadlines. Add a dated task from Today.",
  Learning: "Concepts and learning notes you record. Add a concept from Today.",
};
