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
 * (`projectFolder`), marked with `.ensemble-project.json` so a renamed project keeps its folder and its
 * agents' sessions.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PageDocument } from "@ensemble/shared-types";
import { pageText } from "../pages/markdown.js";

export const PROJECT_MARKER = ".ensemble-project.json";
const BLOCK_START = "<!-- ensemble:project — Ensemble keeps this part current from the project; edit the project in Ensemble instead -->";
const BLOCK_END = "<!-- /ensemble:project -->";
const POINTER = "@AGENTS.md";
/** Files that are Ensemble's, not the project's work: kept out of git, so no run's review shows them. */
const OWN_FILES = [PROJECT_MARKER, "AGENTS.md", "CLAUDE.md", "GEMINI.md"];
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
    `- ${repo.fullName}${repo.url ? ` — ${repo.url}` : ""}${repo.defaultBranch ? ` (default branch ${repo.defaultBranch})` : ""}${repo.description ? `: ${clip(repo.description, 160)}` : ""}`,
  );
  const people = project.people.map(({ role, person }) => {
    const bits = [role || person.role, person.team, person.relationship].filter(Boolean).join(" · ");
    return `- ${person.name}${bits ? ` — ${bits}` : ""}${person.email ? ` <${person.email}>` : ""}`;
  });
  const deliverables = project.deliverables.map((row) => `- ${row.title}${row.due ? ` — due ${row.due.toISOString().slice(0, 10)}` : ""}${row.owner ? ` · ${row.owner}` : ""}${row.notes ? `: ${clip(row.notes, 160)}` : ""}`);
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

async function markerOf(folder: string): Promise<{ projectId?: string; hash?: string } | null> {
  try {
    const value = JSON.parse(await readFile(join(folder, PROJECT_MARKER), "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as { projectId?: string; hash?: string }) : null;
  } catch {
    return null;
  }
}

/** The folder's project, from its marker. */
export async function folderProjectId(folder: string): Promise<string | null> {
  const marker = await markerOf(folder);
  return typeof marker?.projectId === "string" ? marker.projectId : null;
}

/** Marks a folder made for the project (one removed since its run was queued, made again) as the project's. */
export async function ensureMarker(folder: string, project: Pick<AgentProject, "id" | "name">): Promise<void> {
  if (await folderProjectId(folder)) return;
  await writeFile(join(folder, PROJECT_MARKER), `${JSON.stringify({ projectId: project.id, name: project.name, hash: null }, null, 2)}\n`);
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
 * The project's folder in the workspace (`<workspace>/projects/<name>`), made and marked when it is new.
 * One already marked with the project wins, so a renamed project keeps its folder; a name another
 * folder has gets the project's short id after it.
 */
export function projectFolder(workspace: string, project: Pick<AgentProject, "id" | "name">): Promise<string> {
  // One at a time, so two runs of a new project queued together find one folder, not make two.
  const next = making.then(() => findOrMake(workspace, project));
  making = next.catch(() => undefined);
  return next;
}

let making: Promise<unknown> = Promise.resolve();

async function findOrMake(workspace: string, project: Pick<AgentProject, "id" | "name">): Promise<string> {
  const base = join(workspace, "projects");
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    if ((await folderProjectId(join(base, entry.name))) === project.id) return join(base, entry.name);
  }
  const slug = slugOf(project.name);
  for (const name of [slug, `${slug}-${project.id.slice(0, 8)}`, project.id]) {
    const folder = join(base, name);
    const made = await mkdir(folder, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : Promise.reject(error)));
    if (!made) continue;
    await writeFile(join(folder, PROJECT_MARKER), `${JSON.stringify({ projectId: project.id, name: project.name, hash: null }, null, 2)}\n`);
    return folder;
  }
  throw new Error("Could not make the project's folder.");
}

/** The text with Ensemble's block replaced, or added at the top; the rest of the file is the folder's own. */
export function withBlock(text: string, brief: string): string {
  const block = `${BLOCK_START}\n${brief.trim()}\n${BLOCK_END}`;
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + BLOCK_END.length)}`;
  return text.trim() ? `${block}\n\n${text.trimStart()}` : `${block}\n`;
}

const read = (path: string) => readFile(path, "utf8").catch(() => null);

/**
 * Brings the folder's project files up to date with the brief: AGENTS.md's Ensemble block, CLAUDE.md
 * and GEMINI.md pointing at it, the marker's hash, and git keeping them out of the project's changes.
 * `changed`: the brief differs from the one the folder had (the project changed since its last run there).
 */
export async function syncProjectFiles(folder: string, project: Omit<AgentProject, "folder">): Promise<{ changed: boolean }> {
  const marker = await markerOf(folder);
  const agents = join(folder, "AGENTS.md");
  const current = (await read(agents)) ?? "";
  const changed = marker?.hash !== project.hash;
  if (changed || !current.includes(BLOCK_START)) await writeFile(agents, withBlock(current, project.brief));
  for (const name of ["CLAUDE.md", "GEMINI.md"]) {
    const path = join(folder, name);
    const text = await read(path);
    if (text === null) await writeFile(path, `${POINTER}\n`);
    else if (!text.split("\n").some((line) => line.trim() === POINTER)) await writeFile(path, `${POINTER}\n\n${text}`);
  }
  if (changed) await writeFile(join(folder, PROJECT_MARKER), `${JSON.stringify({ projectId: project.id, name: project.name, hash: project.hash }, null, 2)}\n`);
  await excludeFromGit(folder);
  return { changed: Boolean(marker?.hash) && changed };
}

async function excludeFromGit(folder: string): Promise<void> {
  if (!(await stat(join(folder, ".git")).then((info) => info.isDirectory(), () => false))) return;
  const info = join(folder, ".git", "info");
  const exclude = join(info, "exclude");
  const text = (await read(exclude)) ?? "";
  const lines = new Set(text.split("\n").map((line) => line.trim()));
  const missing = OWN_FILES.map((name) => `/${name}`).filter((line) => !lines.has(line));
  if (!missing.length) return;
  const ok = await mkdir(info, { recursive: true }).then(() => true, () => false);
  if (!ok) return;
  await writeFile(exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Ensemble's project files\n${missing.join("\n")}\n`).catch(() => undefined);
}
