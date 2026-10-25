/**
 * Ensemble Code: the assistant in the person's terminal (`ensemble` → Chat), on their own
 * computer. Besides the Hub tools it can read the folder it was opened in (files, a search, PDF
 * and Office documents) and hand coding work to an agent run: Ensemble's agent, Claude Code,
 * Codex or Cursor's agent, under the person's run profile, with the run's sandbox, trust, git and
 * internet rules. It never edits files itself; the run does, and its questions reach Needs me.
 *
 * Offered only by the runtime on the person's computer, and only to the code surface.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { pickRunProfile, type RunProfile } from "@ensemble/shared-types";
import { readFileText } from "../../files/extract.js";
import { appendToTaskPage } from "./pages.js";
import { createTask } from "../../services/tasks.js";
import { expandHome, GuardError, outsideRefusal, resolveWorkFolder, within } from "../../workspace/guard.js";
import { Assign, createJob } from "../../workspace/assign.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type CodeSession, type ToolContext } from "../types.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT = 60_000;
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache"]);

function session(ctx: ToolContext): CodeSession {
  if (!ctx.code) throw new ToolBlockedError("These tools work only in Ensemble Code, in the terminal.");
  return ctx.code;
}

/**
 * A path the person or the model named, resolved from the launch folder. Anything on the hard floor
 * (keys, dotfiles in the home folder, Ensemble's own data and code) is refused wherever it is.
 */
export async function readablePath(code: CodeSession, path: string | undefined): Promise<string> {
  const raw = expandHome((path ?? ".").trim() || ".");
  const full = isAbsolute(raw) ? raw : resolve(code.folder, raw);
  const real = await realpath(full).catch(() => {
    throw new ToolBlockedError(`${path ?? "."} does not exist.`);
  });
  const floor = outsideRefusal(real, false);
  if (floor && !within(code.folder, real)) throw new ToolBlockedError(`${real}: ${floor}`);
  if (floor) throw new ToolBlockedError(`${relative(code.folder, real) || real}: ${floor}`);
  return real;
}

function shown(code: CodeSession, path: string): string {
  return within(code.folder, path) ? relative(code.folder, path) || "." : path;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  return sample.includes(0);
}

async function walk(root: string, visit: (path: string, depth: number, isDir: boolean) => Promise<boolean | void>, maxDepth: number, depth = 0): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    const stop = await visit(path, depth, entry.isDirectory());
    if (stop === true) return;
    if (entry.isDirectory() && depth + 1 < maxDepth) await walk(path, visit, maxDepth, depth + 1);
  }
}

/**
 * Text out of a PDF, Word, Excel or PowerPoint file (read by the Files reader, in a worker
 * with memory and time limits, secrets redacted), or a text file as it is.
 */
export async function documentText(path: string): Promise<string> {
  const data = await readFile(path);
  const read = await readFileText(basename(path), new Uint8Array(data));
  if (read.status === "ready") return read.warnings.length ? `${read.text}\n\n(${read.warnings.join(" ")})` : read.text;
  if (read.status === "failed" || read.warnings.length) throw new ToolBlockedError(read.warnings.join(" ") || `${basename(path)} could not be read.`);
  if (looksBinary(data)) throw new ToolBlockedError(`${basename(path)} is not a text file or a document Ensemble can read (PDF, .docx, .xlsx, .pptx).`);
  return data.toString("utf8");
}

const clip = (text: string, limit = MAX_TEXT) => (text.length > limit ? `${text.slice(0, limit)}\n… (cut at ${limit} characters of ${text.length})` : text);

export function profileLine(profile: RunProfile): string {
  const git = profile.delivery === "local" ? "local only" : profile.delivery === "commit" ? "may commit" : "may commit and push";
  const mode = profile.mode === "unattended" ? "Run unattended" : profile.mode === "review" ? "Review only" : "Ask";
  return `${profile.name}: ${mode}, ${git}, sandbox ${profile.sandbox ? "on" : "off"}, internet ${profile.network ? "on" : "off"}`;
}

/** Code tools by name, for Apply (they are not in the web assistant's catalog). */
export function codeTool(name: string): AnyHubTool | undefined {
  return codeTools.find((tool) => tool.name === name);
}

export const codeTools: readonly AnyHubTool[] = [
  defineTool({
    name: "code_list_files",
    area: "context",
    description: "List files and folders in the folder Ensemble Code was opened in (or a subfolder). Skips .git, node_modules and build output.",
    input: z.object({ path: z.string().optional().describe("Relative to the launch folder. Default: the launch folder."), depth: z.number().int().min(1).max(4).default(2) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const code = session(ctx);
      const root = await readablePath(code, input.path);
      const lines: string[] = [];
      await walk(
        root,
        async (path, depth, isDir) => {
          lines.push(`${"  ".repeat(depth)}${basename(path)}${isDir ? "/" : ""}`);
          return lines.length >= 400;
        },
        input.depth,
      );
      return toolOk(`${shown(code, root)}: ${lines.length} entries`, { folder: shown(code, root), entries: lines.join("\n") || "(empty)" });
    },
  }),
  defineTool({
    name: "code_read_file",
    area: "context",
    description: "Read a text file in or under the launch folder (or another folder the person names). Keys and app data are never readable.",
    input: z.object({ path: z.string().min(1), fromLine: z.number().int().min(1).optional(), toLine: z.number().int().min(1).optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const code = session(ctx);
      const path = await readablePath(code, input.path);
      const info = await stat(path);
      if (info.isDirectory()) throw new ToolBlockedError(`${input.path} is a folder. Use code_list_files.`);
      if (info.size > MAX_FILE_BYTES * 8) throw new ToolBlockedError(`${input.path} is ${Math.round(info.size / 1024)} KB; read a range with fromLine and toLine, or search it.`);
      const data = await readFile(path);
      if (looksBinary(data)) throw new ToolBlockedError(`${input.path} is binary. For PDF or Office files use code_read_document.`);
      const lines = data.toString("utf8").split("\n");
      const from = input.fromLine ?? 1;
      const to = Math.min(lines.length, input.toLine ?? from + 800);
      const body = lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n");
      return toolOk(`Read ${shown(code, path)} (lines ${from}–${to} of ${lines.length})`, { path: shown(code, path), text: clip(body) });
    },
  }),
  defineTool({
    name: "code_search",
    area: "context",
    description: "Search file contents under the launch folder with a regular expression (case-insensitive). Returns file:line: text.",
    input: z.object({ pattern: z.string().min(1).max(200), path: z.string().optional(), maxResults: z.number().int().min(1).max(200).default(60) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const code = session(ctx);
      const root = await readablePath(code, input.path);
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, "i");
      } catch {
        throw new ToolBlockedError("That pattern is not a valid regular expression.");
      }
      const hits: string[] = [];
      let files = 0;
      await walk(
        root,
        async (path, _depth, isDir) => {
          if (isDir) return false;
          if ((files += 1) > 6000) return true;
          const info = await stat(path).catch(() => null);
          if (!info || info.size > MAX_FILE_BYTES) return false;
          const data = await readFile(path).catch(() => null);
          if (!data || looksBinary(data)) return false;
          const lines = data.toString("utf8").split("\n");
          for (let index = 0; index < lines.length && hits.length < input.maxResults; index += 1) {
            if (regex.test(lines[index]!)) hits.push(`${shown(code, path)}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`);
          }
          return hits.length >= input.maxResults;
        },
        8,
      );
      return toolOk(`${hits.length} match(es) for /${input.pattern}/`, { matches: hits.join("\n") || "No matches." });
    },
  }),
  defineTool({
    name: "code_read_document",
    area: "context",
    description: "Read a PDF, Word (.docx), Excel (.xlsx) or PowerPoint (.pptx) file, or any text file, as plain text.",
    input: z.object({ path: z.string().min(1) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const code = session(ctx);
      const path = await readablePath(code, input.path);
      const info = await stat(path);
      if (info.size > 40 * 1024 * 1024) throw new ToolBlockedError(`${input.path} is larger than 40 MB.`);
      const text = await documentText(path);
      return toolOk(`Read ${shown(code, path)} (${text.length} characters)`, { path: shown(code, path), text: clip(text) });
    },
  }),
  defineTool({
    name: "ensemble_start_agent",
    area: "tasks",
    description:
      "Do coding work: create a task (or use taskId) and start an agent on it in a folder on this computer, under the person's run profile. The agent (Ensemble's agent, Claude Code, Codex or Cursor's agent) edits, runs commands and commits as the profile allows, inside Ensemble's sandbox and rules; its questions go to the person. Give clear instructions. Returns the job id.",
    input: z.object({
      title: z.string().min(1).max(200).describe("The task's title, as a short imperative."),
      page: z.string().max(20_000).optional().describe("Markdown for a new task's page: context worth keeping. Not the short description, which is the person's."),
      instructions: z.string().max(8000).default("").describe("What to do, what to check, what done looks like."),
      taskId: z.string().uuid().optional().describe("An existing task instead of a new one."),
      folder: z.string().optional().describe("Default: the folder Ensemble Code was opened in."),
      repoUrl: z.string().max(500).optional().describe("Clone this repository into a fresh folder instead (https URL or owner/repo)."),
    }),
    isWrite: true,
    risk: "medium",
    outsideTransaction: true,
    async preview(ctx, input) {
      const code = session(ctx);
      const profile = pickRunProfile(ctx.settings, code.profileId);
      const where = input.repoUrl ? `a fresh clone of ${input.repoUrl}` : shown(code, resolve(code.folder, expandHome(input.folder ?? ".")));
      return `Start ${engineName(code.engine ?? profile.engine)} on “${input.title}” in ${where} (${profileLine(profile)})`;
    },
    async run(ctx, input) {
      const code = session(ctx);
      const profile = pickRunProfile(ctx.settings, code.profileId);
      const engine = code.engine ?? profile.engine;
      let taskId = input.taskId;
      if (taskId) {
        const found = await ctx.prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null }, select: { id: true } });
        if (!found) throw new ToolBlockedError("That task does not exist. Leave taskId out to create one.");
      } else {
        const task = await ctx.prisma.$transaction(async (tx) => {
          const row = await createTask(
            tx,
            ctx.userId,
            { title: input.title, owner: "agent", status: "todo", sourceRef: ctx.conversationId ? `assistant:${ctx.conversationId}` : "assistant" },
            "agent",
          );
          if (input.page?.trim()) await appendToTaskPage(tx, ctx.userId, row.id, input.page);
          return row;
        });
        taskId = task.id;
      }
      let folder: string | undefined;
      if (!input.repoUrl) {
        try {
          folder = await resolveWorkFolder(resolve(code.folder, expandHome(input.folder ?? ".")));
        } catch (error) {
          if (error instanceof GuardError) throw new ToolBlockedError(`${error.message} Ask the person for a project folder, or pass repoUrl to work in a fresh clone.`);
          throw error;
        }
      }
      const body = Assign.parse({
        taskId,
        kind: "code",
        engine,
        ...(code.runModel ? (engine === "ensemble" ? splitModel(code.runModel) : { model: code.runModel }) : profileModel(profile, engine)),
        ...(engine === "ensemble" && !code.runModel && profile.effort !== "default" ? { reasoningEffort: profile.effort } : {}),
        instructions: [profile.instructions, input.instructions].filter(Boolean).join("\n\n"),
        ...(folder ? { folder } : { repoUrl: input.repoUrl }),
        branchMode: profile.branchMode,
        delivery: profile.delivery,
        askBeforePublish: profile.askBeforePublish,
        mode: profile.mode,
        sandbox: profile.sandbox,
        network: profile.network,
        markDone: profile.markDone,
        ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
        ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
        ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
        ...(code.outsideAccess ? { outsideAccess: code.outsideAccess } : {}),
      });
      let created;
      try {
        created = await createJob(ctx.prisma, ctx.userId, body, { actor: "agent" });
      } catch (error) {
        // Trust, sandbox and engine refusals are the person's to resolve; say exactly what.
        throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
      }
      if (!created) throw new ToolBlockedError("That task does not exist.");
      return toolOk(`Started ${engineName(engine)} on “${input.title}”.`, { jobId: created.jobId, taskId, task: { id: taskId, title: input.title }, engine, profile: profile.name, folder: folder ?? null }, { invalidate: ["tasks", "workspace"] });
    },
  }),
  defineTool({
    name: "ensemble_job_status",
    area: "tasks",
    description: "How agent runs are doing: one job by id, or the latest ones. Status, progress, the summary when done, and any question waiting for the person.",
    input: z.object({ jobId: z.string().uuid().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const jobs = await ctx.prisma.workspaceJob.findMany({
        where: { userId: ctx.userId, ...(input.jobId ? { id: input.jobId } : {}) },
        orderBy: { createdAt: "desc" },
        take: input.jobId ? 1 : 8,
        include: { task: { select: { title: true } } },
      });
      if (!jobs.length) return toolOk("No agent runs yet.", { jobs: [] });
      const waiting = await ctx.prisma.agentDecision.findMany({ where: { userId: ctx.userId, status: "pending", source: "ensemble" }, select: { title: true, detail: true } });
      const rows = jobs.map((job) => ({
        jobId: job.id,
        task: job.task.title,
        engine: job.provider,
        status: job.status,
        progress: job.progress,
        summary: job.summary ? clip(job.summary, 2000) : null,
        error: job.error,
        waitingOn: waiting.filter((row) => (row.detail as { jobId?: string } | null)?.jobId === job.id).map((row) => row.title),
      }));
      return toolOk(`${rows.length} run(s)`, { jobs: rows });
    },
  }),
];

export function engineName(engine: string): string {
  return { ensemble: "Ensemble's agent", "claude-code": "Claude Code", codex: "Codex", "cursor-agent": "Cursor's agent", "copilot-cli": "GitHub Copilot" }[engine] ?? engine;
}

/** `provider::model` as the Assign body wants it. */
function splitModel(value: string): { provider?: string; model?: string } {
  const [provider, model] = value.includes("::") ? value.split("::", 2) : [undefined, value];
  return model ? { ...(provider ? { provider } : {}), model } : {};
}

function profileModel(profile: RunProfile, engine: string): { provider?: string; model?: string } {
  if (!profile.model) return {};
  return engine === "ensemble" ? splitModel(profile.model) : { model: profile.model };
}

/** What Ensemble Code is told about the session, before the person's message. */
export function codePreamble(code: CodeSession, profile: RunProfile): string {
  return [
    `You are Ensemble Code: the person's Ensemble, in their terminal on their own computer, opened in ${code.folder}.`,
    "You can read that folder (code_list_files, code_read_file, code_search, code_read_document for PDF and Office files) and work with their Ensemble (tasks, projects, notes, reminders).",
    `You never edit files or run commands yourself. For coding work, start an agent with ensemble_start_agent: it runs ${engineName(code.engine ?? profile.engine)} in the folder under the profile ${profileLine(profile)}, inside Ensemble's sandbox and rules, and its questions reach the person. Write precise instructions (what to change, how to check it, what done looks like). Use ensemble_job_status to report on runs.`,
    "Read what you need before you answer or start work; quote file paths and line numbers. Keep answers short and suited to a terminal: Markdown, short lines, code in fenced blocks.",
  ].join("\n");
}
