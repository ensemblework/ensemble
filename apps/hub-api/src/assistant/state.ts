import type { PrismaClient } from "@prisma/client";
import { hasModule } from "@ensemble/shared-types";
import { workWeekLine } from "../lib/clock.js";
import { truncateText } from "../lib/text.js";
import { keysFor } from "../sharing/context.js";

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
          select: { id: true, name: true, slug: true, description: true, body: true },
          take: 12,
        })
      : Promise.resolve([]),
    // The person asking: in a space shared with them, their own name, not the owner's.
    prisma.user.findUnique({ where: { id: keysFor(userId) }, select: { name: true, onboardingRole: true } }),
  ]);
  const guest = keysFor(userId) !== userId;
  const space = guest ? await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }) : null;
  const user = {
    firstName: (account?.name ?? "").trim().split(/\s+/)[0] ?? "",
    onboardingRole: account?.onboardingRole ?? null,
    /** The space owner's first name when this space is shared with the person. */
    guestOf: space ? (space.name.trim().split(/\s+/)[0] ?? "") || "someone" : null,
  };
  return { proposed, todo, inProgress, needsMe, projects, people, repos, skills, user };
}

/** Offered when the diagrams module is on. The repo half needs the code module too. */
const DIAGRAM_RULE =
  "- Diagrams: when the person asks for a diagram, follow the block-diagram skill appended to this prompt. Call hub_diagram_context for a task, project, or deliverable, and hub_repo_overview for a repository (a link is enough). Refine with hub_edit_diagram. Call hub_validate_diagram, then hub_create_diagram or hub_edit_diagram. Do not invent blocks. A diagram write waits for Apply.";
const DIAGRAM_RULE_NO_REPOS =
  "- Diagrams: when the person asks for a diagram, follow the block-diagram skill appended to this prompt. Call hub_diagram_context for a task, project, or deliverable. Reading a repository is not part of this template, so draw a repo only from what the person tells you. Refine with hub_edit_diagram. Call hub_validate_diagram, then hub_create_diagram or hub_edit_diagram. Do not invent blocks. A diagram write waits for Apply.";

/**
 * The opening of the system prompt. It describes where the conversation is and
 * what the tools reach, rather than giving the model a role to play.
 */
function assistantRules(firstName?: string, guestOf?: string | null): string {
  const name = firstName?.trim();
  const who = name || "the person";
  const where = guestOf
    ? `This conversation is inside Ensemble, in a space ${guestOf} shared with ${who}. It holds ${guestOf}'s tasks, pages, projects and people. ${guestOf}'s connected apps, reminders and settings are private and not reachable here.`
    : `This conversation is inside Ensemble, where ${who} keeps their tasks, pages, projects, people and the apps they connected.`;
  return `${where} You can read and change that workspace with the tools that come with this message. Answer plain questions and text requests (writing, counting, explaining, maths) directly in text.

Working here:
- When ${who} asks for something in the workspace and a tool can do it, call the tool in this turn. Do not say you will do it later.
- Use ids from the lists below and from the open page. Never invent a person, project, repo, skill or task id.
- Match names with a list tool before you write.
- To update or complete a task, call hub_list_tasks with query set to its exact title, then hub_update_task with that id and matchTitle set to the same current title. The write is refused when they differ. Never reuse an id from a different task.
- A created task has no id until Apply is pressed. The result of that Apply includes the id. Until then, do not update it.
- If more than one item could match, or the request names none clearly, ask which one and call no write. End the question with a line "Choices:" and then a markdown list of the real titles.
- If they asked for an action and no tool supports it, say so in one sentence. Never use another tool as a substitute.
- A change held for Apply has not happened yet. Word it as a proposal: "I've proposed a project page — press Apply to create it", or "Ready to apply: …". Never say you created or drafted it before Apply. Never say you created, set, linked, or marked something done while it is waiting. Do not call that write again.
- Priority: p0 is High, p1 is Normal, p2 is Low.
- Dates you send to tools are YYYY-MM-DD and times are HH:MM. Work out "tomorrow" and "Friday" from today's date below.
- In task titles and text, use absolute dates (for example "before the Oct 6 release", not "before the release tomorrow").
- When you use web search, cite the links it returned. If it returned nothing, say you could not verify it. Never invent a citation or a source.
- Keep replies short.
- Enabled skills below are ${name ? `${name}'s` : "their"} standing instructions. Follow a skill when the request matches it.
${DIAGRAM_RULE}`;
}

const ASSISTANT_RULES = assistantRules();

export interface OpenPage {
  path: string;
  label?: string;
  taskId?: string;
  projectId?: string;
  timezone: string;
  today: string;
  weekday: string;
  open?: {
    id: string;
    title: string;
    status?: string;
    due?: string | null;
    priority?: string;
    description?: string;
    excerpt?: string;
    project?: string | null;
    people?: string[];
    repo?: string | null;
    deliverables?: string[];
    skills?: string[];
  };
}

/** The snapshot buildHubState returns; `user` may be absent for callers that build one by hand. */
export type HubState = Omit<Awaited<ReturnType<typeof buildHubState>>, "user"> & {
  user?: Omit<Awaited<ReturnType<typeof buildHubState>>["user"], "guestOf"> & { guestOf?: string | null };
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
  } = {},
) {
  const opening = assistantRules(state.user?.firstName, state.user?.guestOf);
  const rules =
    options.diagrams === false
      ? opening.replace(`\n${DIAGRAM_RULE}`, "")
      : options.repos === false
        ? opening.replace(DIAGRAM_RULE, DIAGRAM_RULE_NO_REPOS)
        : opening;
  const skills = state.skills.length
    ? state.skills.map((skill) => {
        const body = truncateText(skill.body.trim(), 1200);
        return `## ${skill.name}\n${skill.description}\n${body}`;
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
    calendar,
    "What is in the workspace right now:",
    page ? `They are looking at ${page.label ?? page.path}${page.taskId ? ` (task ${page.taskId})` : ""}.` : "",
    open
      ? [
          `The open item is ${open.id} "${open.title}"${open.status ? ` (status ${open.status}` : ""}${open.due ? `, due ${open.due}` : ""}${open.priority ? `, priority ${open.priority}` : ""}${open.status ? ")" : ""}.`,
          open.description ? `Description: ${truncateText(open.description, 800)}` : "",
          open.excerpt ? `Page excerpt:\n${truncateText(open.excerpt, 4000)}` : "",
          open.project ? `Linked project: ${open.project}` : "",
          open.people?.length ? `Linked people: ${open.people.join(", ")}` : "",
          open.repo ? `Linked repo: ${open.repo}` : "",
          open.deliverables?.length ? `Deliverables: ${open.deliverables.join("; ")}` : "",
          open.skills?.length ? `Skills on this item: ${open.skills.join(", ")}` : "",
          open.status
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
    ...(options.plots ? ["", "Plots: when the person asks for a chart, call hub_list_datasets or hub_import_dataset, then hub_create_plot or hub_update_plot. Use column names from the dataset. A plot write waits for Apply. Do not invent a file path."] : []),
    ...(extra ? ["", extra] : []),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export const ASSISTANT_INSTRUCTIONS = ASSISTANT_RULES;

export async function loadOpenPage(
  prisma: PrismaClient,
  userId: string,
  page: { path: string; label?: string; taskId?: string; projectId?: string } | undefined,
  timezone: string,
  today: string,
  weekday: string,
  modules?: string | null,
): Promise<OpenPage | undefined> {
  if (!page) return undefined;
  const base: OpenPage = { ...page, timezone, today, weekday };
  const taskId = page.taskId ?? (page.path.startsWith("/tasks/") ? page.path.split("/")[2] : undefined);
  const noteId = !taskId && page.path.startsWith("/pages/") ? page.path.split("/").filter(Boolean)[1] : undefined;
  if (noteId && noteId !== "_") {
    const note = await prisma.taskPage.findFirst({
      where: { id: noteId, userId, taskId: null },
      select: { id: true, title: true, content: true, searchText: true },
    });
    if (note) {
      base.open = {
        id: note.id,
        title: note.title || "Untitled",
        excerpt: excerptFrom(note.content) || (note.searchText ?? "").slice(0, 4000),
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
        project: task.project?.name ?? null,
        people: people.map((person) => person.name),
        repo: task.repo?.fullName ?? null,
        deliverables: deliverables.map((row) => row.title),
        skills: skills.map((skill) => skill.name),
      };
    }
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
