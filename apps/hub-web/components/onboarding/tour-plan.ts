import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { hasModule } from "@ensemble/shared-types/modules";
import type { Role } from "./roles";

export type TourStep = {
  id: string;
  label: string;
  title: string;
  body: string;
  duration: number;
  tip?: string;
  icon: "today" | "arrange" | "board" | "pages" | "context" | "files" | "code" | "meetings" | "connections" | "assistant" | "approvals";
};

const STORIES: Record<Role | "general", { page: string; project: string; person: string; work: string; subject: string; message: string }> = {
  student: { page: "Research presentation plan", project: "Climate research", person: "Lena Ortiz", work: "prepare the presentation outline", subject: "Our presentation outline", message: "The research outline is ready for your feedback. Can we review the sources together before class?" },
  teacher: { page: "Next week's lesson plan", project: "Science unit", person: "Daniel Park", work: "prepare the next lesson", subject: "Science lesson resources", message: "The lesson resources are ready to review. Could you check the group activity before we share it with the class?" },
  lawyer: { page: "Matter review notes", project: "Cedar agreement", person: "Priya Shah", work: "review the agreement draft", subject: "Agreement review", message: "The draft review is ready. Please check the open points before we share the revised agreement." },
  engineer: { page: "Release review plan", project: "Fieldnote release", person: "Daniel Park", work: "review the release checklist", subject: "Release review", message: "The release checklist is ready for review. Please check the remaining items before we schedule the release." },
  vibe: { page: "First release plan", project: "Fieldnote launch", person: "Lena Ortiz", work: "prepare the launch checklist", subject: "First release checklist", message: "The launch checklist is ready. Can you review the first experience before we share it with our testers?" },
  manager: { page: "Team check-in plan", project: "Quarterly priorities", person: "Priya Shah", work: "prepare the team update", subject: "Team priorities update", message: "The team update is ready for review. Please check the priorities before we share it with everyone." },
  general: { page: "Project follow-up plan", project: "Fieldnote project", person: "Daniel Park", work: "prepare the project update", subject: "Project update", message: "The project update is ready for review. Please check the next steps before we share it." },
};

const PROFILE: Record<Role | "general", { line: string; today: string; board: string; context: string; prompt: string }> = {
  student: { line: "A little more clarity for classes, deadlines, and everything you're learning.", today: "See coursework, reading, and upcoming deadlines together. Start here when you're deciding what to study next.", board: "Turn an assignment into smaller tasks. Move work from To do to Done, and give group members a clear next step.", context: "Keep courses, collaborators, and sources connected. Open a person or project to see the work around them.", prompt: "Help me turn my next assignment into a study plan." },
  teacher: { line: "Room for lessons, marking, and the people you're helping learn.", today: "Bring lesson planning, marking, and check-ins into one view. Your chosen tiles keep the next teaching day in sight.", board: "Break a lesson or marking session into tasks, set dates, and see what is ready for the classroom.", context: "Connect classes, colleagues, and teaching projects. See the notes and tasks that belong together.", prompt: "Help me draft a lesson plan from my teaching notes." },
  lawyer: { line: "A clearer view of matters, drafts, and dates that need your attention.", today: "See upcoming dates, open drafts, and matter-related work together. Your desk is a starting point for the day.", board: "Give each draft, review, and follow-up its own task. Set a deadline and track it through to completion.", context: "Connect people, matters, and source material so you can follow the trail behind a task or decision.", prompt: "Help me extract obligations and deadlines from a document." },
  engineer: { line: "One place to move from an idea to reviewed, finished work.", today: "Keep reviews, releases, and upcoming work in view. Your desk brings the next useful action closer.", board: "Turn a bug or feature into a task, link its context, and track progress. Assign eligible work to an agent when you're ready.", context: "Connect projects, repositories, and the people who know them. Follow a task back to the context it needs.", prompt: "Help me split my next feature into clear implementation tasks." },
  vibe: { line: "A home for your ideas, your next build, and the steps in between.", today: "Keep your next build, open ideas, and dates together. Your tiles help you choose what to ship next.", board: "Break an idea into a few achievable tasks. Track each step, and hand eligible implementation work to an agent.", context: "Keep your project, useful sources, and collaborators close. Give the assistant the context behind your next idea.", prompt: "Help me turn my project idea into a small first release." },
  manager: { line: "A shared picture of priorities, people, and the next conversation.", today: "See team priorities, dates, and follow-ups together. Start with what needs attention before your next check-in.", board: "Give work a clear owner and next step. Track progress, spot waiting tasks, and plan the team's next priorities.", context: "See the people and projects behind the work. Keep decisions and follow-ups connected to the right conversation.", prompt: "Help me prepare a team check-in from our open tasks." },
  general: { line: "Your work, its context, and a helpful next step—all in one place.", today: "Bring tasks, dates, and useful context into one view. Start here when you're deciding what to work on next.", board: "Break work into tasks, set priorities and dates, and move each task through to completion.", context: "Connect people, projects, and sources. Follow a task back to the work and conversations around it.", prompt: "Help me choose my next steps from my open tasks." },
};

export function tourProfile(templateId?: string | null, modules?: string | null) {
  const template = TEMPLATE_CARDS.find((card) => card.id === templateId);
  const role = (template?.role ?? "general") as Role | "general";
  return { template, role, codeEnabled: hasModule(modules, "code"), ...PROFILE[role], story: STORIES[role] };
}

/** The walkthrough uses fictional scenes for features available to this profile. */
export function buildTour(templateId?: string | null, modules?: string | null): TourStep[] {
  const profile = tourProfile(templateId, modules);
  const steps: Omit<TourStep, "duration">[] = [
    { id: "welcome", label: "Your space", title: "Make yourself at home", body: profile.line, icon: "today" },
    { id: "today", label: "Your daily starting point", title: "A day with a little more direction", body: profile.today, tip: profile.template ? `You picked ${profile.template.name}. These are your starting tiles.` : "Your tiles show your own work as you add it.", icon: "today" },
    { id: "arrange", label: "Make it yours", title: "Add a view that helps you", body: "Open Add a tile, preview a view suited to your work, and add it to Today. Your tile uses your own data when you leave the preview.", tip: "The tile library is tailored to your chosen profile.", icon: "arrange" },
    { id: "board", label: "From idea to done", title: "Give the next step a place", body: profile.board, tip: "Open a task for its notes, dates, attachments, and assignment options.", icon: "board" },
    { id: "pages", label: "Capture the next step", title: "A page with people, a project, and a date", body: `Create ${profile.story.page.toLowerCase()}. Mention ${profile.story.person}, the project, and tomorrow. Add the page to the board and set its due date to turn the note into tracked work.`, tip: "Mentions save references. Task properties set the owner and due date.", icon: "pages" },
    { id: "context", label: "The bigger picture", title: "Work makes more sense in context", body: `The page you added to the board now appears as a task in Context. Its saved people and project mentions connect it to ${profile.story.person} and ${profile.story.project}. Open those links to follow the work.`, tip: "Graph connections come from saved relationships and mentions.", icon: "context" },
  ];
  if (["engineer", "vibe"].includes(profile.role) && hasModule(modules, "code")) {
    steps.push({ id: "code", label: "Build and review", title: "Keep a close eye on what changes", body: "Code brings repositories and change reviews together. To run an agent against local files, connect your computer with the Ensemble app or CLI first.", tip: "The web app can coordinate work; your connected computer runs it.", icon: "code" });
  } else if (profile.role === "manager") {
    steps.push({ id: "meetings", label: "Keep the conversation", title: "A meeting can lead to a clear next step", body: "Capture meeting notes, decisions, and follow-ups. Keep them alongside the people and projects you talked about.", tip: "Try a note for your next 1:1 or team check-in.", icon: "meetings" });
  } else {
    steps.push({ id: "files", label: "Bring your material", title: "Give your sources a home", body: profile.role === "lawyer" ? "Upload drafts and reference documents, preview them, and attach relevant files to your pages. Keep a source close to the work it supports." : profile.role === "teacher" ? "Upload lesson resources, handouts, and reference material. Preview files and attach them to pages so the source stays close to your notes." : "Upload notes, readings, and reference material. Preview files and attach them to pages so the source stays close to your work.", tip: "PDFs, documents, spreadsheets, and slides each have a preview.", icon: "files" });
  }
  steps.push(
    { id: "approvals", label: "You're in control", title: "Know when the next move is yours", body: "Needs me gathers pending approvals and questions. When an agent needs a decision, review it here before the work continues.", tip: "Take a moment to read what is being requested before you approve.", icon: "approvals" },
    { id: "connections", label: "Bring work together", title: "Connect the apps you already use", body: "Choose a connected app to bring relevant work into Ensemble. Each connection explains its setup and what it can read or do.", tip: "Account settings also holds your profile, appearance, spaces, and shortcuts.", icon: "connections" },
    { id: "assistant", label: "A little help along the way", title: "Start with a question", body: "Open the floating Ensemble button to talk through your work. Ask for a plan, a summary, or a draft. Proposed changes are held for you to apply.", tip: profile.prompt, icon: "assistant" },
    { id: "finish", label: "Ready when you are", title: "This space is yours now", body: "Start with one real task or a useful source. You can replay this preview from your account menu anytime.", tip: profile.prompt, icon: "assistant" },
  );
  const seconds: Record<string, number> = { welcome: 5, today: 6, arrange: 5, board: 5, pages: 8, context: 6, code: 6, files: 6, meetings: 6, approvals: 10, connections: 7, assistant: 10, finish: 5 };
  return steps.map((step) => ({ ...step, duration: seconds[step.id]! * 1000 }));
}

export function canAutoStartTour(path: string, status?: string) {
  if (path === "/start" || path.startsWith("/spaces/new") || path === "/welcome") return false;
  return status === "active" || (status === "ready" && path === "/today");
}
