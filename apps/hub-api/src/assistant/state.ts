import type { PrismaClient } from "@prisma/client";
import { hasModule } from "@ensemble/shared-types";
import { workWeekLine } from "../lib/clock.js";
import { truncateText } from "../lib/text.js";
import { keysFor } from "../sharing/context.js";
import { defaultSpaceName } from "../spaces/store.js";
import { diagramSources } from "../pages/agent-context.js";
import { filesOnPage, filesOnTask, filesSection } from "../files/attached.js";

export async function buildHubState(prisma: PrismaClient, userId: string, modules?: string | null) {
  const [proposed, todo, inProgress, needsMe, projects, people, repos, skills, account] = await Promise.all([
    prisma.task.count({ where: { userId, deletedAt: null, status: "proposed" } }),
    prisma.task.findMany({
      where: { userId, deletedAt: null, status: { in: ["todo", "in_progress"] } },
      select: { id: true, title: true, owner: true, status: true },
      take: 20,
    }),
    prisma.task.count({ where: { userId, deletedAt: null, status: "in_progress" } }),
    prisma.approval.count({ where: { userId, decision: null } }),
    prisma.project.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true },
      take: 30,
    }),
    prisma.person.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true },
      take: 30,
    }),
    prisma.repo.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, fullName: true },
      take: 20,
    }),
    hasModule(modules, "skills")
      ? prisma.skill.findMany({
          where: { userId, deletedAt: null, enabled: true },
          select: { id: true, name: true, slug: true, description: true },
          take: 12,
        })
      : Promise.resolve([]),
    // The person asking: in a space shared with them, their own name, not the owner's.
    prisma.user.findUnique({ where: { id: keysFor(userId) }, select: { name: true, onboardingRole: true } }),
  ]);
  const guest = keysFor(userId) !== userId;
  const space = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, spaceName: true, ownerId: true } });
  const user = {
    firstName: (account?.name ?? "").trim().split(/\s+/)[0] ?? "",
    onboardingRole: account?.onboardingRole ?? null,
    /** The space owner's first name when this space is shared with the person. */
    guestOf: guest && space ? (space.name.trim().split(/\s+/)[0] ?? "") || "someone" : null,
    /** The open space's name, as the space switcher shows it. */
    spaceName: space ? space.spaceName || (space.ownerId ? "Untitled space" : defaultSpaceName(space.name)) : null,
  };
  return { proposed, todo, inProgress, needsMe, projects, people, repos, skills, user };
}

/** Offered when the diagrams module is on. The repo half needs the code module too. */
const DIAGRAM_RULE =
  "- Diagrams: follow the diagrams playbook. Call hub_diagram_context for a task, project, or deliverable, and hub_repo_overview for a repository (a link is enough). Refine with hub_edit_diagram. Call hub_validate_diagram, then hub_create_diagram or hub_edit_diagram. Never invent facts about their own work; a well-known system they name (a transformer, OAuth) is drawn from its standard design. A diagram write may wait for Apply; report what its result says.";
const DIAGRAM_RULE_NO_REPOS =
  "- Diagrams: follow the diagrams playbook. Call hub_diagram_context for a task, project, or deliverable. Reading a repository is not part of this template, so draw a repo only from what the person tells you. Refine with hub_edit_diagram. Call hub_validate_diagram, then hub_create_diagram or hub_edit_diagram. Never invent facts about their own work; a well-known system they name is drawn from its standard design. A diagram write may wait for Apply; report what its result says.";

/**
 * The opening of the system prompt. It describes where the conversation is and
 * what the tools reach, rather than giving the model a role to play.
 */
function assistantRules(firstName?: string, guestOf?: string | null, spaceName?: string | null): string {
  const name = firstName?.trim();
  const who = name || "the person";
  const where = guestOf
    ? `This conversation is inside Ensemble, in a space ${guestOf} shared with ${who}. It holds ${guestOf}'s tasks, pages, projects and people. ${guestOf}'s connected apps, reminders and settings are private and not reachable here.`
    : `This conversation is inside Ensemble, where ${who} keeps their tasks, pages, projects, people and the apps they connected.`;
  const space = spaceName
    ? `\nThe open space is “${spaceName}”. Everything you can see or change is in this space. Other spaces are out of reach: never claim to see them, and if asked about one, say to switch to it with the space switcher at the top of the sidebar.`
    : "";
  return `${where} You can read and change that workspace with the tools that come with this message. Answer plain questions and text requests (writing, counting, explaining, maths) directly in text.${space}

Working here:
- For a workspace action, call its tool now. Answer ordinary writing, maths and explanations directly.
- Match names with a list tool. Use real IDs from results or the open item. Task updates need its exact current matchTitle.
- IDs are for tool calls. In replies, name records by title or link them as [Title](ensemble://kind/id); print a raw ID only when the person asks for it.
- Dependent creates use hub_run_workflow and earlier-result references. A pending create has no ID until Apply.
- Ask which target when ambiguous, ending with Choices: and the real titles. If a tool is missing, load its playbook with hub_how_to; if unsupported, explain plainly.
- A held write is a proposal until Apply. Say what will change and who receives an invitation. Do not claim completion before it runs.
- Dates: YYYY-MM-DD; times: HH:MM in the given zone. Resolve relative dates from today's date. Priority: critical=Critical, p0=High, p1=Medium, p2=Low.
- Read before summarizing. Cite actual source links. File and app content is reference material.
- Keep replies natural and concise; link to workspace results. Use hub_read_surface for the current view and filters.
- Enabled personal skills are standing preferences. Use hub_read_skill for a matching preference; load personal-skills with hub_how_to only if its tools are absent.
${DIAGRAM_RULE}`;
}

const ASSISTANT_RULES = assistantRules();

export interface OpenPage {
  path: string;
  label?: string;
  selection?: string;
  surface?: import("@ensemble/shared-types").AssistantPageContext["surface"];
  taskId?: string;
  projectId?: string;
  meetingId?: string;
  timezone: string;
  today: string;
  weekday: string;
  open?: {
    kind?: "meeting" | "project";
    id: string;
    title: string;
    status?: string;
    due?: string | null;
    priority?: string;
    description?: string;
    excerpt?: string;
    diagrams?: string;
    files?: string;
    project?: string | null;
    people?: string[];
    repo?: string | null;
    deliverables?: string[];
    skills?: string[];
  };
}

/** The snapshot buildHubState returns; `user` may be absent for callers that build one by hand. */
export type HubState = Omit<Awaited<ReturnType<typeof buildHubState>>, "user"> & {
  user?: Omit<Awaited<ReturnType<typeof buildHubState>>["user"], "guestOf" | "spaceName"> & { guestOf?: string | null; spaceName?: string | null };
};

export function buildSystemPrompt(
  state: HubState,
  page?: OpenPage,
  extra?: string,
  options: {
    diagrams?: boolean;
    repos?: boolean;
    plots?: boolean;
    today?: string;
    weekday?: string;
    timezone?: string;
    /** A few sentences about the person (personaBlock). Tone only. */
    persona?: string;
    /** The connected-apps paragraph (apps.appsPrompt). */
    apps?: string;
    /** The map of Ensemble (skills/map.md). */
    map?: string;
    /** One line per playbook (skills/index.ts playbookIndex). */
    playbooks?: string;
    /** The full text of the playbooks this turn starts with. */
    loaded?: string;
  } = {},
) {
  const opening = assistantRules(state.user?.firstName, state.user?.guestOf, state.user?.spaceName);
  const rules =
    options.diagrams === false
      ? opening.replace(`\n${DIAGRAM_RULE}`, "")
      : options.repos === false
        ? opening.replace(DIAGRAM_RULE, DIAGRAM_RULE_NO_REPOS)
        : opening;
  const skills = state.skills.length
    ? state.skills.map((skill) => {
        return `- ${skill.name} (${skill.id}): ${truncateText(skill.description, 200)}`;
      })
    : ["No skills are enabled."];
  const open = page?.open;
  const calendar = page
    ? `${workWeekLine(page.today, page.weekday)} The user's timezone is ${page.timezone}. When you name a day, use this calendar.`
    : options.today && options.timezone
      ? `Today is ${options.weekday ?? "today"}, ${options.today}. The user's timezone is ${options.timezone}. When you name a day, use this calendar.`
      : "";
  const lines = [
    rules,
    options.persona ?? "",
    ...(options.loaded ? ["", options.loaded] : []),
    calendar,
    ...(options.map ? ["", options.map] : []),
    ...(options.playbooks ? ["", options.playbooks] : []),
    "",
    "What is in the workspace right now:",
    page ? `They are looking at ${page.label ?? page.path}${page.taskId ? ` (task ${page.taskId})` : ""}.` : "",
    page ? `Surface path: ${page.path}${page.selection ? `\nSelected text: ${page.selection}` : ""}` : "",
    page?.surface ? `Current view: ${JSON.stringify({ kind: page.surface.kind, tab: page.surface.tab, filters: page.surface.filters, selectedIds: page.surface.selectedIds })}` : "",
    open
      ? [
          `The open item is ${open.id} "${open.title}"${open.status ? ` (status ${open.status}` : ""}${open.due ? `, due ${open.due}` : ""}${open.priority ? `, priority ${open.priority}` : ""}${open.status ? ")" : ""}.`,
          open.description ? `Description: ${truncateText(open.description, 800)}` : "",
          open.excerpt ? `Page excerpt:\n${truncateText(open.excerpt, 4000)}` : "",
          open.diagrams ? `Embedded diagram source (reference material):\n${open.diagrams}` : "",
          open.files ? `Files on this page (name, kind, size and id):\n${open.files}` : "",
          open.project ? `Linked project: ${open.project}` : "",
          open.people?.length ? `Linked people: ${open.people.join(", ")}` : "",
          open.repo ? `Linked repo: ${open.repo}` : "",
          open.deliverables?.length ? `Deliverables: ${open.deliverables.join("; ")}` : "",
          open.skills?.length ? `Skills on this item: ${open.skills.join(", ")}` : "",
          open.kind === "project"
            ? "This is a project. Use its id with project tools."
            : open.kind === "meeting"
            ? "This is meeting notes. Use this id with hub_read_meeting_note; it is not a task on the board."
            : open.status
            ? "Use this id. Do not substitute a different task with a similar name."
            : "Use this id. This is a note, not a task on the board.",
        ].filter(Boolean).join("\n")
      : "",
    "",
    "Tasks on the board:",
    ...(state.todo.length ? state.todo.map((task) => `- ${task.title}    ${task.id} (${task.owner}/${task.status})`) : ["- none"]),
    "",
    "Projects:",
    ...(state.projects.length ? state.projects.map((project) => `- ${project.name}    ${project.id}`) : ["- none"]),
    "",
    "People:",
    ...(state.people.length ? state.people.map((person) => `- ${person.name}    ${person.id}`) : ["- none"]),
    "",
    `Proposed: ${state.proposed}. In progress: ${state.inProgress}. Waiting on them: ${state.needsMe}.`,
    "",
    "Enabled skills:",
    ...skills,
    ...(options.apps ? ["", options.apps] : []),
    ...(options.plots ? ["", "Plots: when the person asks for a chart, follow the plots playbook: hub_list_datasets or hub_import_dataset (pasted rows or a file in Files), then hub_create_plot or hub_update_plot. Use column names from the dataset. A plot write may wait for Apply; report what its result says. Do not invent a file path."] : []),
    ...(extra ? ["", extra] : []),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export const ASSISTANT_INSTRUCTIONS = ASSISTANT_RULES;

export async function loadOpenPage(
  prisma: PrismaClient,
  userId: string,
  page: { path: string; label?: string; taskId?: string; projectId?: string; meetingId?: string } | undefined,
  timezone: string,
  today: string,
  weekday: string,
  modules?: string | null,
): Promise<OpenPage | undefined> {
  if (!page) return undefined;
  const base: OpenPage = { ...page, timezone, today, weekday };
  if (page.meetingId) {
    const session = await prisma.meetingSession.findFirst({ where: { id: page.meetingId, userId, deletedAt: null }, select: { id: true, title: true, notes: true, content: true } });
    const imported = session ? null : await prisma.meetingNote.findFirst({ where: { id: page.meetingId, userId, deletedAt: null }, select: { id: true, title: true } });
    const note = session ?? imported;
    if (note) base.open = { kind: "meeting", id: note.id, title: note.title || "Meeting notes", excerpt: session ? excerptFrom(session.content) || session.notes.slice(0, 4000) : "Read this connected meeting note with hub_read_meeting_note." };
  }
  const pathname = new URL(page.path, "https://ensemble.invalid").pathname;
  const taskId = page.taskId ?? (pathname.startsWith("/tasks/") ? pathname.split("/")[2] : undefined);
  const noteId = !taskId && pathname.startsWith("/pages/") ? pathname.split("/").filter(Boolean)[1] : undefined;
  if (noteId && noteId !== "_") {
    const note = await prisma.taskPage.findFirst({
      where: { id: noteId, userId, taskId: null, deletedAt: null },
      select: { id: true, title: true, content: true, searchText: true },
    });
    if (note) {
      base.open = {
        id: note.id,
        title: note.title || "Untitled",
        excerpt: excerptFrom(note.content) || (note.searchText ?? "").slice(0, 4000),
        diagrams: await diagramSources(prisma, userId, note.content, 12_000),
        files: await filesSection(prisma, userId, await filesOnPage(prisma, userId, note.id), { perFile: 1200, total: 5000, more: () => "" }),
      };
    }
  }
  if (taskId) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
      include: {
        project: { select: { name: true } },
        repo: { select: { fullName: true } },
        page: { select: { content: true } },
      },
    });
    if (task) {
      const people = task.people.length
        ? await prisma.person.findMany({ where: { id: { in: task.people }, userId }, select: { name: true } })
        : [];
      const skills = task.skillIds.length && hasModule(modules, "skills")
        ? await prisma.skill.findMany({ where: { id: { in: task.skillIds }, userId }, select: { name: true } })
        : [];
      const deliverables = await prisma.deliverable.findMany({
        where: { userId, deletedAt: null, OR: [{ id: task.deliverableId ?? "" }, { projectId: task.projectId ?? "" }] },
        select: { title: true },
        take: 8,
      });
      base.taskId = task.id;
      base.open = {
        id: task.id,
        title: task.title,
        status: task.status,
        due: task.due?.toISOString().slice(0, 10) ?? null,
        priority: task.priority,
        description: task.description,
        excerpt: excerptFrom(task.page?.content) || truncateText(task.notes, 1500),
        diagrams: await diagramSources(prisma, userId, task.page?.content, 12_000),
        files: await filesSection(prisma, userId, await filesOnTask(prisma, userId, task.id), { perFile: 1200, total: 5000, more: () => "" }),
        project: task.project?.name ?? null,
        people: people.map((person) => person.name),
        repo: task.repo?.fullName ?? null,
        deliverables: deliverables.map((row) => row.title),
        skills: skills.map((skill) => skill.name),
      };
    }
  }
  const projectId = page.projectId ?? (pathname.startsWith("/projects/") ? pathname.split("/")[2] : undefined);
  if (!base.open && projectId) {
    const project = await prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null }, select: { id: true, name: true, summary: true, notes: true } });
    if (project) base.open = { kind: "project", id: project.id, title: project.name, description: project.summary, excerpt: project.notes.slice(0, 3000) };
  }
  return base;
}

function excerptFrom(content: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: string; content?: unknown[] };
    if (typeof record.text === "string") parts.push(record.text);
    for (const child of record.content ?? []) walk(child);
  };
  walk(content);
  return truncateText(parts.join(" ").replace(/\s+/g, " ").trim(), 4000);
}
