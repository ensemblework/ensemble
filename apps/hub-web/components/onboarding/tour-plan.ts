import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { hasModule } from "@ensemble/shared-types/modules";
import type { Role } from "./roles";

export type TourStep = {
  id: string;
  label: string;
  title: string;
  body: string;
  tip?: string;
  icon: "today" | "arrange" | "board" | "context" | "files" | "code" | "meetings" | "connections" | "assistant" | "approvals";
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

export function tourProfile(templateId?: string | null) {
  const template = TEMPLATE_CARDS.find((card) => card.id === templateId);
  const role = template?.role ?? "general";
  return { template, role, ...PROFILE[role] };
}

/** The walkthrough uses fictional scenes for features available to this profile. */
export function buildTour(templateId?: string | null, modules?: string | null): TourStep[] {
  const profile = tourProfile(templateId);
  const steps: TourStep[] = [
    { id: "welcome", label: "Your space", title: "Make yourself at home", body: profile.line, icon: "today" },
    { id: "today", label: "Your daily starting point", title: "A day with a little more direction", body: profile.today, tip: profile.template ? `You picked ${profile.template.name}. These are your starting tiles.` : "Your tiles show your own work as you add it.", icon: "today" },
    { id: "arrange", label: "Make it yours", title: "Your desk can change with you", body: "Move tiles by their grip, resize from a corner, or hide what you don't need. Add a tile brings useful views back whenever you want.", tip: "Try arranging your desk after the tour. Your layout is saved.", icon: "arrange" },
    { id: "board", label: "From idea to done", title: "Give the next step a place", body: profile.board, tip: "Open a task for its notes, dates, attachments, and assignment options.", icon: "board" },
    { id: "context", label: "The bigger picture", title: "Work makes more sense in context", body: profile.context, tip: "Context holds the connections. Pages holds your standalone notes; Files holds your uploads.", icon: "context" },
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
  return steps;
}

export function canAutoStartTour(path: string, status?: string) {
  if (path === "/start" || path.startsWith("/spaces/new") || path === "/welcome") return false;
  return status === "active" || (status === "ready" && path === "/today");
}
