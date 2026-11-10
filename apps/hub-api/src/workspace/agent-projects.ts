/**
 * Agent projects (docs/30, Agent projects). The tasks of one Ensemble project that the person's own coding agent
 * (Claude Code, Codex, Cursor, GitHub Copilot, Gemini…) works on share one folder in the Ensemble
 * workspace, `projects/<name>`. Each agent groups its sessions by working folder, so its app lists them
 * together as that project, and a session can carry on from one task to the next. The project's brief
 * (what it is, its repositories, people and deliverables) is kept in the folder's AGENTS.md, which
 * CLAUDE.md and GEMINI.md point at, and rewritten only when its hash changes: the person edits the
 * project in Ensemble and the next run there brings the folder up to date first.
 *
 * The brief is built where the project is (`projectBrief`: the web server at claim time, or this
 * computer's own database), and the folder is found or made on the computer that runs the task
 * (`projectFolder`). Which folder is which project's is kept in `projects/.ensemble-projects.json`,
 * beside the folders, so a renamed project keeps its folder and its agents' sessions, and nothing a run
 * writes inside a project folder can point Ensemble at another.
 */
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PageDocument } from "@ensemble/shared-types";
import { pageText } from "../pages/markdown.js";

const BLOCK_START = "<!-- ensemble:project — Ensemble keeps this part current from the project; edit the project in Ensemble instead -->";
const BLOCK_END = "<!-- /ensemble:project -->";
const POINTER = "@AGENTS.md";
/** Files that are Ensemble's, not the project's work: kept out of git, so no run's review shows them. */
const OWN_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const MAX_BRIEF = 10_000;

export const AgentProject = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  brief: z.string().max(12_000),
  hash: z.string().regex(/^[a-f0-9]{8,64}$/),
  /** Set on the computer that runs the task, when the task works in the project's folder. */
  folder: z.string().max(1000).optional(),
});
export type AgentProject = z.infer<typeof AgentProject>;

/** A job context's (or a claim's) project, when it is a valid one. */
export function agentProjectOf(value: unknown): AgentProject | null {
  const raw = typeof value === "object" && value !== null && "agentProject" in value ? (value as { agentProject?: unknown }).agentProject : value;
  const parsed = AgentProject.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const clip = (text: string, max: number) => {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * An Ensemble Node as a project (docs/35, Projects on the owner's agent): its conversations on the owner's
 * AI plan and its coding sessions that have no folder of their own share one folder, so the agent's app
 * lists them together. The brief is the node's role and charter. The name matches the one its chats use
 * (node/brain.ts), so both find the same folder by the node's id.
 */
export async function nodeProjectBrief(prisma: Pick<PrismaClient, "nodeAgent">, nodeId: string): Promise<Omit<AgentProject, "folder"> | null> {
  const node = await prisma.nodeAgent.findUnique({ where: { id: nodeId }, select: { id: true, name: true, slug: true, role: true, charter: true } });
  if (!node) return null;
  const brief = clip(
    [
      `# ${node.name} (Ensemble Node @${node.slug})`,
      "",
      `This folder is the Ensemble Node ${node.name}'s project: its conversations and the coding sessions it starts without a folder of their own work here. Keep files only one task needs in a folder named for that task.`,
      "",
      `Role: ${node.role}`,
      node.charter.trim() ? `\n## Charter\n${clip(node.charter, 4000)}` : "",
    ].join("\n"),
    MAX_BRIEF,
  );
  return { id: node.id, name: `${node.name} (Ensemble Node)`, brief, hash: createHash("sha256").update(brief).digest("hex").slice(0, 16) };
}

/** The project's brief as Markdown for its agents, with a hash of it. Null when the project is gone. */
export async function projectBrief(prisma: PrismaClient, userId: string, projectId: string): Promise<Omit<AgentProject, "folder"> | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
    select: {
      id: true,
      name: true,
      summary: true,
      notes: true,
      status: true,
      aliases: true,
      content: true,
      repoLinks: { where: { repo: { deletedAt: null } }, select: { repo: { select: { fullName: true, url: true, description: true, defaultBranch: true } } }, take: 20 },
      people: { select: { role: true, person: { select: { name: true, role: true, team: true, relationship: true, email: true } } }, take: 30 },
      deliverables: { where: { deletedAt: null, status: "upcoming" }, orderBy: [{ due: { sort: "asc", nulls: "last" } }], take: 15, select: { title: true, due: true, owner: true, notes: true } },
    },
  });
  if (!project) return null;
  const doc = PageDocument.safeParse(project.content);
  const page = clip(pageText(doc.success ? doc.data : null, ""), 4000);
  const repos = project.repoLinks.map(({ repo }) =>
    `- ${repo.fullName}${repo.url ? `: ${repo.url}` : ""}${repo.defaultBranch ? ` (default branch ${repo.defaultBranch})` : ""}${repo.description ? `: ${clip(repo.description, 160)}` : ""}`,
  );
  const people = project.people.map(({ role, person }) => {
    const bits = [role || person.role, person.team, person.relationship].filter(Boolean).join(" · ");
    return `- ${person.name}${bits ? `: ${bits}` : ""}${person.email ? ` <${person.email}>` : ""}`;
  });
  const deliverables = project.deliverables.map((row) => `- ${row.title}${row.due ? `, due ${row.due.toISOString().slice(0, 10)}` : ""}${row.owner ? ` · ${row.owner}` : ""}${row.notes ? `: ${clip(row.notes, 160)}` : ""}`);
  const brief = clip(
    [
      `# ${project.name}`,
      project.summary ? clip(project.summary, 1500) : "",
      [project.status !== "active" ? `Status: ${project.status}` : "", project.aliases.length ? `Also called: ${project.aliases.join(", ")}` : ""].filter(Boolean).join(" · "),
      project.notes ? `## Notes\n${clip(project.notes, 2500)}` : "",
      page ? `## Project page\n${page}` : "",
      repos.length ? `## Repositories\n${repos.join("\n")}` : "",
      people.length ? `## People\n${people.join("\n")}` : "",
      deliverables.length ? `## Upcoming deliverables\n${deliverables.join("\n")}` : "",
      `## In Ensemble\nThis folder is where the project's tasks are worked on, each task in its own session unless it continues one. The project is ensemble://project/${project.id}: ask Ensemble (ensemble_context) for its tasks, meetings, files and people.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    MAX_BRIEF,
  );
  return { id: project.id, name: project.name, brief, hash: createHash("sha256").update(brief).digest("hex").slice(0, 16) };
}

/** Which project has which folder, kept beside the project folders where no run in one can change it. */
type Index = Record<string, { folder: string; name: string; hash: string | null }>;
const INDEX = ".ensemble-projects.json";
const NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** A real folder (never a link to one). */
const isFolder = (path: string) => lstat(path).then((info) => info.isDirectory() && !info.isSymbolicLink(), () => false);

async function projectsBase(workspace: string): Promise<string> {
  const base = join(workspace, "projects");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (!(await isFolder(base))) throw new Error("The workspace's projects folder is not a folder.");
  return base;
}

async function readIndex(base: string): Promise<Index> {
  const text = await readRegular(join(base, INDEX));
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return {};
    const index: Index = {};
    for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
      const entry = row as { folder?: unknown; name?: unknown; hash?: unknown } | null;
      if (entry && typeof entry.folder === "string" && NAME.test(entry.folder)) index[id] = { folder: entry.folder, name: typeof entry.name === "string" ? entry.name : "", hash: typeof entry.hash === "string" ? entry.hash : null };
    }
    return index;
  } catch {
    return {};
  }
}

const writeIndex = (base: string, index: Index) => writeSafely(base, INDEX, `${JSON.stringify(index, null, 2)}\n`);

/**
 * A file's text without following a link: null when it is missing, a link, or not a plain file. A run
 * in the folder could have put a link there to make Ensemble read or write something outside it.
 */
async function readRegular(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Writes a file in a real folder through a new file renamed over it, so a link in its place is replaced, never followed. */
async function writeSafely(dir: string, name: string, text: string): Promise<void> {
  if (!(await isFolder(dir))) throw new Error(`${dir} is not a folder.`);
  const temporary = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function slugOf(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "project"
  );
}

/**
 * The project's folder in the workspace (`<workspace>/projects/<name>`), made when it is new. The index
 * beside the folders keeps each project's own, so a renamed project keeps its folder and its agents'
 * sessions, and one removed is made again under its name; a name another folder has gets the
 * project's short id after it.
 */
export function projectFolder(workspace: string, project: Pick<AgentProject, "id" | "name">): Promise<string> {
  // One at a time, so two runs of a new project queued together find one folder, not make two.
  const next = making.then(() => findOrMake(workspace, project));
  making = next.catch(() => undefined);
  return next;
}

let making: Promise<unknown> = Promise.resolve();

async function findOrMake(workspace: string, project: Pick<AgentProject, "id" | "name">): Promise<string> {
  const base = await projectsBase(workspace);
  const index = await readIndex(base);
  const known = index[project.id];
  if (known) {
    const folder = join(base, known.folder);
    if (await isFolder(folder)) return folder;
    const made = await mkdir(folder, { mode: 0o700 }).then(() => true, () => false);
    if (made) return folder;
  }
  const taken = new Set(Object.entries(index).filter(([id]) => id !== project.id).map(([, row]) => row.folder));
  const slug = slugOf(project.name);
  for (const name of [slug, `${slug}-${project.id.slice(0, 8)}`, project.id.toLowerCase()]) {
    if (taken.has(name) || !NAME.test(name)) continue;
    const folder = join(base, name);
    const made = await mkdir(folder, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : Promise.reject(error)));
    if (!made) continue;
    await writeIndex(base, { ...index, [project.id]: { folder: name, name: project.name, hash: null } });
    return folder;
  }
  throw new Error("Could not make the project's folder.");
}

/** The project whose folder this is, by the index (null: not a project's folder). */
export async function folderProject(workspace: string, folder: string): Promise<string | null> {
  const base = join(workspace, "projects");
  if (dirname(folder) !== base) return null;
  const name = basename(folder);
  const index = await readIndex(base);
  return Object.entries(index).find(([, row]) => row.folder === name)?.[0] ?? null;
}

/** The text with Ensemble's block replaced, or added at the top; the rest of the file is the folder's own. */
export function withBlock(text: string, brief: string): string {
  const block = `${BLOCK_START}\n${brief.trim()}\n${BLOCK_END}`;
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + BLOCK_END.length)}`;
  return text.trim() ? `${block}\n\n${text.trimStart()}` : `${block}\n`;
}

/**
 * Brings the project folder's files up to date with the brief: AGENTS.md's Ensemble block, CLAUDE.md
 * and GEMINI.md pointing at it, and git keeping them out of the project's changes. `changed`: the brief
 * differs from the one the folder had (the project changed since its last run there). Runs in the folder
 * can change these files, so none is read or written through a link.
 */
export async function syncProjectFiles(workspace: string, folder: string, project: Omit<AgentProject, "folder">): Promise<{ changed: boolean }> {
  const base = await projectsBase(workspace);
  if ((await folderProject(workspace, folder)) !== project.id || !(await isFolder(folder))) throw new Error("That folder is not the project's.");
  const index = await readIndex(base);
  const before = index[project.id]?.hash ?? null;
  const current = (await readRegular(join(folder, "AGENTS.md"))) ?? "";
  const changed = before !== project.hash;
  if (changed || !current.includes(BLOCK_START)) await writeSafely(folder, "AGENTS.md", withBlock(current, project.brief));
  for (const name of ["CLAUDE.md", "GEMINI.md"]) {
    const text = await readRegular(join(folder, name));
    if (text === null) await writeSafely(folder, name, `${POINTER}\n`);
    else if (!text.split("\n").some((line) => line.trim() === POINTER)) await writeSafely(folder, name, `${POINTER}\n\n${text}`);
  }
  if (changed) await writeIndex(base, { ...index, [project.id]: { folder: basename(folder), name: project.name, hash: project.hash } });
  await excludeFromGit(folder);
  return { changed: before !== null && changed };
}

async function excludeFromGit(folder: string): Promise<void> {
  const git = join(folder, ".git");
  if (!(await isFolder(git))) return;
  const info = join(git, "info");
  if (!(await isFolder(info))) {
    if (await lstat(info).then(() => true, () => false)) return;
    await mkdir(info).catch(() => undefined);
  }
  const text = (await readRegular(join(info, "exclude"))) ?? "";
  const lines = new Set(text.split("\n").map((line) => line.trim()));
  const missing = OWN_FILES.map((name) => `/${name}`).filter((line) => !lines.has(line));
  if (!missing.length) return;
  await writeSafely(info, "exclude", `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Ensemble's project files\n${missing.join("\n")}\n`).catch(() => undefined);
}
