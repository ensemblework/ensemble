import type { DeskId } from "./desks";

/** What each desk adds to Context. The shared tabs below are on every desk. */
const LENS_TABS: Record<DeskId, string[]> = {
  default: ["Overview", "People", "Work", "Dates"],
  semester: ["Overview", "Courses", "People", "Deadlines"],
  exam: ["Overview", "Subjects", "Mocks", "Revision"],
  literature: ["Overview", "People", "Papers", "Artifacts & sync", "Graph"],
  chambers: ["Overview", "People", "Matters", "Artifacts & sync", "Graph"],
  classes: ["Overview", "Classes", "People", "Marking"],
  staff: ["Overview", "Team", "Decisions", "Load"],
  branch: ["Overview", "Repos", "Reviews", "Deploys"],
  bench: ["Overview", "Builds", "Parts", "Tests"],
};

export function tabKey(label: string) {
  return label.toLowerCase().split(" ")[0] ?? "overview";
}

/** Every desk gets the people, projects, graph and files. A desk only adds its own tabs between them. */
const SHARED_TABS = new Set(["Overview", "People", "Projects", "Graph", "Artifacts & sync"]);

export function contextTabs(deskId: DeskId, learning = false): string[] {
  const own = LENS_TABS[deskId].filter((label) => !SHARED_TABS.has(label));
  return ["Overview", "People", "Projects", ...own, ...(learning && !own.includes("Learning") ? ["Learning"] : []), "Graph", "Artifacts & sync"];
}

