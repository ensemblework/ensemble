/**
 * Judging a tool call from another coding agent (Claude Code, and later ACP
 * agents) by the run's own rules: the mode (Ask, Review only, Run unattended),
 * folder trust, the sandbox's outside-path rule, the person's git choice and the
 * internet setting. The same rules Ensemble's own agent follows
 * (`tools.ts`, `trust.ts`); this only translates the other agent's tool names.
 *
 * A refusal goes back to that agent as the tool's answer, with a reason, so
 * it carries on (no run is ended because one call was refused). Anything that
 * needs the person becomes a Needs me card, answerable from the app, the web,
 * the phone or `ensemble needs`.
 */
import { resolve } from "node:path";
import { checkGit, expandHome, GuardError, harmlessPath, isNeverProgram, outsideRefusal, within } from "../guard.js";
import { gitSubcommand } from "../clone.js";
import { parseShell } from "../shell-parse.js";
import { allowOrRefuse, askPerson, cloneForAgent, OUTSIDE_TOOL, outsideArgs, plainArgs, readsOnly, realOutside, WRITE_TOOL, type JobContext } from "../tools.js";

/** `signal` aborts when the agent stops waiting for this answer (its call timed out or was cancelled): a question it asked is withdrawn. */
export type EngineCall = { tool: string; input: Record<string, unknown>; signal?: AbortSignal };
export type EngineAnswer = { decision: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> };

const ALLOW: EngineAnswer = { decision: "allow" };
const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
/** Bookkeeping tools that touch nothing outside the agent itself. */
const HARMLESS = new Set([
  "TodoWrite", "TodoRead", "Task", "Agent", "ExitPlanMode", "BashOutput", "KillShell", "KillBash", "Skill", "SlashCommand", "ToolSearch",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  // Ensemble's own question tool: the question itself is judged when the tool asks (as AskUserQuestion).
  "mcp__ensemble__ask_person",
  // The person's own board, in Chat only (/api/engine/tool refuses other runs): nothing outside Ensemble.
  "mcp__ensemble__ensemble_list_tasks",
  "mcp__ensemble__ensemble_search",
  "mcp__ensemble__ensemble_create_task",
]);

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function refused(result: { result: unknown } | null): EngineAnswer {
  if (!result) return ALLOW;
  const body = result.result as { error?: string; note?: string } | undefined;
  return { decision: "deny", message: [body?.error, body?.note].filter(Boolean).join(" ") || "Not allowed in this run." };
}

/** A path outside the folder: the hard floor first, then the mode and sandbox (`commandGate`). */
async function outside(ctx: JobContext, path: string, write: boolean): Promise<EngineAnswer> {
  const real = await realOutside(path);
  if (harmlessPath(real) || harmlessPath(path)) return ALLOW;
  const floor = outsideRefusal(real, write);
  if (floor) return { decision: "deny", message: `${real}: ${floor}` };
  if (write && ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no file changes." };
  return refused(await allowOrRefuse(ctx, "outside", false, { toolName: OUTSIDE_TOOL, title: `${write ? "Change" : "Read"} ${real}, outside the folder?`, command: real, write }));
}

function pathsOf(input: Record<string, unknown>): string[] {
  return [str(input.file_path), str(input.path), str(input.notebook_path)].filter((value): value is string => Boolean(value));
}

/** Rough shell split: each program's argv, quotes honoured (`parseShell`). */
export function shellSegments(command: string): string[][] {
  return parseShell(command, "/").map((segment) => segment.argv).filter((argv) => argv.length > 0);
}

/** Ensemble runs a clone for the engine (tools.ts `cloneForAgent`); tests replace it. */
let cloneRunner: typeof cloneForAgent = cloneForAgent;
export function setCloneRunnerForTests(runner: typeof cloneForAgent | null): void {
  cloneRunner = runner ?? cloneForAgent;
}

async function shell(ctx: JobContext, command: string, withdrawn?: AbortSignal): Promise<EngineAnswer> {
  const parsed = parseShell(command, ctx.root);
  const segments = parsed.map((segment) => segment.argv).filter((argv) => argv.length > 0);
  // Claude Code's sandbox does not let git write .git/config or hooks anywhere in the run folder, so a
  // clone there always fails: Ensemble clones for it instead, hooks-free (clone.ts). Only Claude Code:
  // its hook passes this answer's message to the model, while Codex and Cursor get a bare decline.
  const cloneAt = ctx.sandboxed && ctx.job.provider === "claude-code" ? segments.findIndex((argv) => gitSubcommand(argv) === "clone") : -1;
  if (cloneAt > 0) {
    return { decision: "deny", message: "Run git clone as its own command, with nothing before it: Ensemble does the clone for you, because this run's sandbox does not let git write .git/config or hooks." };
  }
  if (cloneAt === 0) {
    const cloned = await cloneRunner(ctx, segments[0]!, command);
    const rest = cloned.ok && segments.length > 1 ? " The rest of your command after the clone was not run; run it now as its own command." : "";
    return { decision: "deny", message: `${cloned.message}${rest}` };
  }
  for (const argv of segments) {
    const program = argv[0]!;
    if (isNeverProgram(program)) return { decision: "deny", message: `${program.split(/[\\/]/).pop()} is not run by agents in Ensemble (privilege, persistence, the keychain or remote shells).${/pkill|killall/.test(program) ? " Stop a process with kill and its process id instead." : ""}` };
    // gh and git push act with the person's own GitHub sign-in on this computer; the run's mode decides
    // whether they ask first, like any command. Only the internet setting and the person's git choice can stop them.
    if (program === "gh" || program.endsWith("/gh") || program.endsWith("\\gh.exe")) {
      if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
    }
    if (program === "git" || program.endsWith("/git")) {
      const delivery = (["local", "commit", "push"].includes(ctx.job.delivery) ? ctx.job.delivery : "local") as "local" | "commit" | "push";
      try {
        const { action } = checkGit(argv, { delivery, sandboxed: ctx.sandboxed });
        if ((action === "network" || action === "push") && !ctx.network) return { decision: "deny", message: "The internet is off for this run." };
        if ((action === "commit" || action === "push") && ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no commits or pushes." };
        if (action === "commit" && ctx.job.askBeforePublish && !ctx.job.unattended) {
          const answer = await askPerson(ctx, { event: "permission", toolName: "git commit", title: `Commit in ${ctx.root.split(/[\\/]/).slice(-2).join("/")}`, command }, withdrawn);
          if (answer.decision !== "allow") return { decision: "deny", message: `The person did not approve this commit.${answer.answer ? ` They said: ${answer.answer}` : ""} Leave the changes uncommitted.` };
          return ALLOW;
        }
      } catch (error) {
        if (error instanceof GuardError) return { decision: "deny", message: error.message };
        throw error;
      }
    }
  }
  // Every path a program names or a redirect writes, resolved in the folder that program runs in.
  const touched = new Map<string, boolean>();
  const mark = (path: string, write: boolean) => touched.set(path, (touched.get(path) ?? false) || write);
  const writesIn: string[] = [];
  for (const segment of parsed) {
    const writes = segment.argv.length > 0 && !readsOnly(segment.argv);
    for (const path of segment.argv.length ? outsideArgs(ctx.root, segment.argv, segment.cwd) : []) mark(path, writes);
    if (writes && !within(ctx.root, segment.cwd)) mark(segment.cwd, true);
    if (writes) writesIn.push(segment.cwd);
    for (const redirect of segment.redirects) {
      const full = resolve(segment.cwd, expandHome(redirect.path));
      if (harmlessPath(full)) continue;
      if (redirect.write) writesIn.push(full);
      if (!within(ctx.root, full)) mark(full, redirect.write);
    }
  }
  for (const [path, write] of touched) {
    const verdict = await outside(ctx, path, write);
    if (verdict.decision === "deny") return verdict;
  }
  // In a folder outside the run's (`cd ~ && cat .ssh/id_rsa`), any plain argument can name a file there:
  // each is held to the hard floor. The mode was already asked about that folder itself.
  for (const segment of parsed) {
    if (!segment.argv.length || within(ctx.root, segment.cwd)) continue;
    const writes = !readsOnly(segment.argv);
    for (const arg of plainArgs(segment.argv)) {
      const real = await realOutside(resolve(segment.cwd, arg));
      const floor = within(ctx.root, real) || harmlessPath(real) ? null : outsideRefusal(real, writes);
      if (floor) return { decision: "deny", message: `${real}: ${floor}` };
    }
  }
  const answer = refused(await allowOrRefuse(ctx, "command", true, { toolName: "Bash", title: `Run ${command.slice(0, 140)}`, command }));
  if (answer.decision === "allow") {
    for (const path of new Set(writesIn)) await ctx.changes?.note(path, { folder: parsed.some((segment) => segment.cwd === path) });
  }
  return answer;
}

/**
 * Claude Code's multiple-choice questions. Unattended: the agent's
 * recommended option (Claude marks it "(Recommended)"; else the first) is
 * taken and listed on the task summary. Otherwise each question is a Needs me
 * card with the same options and a typed answer.
 */
async function questions(ctx: JobContext, input: Record<string, unknown>, withdrawn?: AbortSignal): Promise<EngineAnswer> {
  const list = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const answers: Record<string, string> = {};
  for (const item of list) {
    const question = str(item.question);
    if (!question) continue;
    const options = (Array.isArray(item.options) ? item.options : [])
      .map((option) => (option && typeof option === "object" ? str((option as { label?: unknown }).label) : null))
      .filter((label): label is string => Boolean(label));
    const recommended = options.find((label) => /\(recommended\)/i.test(label)) ?? options[0] ?? null;
    if (ctx.job.unattended) {
      if (!recommended) return { decision: "deny", message: "Nobody is watching this run. Decide yourself and list the decision in your summary." };
      answers[question] = recommended;
      ctx.decisions?.push({ question, options, recommended });
      await ctx.event("decision", { question, options, recommended, by: "unattended" });
      continue;
    }
    await ctx.progress(`Waiting for your answer: ${question.slice(0, 80)}`);
    const answer = await askPerson(ctx, { event: "question", toolName: "question", title: question, options, allowCustom: true, recommended }, withdrawn);
    if (answer.decision !== "allow" || !answer.answer) return { decision: "deny", message: "The person did not answer this question. Make a sensible choice, say which in your summary, and continue." };
    answers[question] = answer.answer;
  }
  return { decision: "allow", updatedInput: { ...input, answers } };
}

export async function judgeEngineCall(ctx: JobContext, call: EngineCall): Promise<EngineAnswer> {
  const { tool, input } = call;
  if (tool === "AskUserQuestion") return questions(ctx, input, call.signal);
  if (HARMLESS.has(tool)) return ALLOW;
  if (READS.has(tool)) {
    for (const path of pathsOf(input)) {
      const full = resolve(ctx.root, expandHome(path));
      if (!within(ctx.root, full)) {
        const verdict = await outside(ctx, full, false);
        if (verdict.decision === "deny") return verdict;
      }
    }
    return ALLOW;
  }
  if (WRITES.has(tool)) {
    const fulls = pathsOf(input).map((path) => resolve(ctx.root, expandHome(path)));
    const inside = fulls.filter((full) => within(ctx.root, full));
    for (const full of fulls) {
      if (within(ctx.root, full)) {
        if (full.split(/[\\/]/).includes(".git")) return { decision: "deny", message: "Files inside .git are off limits. Use git commands instead." };
        continue;
      }
      const verdict = await outside(ctx, full, true);
      if (verdict.decision === "deny") return verdict;
    }
    if (inside.length || !fulls.length) {
      if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no file changes." };
      const answer = refused(await allowOrRefuse(ctx, "write", true, { toolName: WRITE_TOOL, title: `${tool} ${pathsOf(input)[0] ?? ""}`.trim(), command: pathsOf(input)[0] }));
      if (answer.decision !== "allow") return answer;
    }
    for (const full of fulls) await ctx.changes?.note(full);
    return ALLOW;
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
    return refused(await allowOrRefuse(ctx, "network", true, { toolName: tool, title: `${tool} ${str(input.url) ?? str(input.query) ?? ""}`.trim(), command: str(input.url) ?? undefined }));
  }
  if (SHELLS.has(tool)) {
    const command = str(input.command);
    if (!command) return ALLOW;
    return shell(ctx, command, call.signal);
  }
  // MCP tools and anything new: the mode decides, like a command.
  if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only." };
  return refused(await allowOrRefuse(ctx, "command", true, { toolName: tool, title: `Use ${tool.replace(/^mcp__/, "").replace(/__/g, " → ")}`, command: tool }));
}
