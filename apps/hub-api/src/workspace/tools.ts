/**
 * The agent's tools. The model sees their schemas; every call is checked here
 * again, whatever the prompt said. A refusal comes back to the model as a
 * plain result, so it can report it instead of retrying around it.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PrismaClient, WorkspaceJob } from "@prisma/client";
import { decisionBus, waitFor } from "../lib/decisions.js";
import { sseHub } from "../lib/sse.js";
import { pageText, writeAgentBlock } from "../pages/markdown.js";
import { PageDocument } from "@ensemble/shared-types";
import { githubCloneAuth } from "../lib/git-auth.js";
import { checkGit, checkProgram, expandHome, gitHardening, GuardError, jailPath, parseCommand, relativeTo, within } from "./guard.js";
import { pushRefused, runTrustedGit } from "./git-gate.js";
import { appendLive } from "./live-log.js";
import { pushRunBranch, remotePushRefused, remotePushSkipsPrompt, webPushNeedsComputer } from "./publish.js";
import { fetchUrl, searchPapers, webSearch } from "./research.js";
import { runCommand } from "./runner.js";
import { requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { commandGate, type AccessMode, type SandboxStrength } from "./trust.js";
export interface JobContext {
  prisma: PrismaClient;
  job: WorkspaceJob;
  userId: string;
  taskId: string;
  taskTitle: string;
  runId: string;
  /** Jail for files and cwd; writes are confined here when sandboxed. */
  root: string;
  sandboxed: boolean;
  network: boolean;
  signal: AbortSignal;
  commitAuthor: string;
  /** Branch the engineer picked explicitly, if any. Protected branches are only pushable when named here. */
  chosenBranch?: string;
  touched: Set<string>;
  wrotePage: boolean;
  finished: string | null;
  progress: (text: string) => Promise<void>;
  event: (kind: string, data: Record<string, unknown>) => Promise<void>;
  /** Parks the job off its slot while a person answers on Needs me. */
  waitForPerson: <T>(work: () => Promise<T>) => Promise<T>;
  /** The folder is trusted on this device (the workspace, or a saved path rule). */
  trusted: boolean;
  /** A saved path rule covers this folder, so prompts stay off even if the workspace toggle is off. */
  explicitTrust: boolean;
  /** `orchestration.runWithoutAsking`. */
  silentWorkspace: boolean;
  accessMode: AccessMode;
  /** Branch the app will fast-forward. Empty when this checkout has none. */
  runBranch: string;
  /** Paths unattended mode refused. Listed on the task summary. */
  blockedOutside: string[];
  strength: SandboxStrength;
  /** Re-reads folder trust after the person answered (an "Always" may have trusted it). */
  refreshTrust?: () => Promise<void>;
  /** Questions an unattended run answered itself. Listed on the task summary. */
  decisions?: Array<{ question: string; options: string[]; recommended: string | null }>;
  /** Working time left before the minutes limit, so one command cannot run past it. */
  remainingMs?: () => number;
}

/** Per-run answers. Kept apart from `ensemble`/`path` folder trust so a command answer can never trust a path. */
export const RUN_RULE_SOURCE = "ensemble-run";
export const WRITE_TOOL = "write";
export const OUTSIDE_TOOL = "outside";

type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

const COMMON: ToolSpec[] = [
  {
    name: "write_page",
    description:
      "Save your deliverable to the task's page as Markdown (headings, lists, tables, links). Each call replaces your previous block, so send the whole current version. The person sees it marked as agent-written.",
    parameters: { type: "object", properties: { markdown: str("The full deliverable in Markdown."), title: str("Short label for the block.") }, required: ["markdown"] },
  },
  {
    name: "ask_user",
    description:
      "Ask the person one decision question when the task is unclear or you must choose between approaches. Shows on their Needs me page and waits for the answer. Give 2–5 concrete options and name the one you recommend.",
    parameters: {
      type: "object",
      properties: {
        question: str("One clear question."),
        options: { type: "array", items: { type: "string" }, description: "2–5 short, concrete choices." },
        recommended: str("The option you recommend, written exactly as in options."),
        allow_custom: { type: "boolean", description: "Whether they may type their own answer." },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "finish",
    description: "End the task. Give a 2–5 sentence summary of what you did, what you verified, and anything left open.",
    parameters: { type: "object", properties: { summary: str("What you did and the result.") }, required: ["summary"] },
  },
];

const RESEARCH: ToolSpec[] = [
  {
    name: "search_papers",
    description: "Search academic literature (Semantic Scholar and arXiv). Returns titles, authors, year, venue, citations, abstract and link.",
    parameters: {
      type: "object",
      properties: { query: str("Topical search terms."), from_year: int("Earliest year, optional."), to_year: int("Latest year, optional."), limit: int("1–20, default 8.") },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description: "Search the web. Returns titles, links and snippets. Read a result with fetch_url before relying on it.",
    parameters: { type: "object", properties: { query: str("Search terms.") }, required: ["query"] },
  },
  {
    name: "fetch_url",
    description: "Read a public web page or paper abstract page as text.",
    parameters: { type: "object", properties: { url: str("http(s) URL.") }, required: ["url"] },
  },
];

const READ_PAGE: ToolSpec = {
  name: "read_page",
  description: "Read the task's page as it is now, including anything the person edited since you started.",
  parameters: { type: "object", properties: {} },
};

const CODE: ToolSpec[] = [
  {
    name: "list_dir",
    description: "List a folder inside the work folder. Hidden entries and node_modules are skipped.",
    parameters: { type: "object", properties: { path: str("Relative path, default '.'."), depth: int("1–4, default 2.") } },
  },
  {
    name: "read_file",
    description: "Read a text file inside the work folder. Use offset/limit (in lines) for large files.",
    parameters: { type: "object", properties: { path: str("Relative path."), offset: int("First line, 1-based."), limit: int("Number of lines, default 400.") }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file inside the work folder with the full content.",
    parameters: { type: "object", properties: { path: str("Relative path."), content: str("Full file content.") }, required: ["path", "content"] },
  },
  {
    name: "edit_file",
    description: "Replace one exact snippet in a file. old_text must appear exactly once.",
    parameters: {
      type: "object",
      properties: { path: str("Relative path."), old_text: str("Exact text to replace."), new_text: str("Replacement.") },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "run_command",
    description:
      "Run one command in the work folder, e.g. `python main.py`, `pytest -q`, `git status`, `npm test`. One program with its arguments: no pipes, redirects, &&, or shell -c. Output is returned (truncated if long).",
    parameters: {
      type: "object",
      properties: { command: str("The command line."), cwd: str("Relative folder, default '.'."), timeout_seconds: int("Default 300, max 1800.") },
      required: ["command"],
    },
  },
];

export function toolSpecs(kind: string, network: boolean): ToolSpec[] {
  if (kind === "research") return [...RESEARCH, READ_PAGE, ...COMMON];
  return [...CODE, READ_PAGE, ...(network ? RESEARCH : []), ...COMMON];
}

export const chatSpecs = (specs: ToolSpec[]) => specs.map((spec) => ({ type: "function", function: spec }));
export const responsesSpecs = (specs: ToolSpec[]) => specs.map((spec) => ({ type: "function", ...spec }));

// ── Needs me ─────────────────────────────────────────────────────────────

export async function askPerson(
  ctx: JobContext,
  input: { event: "question" | "permission"; toolName: string; title: string; options?: string[]; allowCustom?: boolean; command?: string; recommended?: string | null },
): Promise<{ decision: "allow" | "deny" | "expired"; answer: string | null }> {
  const row = await ctx.prisma.agentDecision.create({
    data: {
      userId: ctx.userId,
      source: "ensemble",
      event: input.event,
      toolName: input.toolName,
      title: input.title,
      detail: {
        options: input.options ?? [],
        allowCustom: input.allowCustom ?? false,
        recommended: input.recommended ?? null,
        command: input.command ?? null,
        input: {},
        taskId: ctx.taskId,
        taskTitle: ctx.taskTitle,
        jobId: ctx.job.id,
      },
      sessionId: ctx.job.id,
      cwd: ctx.root,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  await ctx.prisma.notification.create({
    data: { userId: ctx.userId, kind: "decision", title: `Agent needs you: ${input.title}`.slice(0, 200), body: ctx.taskTitle, urgent: true, url: "/needs-me" },
  });
  sseHub.publish(ctx.userId, { event: "decision", data: { id: row.id, status: "pending", title: input.title, source: "ensemble" } });
  await ctx.event("needs_me", { decisionId: row.id, title: input.title });
  const onAbort = () => decisionBus.emit(row.id);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const decided = await ctx.waitForPerson(async () => {
      while (!ctx.signal.aborted) {
        const current = await waitFor(row.id, 30_000);
        if (!current || current.status !== "pending") return current;
      }
      return null;
    });
    if (ctx.signal.aborted) {
      await ctx.prisma.agentDecision.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "expired" } });
      throw new DOMException("Stopped", "AbortError");
    }
    if (!decided || decided.status !== "decided") return { decision: "expired", answer: null };
    return { decision: decided.decision === "allow" ? "allow" : "deny", answer: decided.reason ?? null };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

// ── implementations ──────────────────────────────────────────────────────

/** Hooks, config and attributes inside .git would run code the next time anyone uses git here. */
function refuseGitInternals(root: string, full: string): void {
  if (relativeTo(root, full).split("/").includes(".git")) throw new GuardError("Files inside .git are off limits. Use git commands instead.");
}

function gate(ctx: JobContext, action: "command" | "write" | "network" | "credential" | "outside" | "push", inside: boolean) {
  return commandGate({
    trusted: ctx.trusted,
    silentWorkspace: ctx.silentWorkspace,
    explicitTrust: ctx.explicitTrust,
    unattended: ctx.job.unattended,
    accessMode: ctx.accessMode,
    action,
    inside,
    strength: ctx.strength,
  });
}

/** "Allow for this run" / "Deny for this run" answers, saved by the decide route. */
async function runRule(ctx: JobContext, toolName: string, command: string | undefined): Promise<"allow" | "deny" | null> {
  const rule = await ctx.prisma.decisionRule.findFirst({
    where: { userId: ctx.userId, source: RUN_RULE_SOURCE, sessionId: ctx.job.id, toolName, pattern: { in: [command ?? "*", "*"] } },
    orderBy: { createdAt: "desc" },
  });
  return rule ? (rule.decision === "deny" ? "deny" : "allow") : null;
}

function outsideArgs(root: string, args: string[]): string[] {
  const found: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || (!arg.startsWith("/") && !arg.startsWith("~"))) continue;
    const full = resolve(expandHome(arg));
    if (!within(root, full)) found.push(full);
  }
  return found;
}

async function allowOrRefuse(
  ctx: JobContext,
  action: "command" | "write" | "network" | "credential" | "outside" | "push",
  inside: boolean,
  prompt: { toolName: string; title: string; command?: string },
): Promise<{ ok: false; result: unknown; summary: string } | null> {
  const decision = gate(ctx, action, inside);
  if (decision === "allow") {
    if (ctx.job.unattended && (action === "push" || action === "write" || action === "command")) {
      await ctx.event("unattended", { action, command: prompt.command ?? prompt.title });
    }
    return null;
  }
  if (decision === "block") {
    const target = prompt.command ?? prompt.title;
    const readOnly = ctx.accessMode === "review" && action !== "outside";
    if (!readOnly) ctx.blockedOutside.push(target);
    return {
      ok: false,
      result: {
        error: readOnly
          ? `Blocked. This run is read-only: no file changes and no network. ${target}`
          : `Blocked. Nobody approves commands in this run, so it stays inside the trusted folder. ${target}`,
        refused: true,
        note: "This is the run's setting. Do not try another route; mention it in your summary.",
      },
      summary: readOnly ? "Blocked: read-only run" : "Blocked outside the trusted folder",
    };
  }
  const saved = await runRule(ctx, prompt.toolName, prompt.command);
  if (saved === "allow") return null;
  if (saved === "deny") {
    return { ok: false, result: { error: "The person denied this for the rest of the run.", refused: true }, summary: "Not allowed (this run)" };
  }
  await ctx.progress(`Waiting for approval: ${prompt.title.slice(0, 80)}`);
  const answer = await askPerson(ctx, { event: "permission", toolName: prompt.toolName, title: prompt.title, command: prompt.command });
  await ctx.refreshTrust?.();
  if (answer.decision === "allow") return null;
  return {
    ok: false,
    result: { error: `The person did not allow this.${answer.answer ? ` They said: ${answer.answer}` : ""}`, refused: true },
    summary: "Not allowed",
  };
}

async function listDir(root: string, path: string, depth: number): Promise<string> {
  const start = await jailPath(root, path, true);
  const lines: string[] = [];
  const walk = async (dir: string, level: number) => {
    if (lines.length > 400) return;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (["node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      lines.push(`${"  ".repeat(level)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && level + 1 < depth) await walk(full, level + 1);
    }
  };
  await walk(start, 0);
  return lines.length ? lines.join("\n") + (lines.length > 400 ? "\n…" : "") : "(empty)";
}

export async function runTool(ctx: JobContext, name: string, raw: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; summary: string }> {
  await requireVerifiedUser(ctx.userId);
  if (["list_dir", "read_file", "write_file", "edit_file", "apply_patch", "run_command", "git"].includes(name)) {
    await requireHostAccess(ctx.userId, "Workspace filesystem and commands");
  }
  const s = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const n = (key: string, fallback: number) => (typeof raw[key] === "number" ? (raw[key] as number) : fallback);
  // A tool the model was not given (no network, a research job) is refused even if it names it.
  if (ctx.job && !toolSpecs(ctx.job.kind, ctx.network).some((spec) => spec.name === name)) {
    return { ok: false, result: { error: `${name} is not available in this run.`, refused: true }, summary: `Refused: ${name} is not available` };
  }
  try {
    switch (name) {
      case "search_papers": {
        await ctx.progress(`Searching papers: ${s("query")}`);
        const found = await searchPapers(s("query"), { limit: n("limit", 8), fromYear: raw.from_year as number | undefined, toYear: raw.to_year as number | undefined, signal: ctx.signal });
        return { ok: true, result: found, summary: `${found.papers.length} papers for “${s("query")}”` };
      }
      case "web_search": {
        await ctx.progress(`Searching the web: ${s("query")}`);
        const hits = await webSearch(s("query"), ctx.signal);
        return { ok: true, result: { results: hits }, summary: `${hits.length} results for “${s("query")}”` };
      }
      case "fetch_url": {
        await ctx.progress(`Reading ${s("url").slice(0, 80)}`);
        const page = await fetchUrl(s("url"), ctx.signal);
        return { ok: true, result: page, summary: `Read ${page.title || page.url}` };
      }
      case "read_page": {
        const task = await ctx.prisma.task.findFirst({ where: { id: ctx.taskId }, select: { notes: true, page: true } });
        const doc = task?.page?.content ? PageDocument.parse(task.page.content) : null;
        return { ok: true, result: { page: pageText(doc, task?.notes ?? "").slice(0, 20_000) }, summary: "Read the page" };
      }
      case "write_page": {
        const markdown = s("markdown").trim();
        if (!markdown) return { ok: false, result: { error: "markdown is empty." }, summary: "Empty write" };
        await ctx.progress("Writing to the page");
        await writeAgentBlock(ctx.prisma, ctx.userId, ctx.taskId, markdown, { jobId: ctx.job.id, runId: ctx.runId, model: ctx.job.model, title: s("title") });
        ctx.wrotePage = true;
        return { ok: true, result: { saved: true, chars: markdown.length }, summary: `Wrote ${markdown.length} characters to the page` };
      }
      case "ask_user": {
        const options = Array.isArray(raw.options) ? (raw.options as unknown[]).map(String).slice(0, 6) : [];
        const recommended = options.includes(s("recommended")) ? s("recommended") : null;
        if (ctx.job?.unattended) {
          ctx.decisions?.push({ question: s("question").slice(0, 300), options, recommended });
          await ctx.event("decision", { question: s("question").slice(0, 300), options, recommended });
          return {
            ok: true,
            result: {
              answer: recommended,
              unattended: true,
              note: "This run is unattended: nobody will answer. Go with the option you recommend, continue, and list this decision and why in your finish summary under “Decisions I made”.",
            },
            summary: "Unattended: chose the recommended option",
          };
        }
        await ctx.progress("Waiting for your answer on Needs me");
        const answer = await askPerson(ctx, { event: "question", toolName: "Question", title: s("question").slice(0, 300), options, allowCustom: raw.allow_custom !== false, recommended });
        await ctx.progress("Got an answer, continuing");
        if (answer.decision === "deny") return { ok: true, result: { answer: null, note: "The person skipped this question. Make a reasonable choice, and say which in your summary." }, summary: "Question skipped" };
        if (answer.decision === "expired") return { ok: true, result: { answer: null, note: "No answer. Make a reasonable choice and state it." }, summary: "No answer" };
        return { ok: true, result: { answer: answer.answer }, summary: `Answer: ${answer.answer ?? "(none)"}` };
      }
      case "finish": {
        ctx.finished = s("summary").trim() || "Done.";
        return { ok: true, result: { finished: true }, summary: "Finished" };
      }
      case "list_dir": {
        const listing = await listDir(ctx.root, s("path") || ".", Math.min(Math.max(n("depth", 2), 1), 4));
        return { ok: true, result: { listing }, summary: `Listed ${s("path") || "."}` };
      }
      case "read_file": {
        const full = await jailPath(ctx.root, s("path"), true);
        const info = await stat(full);
        if (info.size > 4_000_000) return { ok: false, result: { error: "File is over 4 MB." }, summary: "Too large" };
        const lines = (await readFile(full, "utf8")).split("\n");
        const offset = Math.max(n("offset", 1), 1);
        const limit = Math.min(Math.max(n("limit", 400), 1), 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}|${line}`).join("\n");
        return { ok: true, result: { path: s("path"), totalLines: lines.length, content: slice }, summary: `Read ${s("path")}` };
      }
      case "write_file": {
        const full = await jailPath(ctx.root, s("path"));
        const allowed = await allowOrRefuse(ctx, "write", true, { toolName: WRITE_TOOL, title: `Write ${s("path")}`, command: s("path") });
        if (allowed) return allowed;
        refuseGitInternals(ctx.root, full);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, s("content"));
        ctx.touched.add(relativeTo(ctx.root, full));
        await ctx.progress(`Wrote ${s("path")}`);
        return { ok: true, result: { written: s("path"), bytes: Buffer.byteLength(s("content")) }, summary: `Wrote ${s("path")}` };
      }
      case "edit_file": {
        const full = await jailPath(ctx.root, s("path"), true);
        const allowed = await allowOrRefuse(ctx, "write", true, { toolName: WRITE_TOOL, title: `Edit ${s("path")}`, command: s("path") });
        if (allowed) return allowed;
        refuseGitInternals(ctx.root, full);
        const text = await readFile(full, "utf8");
        const count = text.split(s("old_text")).length - 1;
        if (!s("old_text") || count !== 1) {
          return { ok: false, result: { error: count === 0 ? "old_text was not found. Read the file again." : `old_text appears ${count} times. Include more context.` }, summary: "Edit did not apply" };
        }
        await writeFile(full, text.replace(s("old_text"), s("new_text")));
        ctx.touched.add(relativeTo(ctx.root, full));
        await ctx.progress(`Edited ${s("path")}`);
        return { ok: true, result: { edited: s("path") }, summary: `Edited ${s("path")}` };
      }
      case "run_command":
        return await command(ctx, s("command"), s("cwd") || ".", Math.min(Math.max(n("timeout_seconds", 300), 5), 1800));
      default:
        return { ok: false, result: { error: `There is no tool called ${name}.` }, summary: `Unknown tool ${name}` };
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
    const message = error instanceof Error ? error.message : String(error);
    const refused = error instanceof GuardError;
    return { ok: false, result: { error: message, ...(refused ? { refused: true, note: "This is Ensemble's policy. Do not try to work around it; mention it in your summary." } : {}) }, summary: refused ? `Refused: ${message}` : `Failed: ${message}` };
  }
}

async function currentBranch(ctx: JobContext): Promise<string> {
  const result = await runCommand({
    userId: ctx.userId,
    argv: ["git", ...gitHardening(false), "rev-parse", "--abbrev-ref", "HEAD"],
    cwd: ctx.root,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: false,
    useCredentials: false,
    who: "agent",
    timeoutMs: 15_000,
    signal: ctx.signal,
    group: ctx.job.id,
  });
  return result.output.trim();
}

/**
 * git with the person's sign-in runs outside the sandbox. Only `fetch` and
 * `pull --ff-only` of a remote name and branch names are allowed: no options
 * such as `--upload-pack` that run a program, and no paths that leave the folder.
 */
export function credentialGitRefusal(args: string[]): string | null {
  const [sub, ...rest] = args;
  if (sub === "clone") return "Ensemble clones the repository when the run starts. Work in this folder.";
  if (sub !== "fetch" && sub !== "pull") return `git ${sub} is not run with your sign-in.`;
  const allowed = sub === "pull" ? new Set(["--ff-only", "--quiet", "-q"]) : new Set(["--quiet", "-q", "--prune", "--tags"]);
  if (sub === "pull" && !rest.includes("--ff-only")) return "With your sign-in, pull only as git pull --ff-only.";
  for (const arg of rest) {
    if (arg.startsWith("-")) {
      if (!allowed.has(arg)) return `git ${sub} ${arg} is not allowed with your sign-in.`;
      continue;
    }
    if (!/^[A-Za-z0-9._/-]+(:[A-Za-z0-9._/-]+)?$/.test(arg) || arg.includes("..") || arg.startsWith("/")) return `“${arg}” is not a remote or branch name.`;
  }
  return null;
}

/** Branch and tag tips, for spotting commits a script made behind the run's back. Null when the folder is not a repository. */
async function refTips(ctx: JobContext): Promise<Map<string, string> | null> {
  if (!(await stat(join(ctx.root, ".git")).then(() => true).catch(() => false))) return null;
  const result = await runCommand({
    userId: ctx.userId,
    argv: ["git", ...gitHardening(false), "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"],
    cwd: ctx.root,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: false,
    useCredentials: false,
    who: "agent",
    timeoutMs: 15_000,
    signal: ctx.signal,
    group: ctx.job.id,
  });
  if (result.exitCode !== 0) return null;
  const tips = new Map<string, string>();
  for (const line of result.output.split("\n")) {
    const [ref, sha] = line.trim().split(" ");
    if (ref && sha && /^[0-9a-f]{7,64}$/.test(sha)) tips.set(ref, sha);
  }
  return tips;
}

async function ownGit(ctx: JobContext, args: string[]) {
  return runCommand({
    userId: ctx.userId,
    argv: ["git", ...gitHardening(false), ...args],
    cwd: ctx.root,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: false,
    useCredentials: false,
    who: "agent",
    readWrite: [ctx.root],
    timeoutMs: 15_000,
    signal: ctx.signal,
    group: ctx.job.id,
  });
}

/**
 * The git permission holds for commits any program makes, not only `git commit`
 * typed by the agent: a script or a test runner can commit too. When the run may
 * not commit (Local only), or every commit needs the person's approval, a new
 * commit found after a command is undone. The ref moves back; the files stay,
 * uncommitted. Returns the note for the model, or null when nothing was undone.
 */
export async function undoUnapprovedCommits(ctx: JobContext, before: Map<string, string> | null): Promise<string | null> {
  if (!before) return null;
  const after = await refTips(ctx);
  if (!after) return null;
  const moved = [...after].filter(([ref, sha]) => before.get(ref) !== sha);
  if (!moved.length) return null;
  const fresh = await ownGit(ctx, ["rev-list", "--count", ...moved.map(([, sha]) => sha), "--not", ...new Set(before.values())]);
  const count = Number(fresh.output.trim());
  if (fresh.exitCode !== 0 || !Number.isFinite(count) || count === 0) return null;
  for (const [ref] of moved) {
    const old = before.get(ref);
    await ownGit(ctx, old ? ["update-ref", ref, old] : ["update-ref", "-d", ref]);
  }
  await ctx.event("commit_undone", { refs: moved.map(([ref]) => ref), commits: count });
  return ctx.job.delivery === "local"
    ? "That command created a commit, and this run may not commit (Local only). Ensemble undid the commit; the changes are still in the folder, uncommitted."
    : "That command created a commit without the person's approval, and every commit in this run needs it. Ensemble undid the commit; the changes are still in the folder. Commit with `git commit` so the person can approve it.";
}

async function command(ctx: JobContext, line: string, cwdInput: string, timeoutSeconds: number) {
  const left = ctx.remainingMs?.();
  if (left !== undefined) timeoutSeconds = Math.max(5, Math.min(timeoutSeconds, Math.floor(left / 1000)));
  const argv = parseCommand(line);
  const program = checkProgram(argv, { who: "agent", sandboxed: ctx.sandboxed, network: ctx.network });
  const outside = outsideArgs(ctx.root, argv);
  if (outside.length) {
    const held = await allowOrRefuse(ctx, "outside", false, {
      toolName: OUTSIDE_TOOL,
      title: `Use a path outside the folder?`,
      command: outside[0],
    });
    if (held) return held;
  }
  let full = argv;
  let watch: Map<string, string> | null = null;
  if (program === "git") {
    const delivery = (["local", "commit", "push"].includes(ctx.job.delivery) ? ctx.job.delivery : "local") as "local" | "commit" | "push";
    const { sub, action } = checkGit(argv, { delivery, branch: ctx.chosenBranch, runBranch: ctx.runBranch || undefined, who: "agent" });
    if ((action === "network" || action === "push") && !ctx.network) throw new GuardError(`git ${sub} needs network access, which is off for this job.`);
    if (action === "push") {
      const branch = await currentBranch(ctx);
      const refused = pushRefused(branch, ctx.job.id, Boolean(ctx.job.continueFromJobId));
      if (refused) throw new GuardError(refused);
      const gated = await remotePushRefused(ctx.prisma, ctx.job);
      if (gated) throw new GuardError(gated);
      const pushGate = gate(ctx, "push", true);
      const decision = pushGate === "allow" && webPushNeedsComputer(ctx.job) ? "prompt" : pushGate;
      if (decision === "block") {
        return { ok: false, result: { error: "Blocked. This run is read-only, so it does not push.", refused: true }, summary: "Push blocked" };
      }
      const silent = decision === "allow" || (await remotePushSkipsPrompt(ctx.prisma, ctx.job, branch, ctx.trusted));
      if (!silent) {
        const answer = await askPerson(ctx, { event: "permission", toolName: "git push", title: `Push ${branch} (fast-forward only)`, command: line });
        if (answer.decision !== "allow") {
          return { ok: false, result: { error: `The person did not allow the push.${answer.answer ? ` They said: ${answer.answer}` : ""}`, refused: true }, summary: "Push not allowed" };
        }
      } else if (ctx.job.unattended) {
        await ctx.event("unattended", { action: "push", command: line });
      }
      const pushed = await pushRunBranch({ prisma: ctx.prisma, userId: ctx.userId, job: ctx.job, root: ctx.root, branch, timeoutMs: timeoutSeconds * 1000 });
      await ctx.event("command", { command: `git push ${pushed.remote} HEAD:refs/heads/${branch}`, cwd: ".", exitCode: pushed.exitCode, tail: pushed.output.slice(-3000), by: "app" });
      return {
        ok: pushed.exitCode === 0,
        result: { exitCode: pushed.exitCode, output: pushed.output },
        summary: `push ${branch} (fast-forward) → exit ${pushed.exitCode}`,
      };
    }
    if (action === "commit" && ctx.job.askBeforePublish && !ctx.job.unattended) {
      // "Ask me before each commit" means each one, trusted folder or not. No "for this run" shortcut.
      await ctx.progress(`Waiting for approval: commit`);
      const answer = await askPerson(ctx, { event: "permission", toolName: "git commit", title: `Commit in ${ctx.root.split("/").slice(-2).join("/")}`, command: line });
      await ctx.refreshTrust?.();
      if (answer.decision !== "allow") {
        return { ok: false, result: { error: `The person did not approve this commit.${answer.answer ? ` They said: ${answer.answer}` : ""} Leave the changes uncommitted.`, refused: true }, summary: "Commit not approved" };
      }
    } else if (action !== "read") {
      // Anything that changes the folder or the repository follows the run's mode, like any command.
      const held = await allowOrRefuse(ctx, "command", true, { toolName: "git", title: `Run ${line.slice(0, 140)}`, command: line });
      if (held) return held;
    }
    if (action === "network" && ctx.job.useCredentials) {
      // These run outside the sandbox with the person's sign-in, so the agent picks no options and no paths.
      const unsafe = credentialGitRefusal(argv.slice(1));
      if (unsafe) throw new GuardError(unsafe);
      const remote = argv.find((arg) => /github\.com|gitlab\.com/i.test(arg)) || ctx.job.repoUrl || "https://github.com/";
      const auth = await githubCloneAuth(ctx.prisma, ctx.userId, remote);
      const ran = await runTrustedGit({
        userId: ctx.userId,
        cwd: await jailPath(ctx.root, cwdInput, true),
        args: argv.slice(1),
        credentialEnv: auth.env,
        credentialConfig: auth.config,
        timeoutMs: timeoutSeconds * 1000,
      });
      await ctx.event("command", { command: line, exitCode: ran.exitCode, tail: ran.output.slice(-3000), by: "app" });
      return { ok: ran.exitCode === 0, result: { exitCode: ran.exitCode, output: ran.output }, summary: `${line.slice(0, 80)} → exit ${ran.exitCode}` };
    }
    full = ["git", ...gitHardening(false, ctx.commitAuthor || "Ensemble Agent <agent@ensemble.local>"), ...argv.slice(1)];
  } else {
    const held = await allowOrRefuse(ctx, "command", true, { toolName: program, title: `Run ${line.slice(0, 140)}`, command: line });
    if (held) return held;
    const guarded = ctx.job.delivery === "local" || (ctx.job.askBeforePublish && !ctx.job.unattended);
    if (guarded && ctx.accessMode !== "review") watch = await refTips(ctx);
  }
  const cwd = await jailPath(ctx.root, cwdInput, true);
  await ctx.progress(`Running: ${line.slice(0, 100)}`);
  const review = ctx.accessMode === "review";
  const result = await runCommand({
    userId: ctx.userId,
    onChunk: (text) => appendLive(ctx.job.id, text),
    argv: full,
    cwd,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: ctx.network && !review,
    useCredentials: false,
    who: "agent",
    readOnly: review ? [ctx.root] : [],
    readWrite: review ? [] : [ctx.root],
    timeoutMs: timeoutSeconds * 1000,
    signal: ctx.signal,
    group: ctx.job.id,
  });
  if (result.killed || ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
  const undone = await undoUnapprovedCommits(ctx, watch);
  await ctx.event("command", { command: line, cwd: relativeTo(ctx.root, cwd), exitCode: result.exitCode, ms: result.ms, timedOut: result.timedOut, tail: result.output.slice(-3000) });
  const output = result.output.length > 16_000 ? `${result.output.slice(0, 6000)}\n…[${result.output.length - 12_000} characters omitted]…\n${result.output.slice(-6000)}` : result.output;
  return {
    ok: result.exitCode === 0,
    result: { exitCode: result.exitCode, output, ...(result.timedOut ? { note: `Timed out after ${timeoutSeconds}s and was stopped.` } : {}), ...(undone ? { commitUndone: undone } : {}) },
    summary: `${line.slice(0, 80)} → exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${undone ? " · commit undone" : ""}`,
  };
}
