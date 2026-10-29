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
import { checkGit, expandHome, GuardError, harmlessPath, isNeverProgram, isRemoteProgram, outsideRefusal, within } from "../guard.js";
import { gitSubcommand } from "../clone.js";
import { parseShell } from "../shell-parse.js";
import { allowOrRefuse, askPerson, cloneForAgent, granted, outsideArgs, outsidePath, plainArgs, quietArgs, readsOnly, realOutside, WRITE_TOOL, type JobContext } from "../tools.js";
import type { ShellSegment } from "../shell-parse.js";

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
  // The run's own result and evidence (evidence/run-tools.ts): a file it attaches is judged there, as a read.
  "mcp__ensemble__report_result",
  "mcp__ensemble__attach_evidence",
  // The person's own board, in Chat only (/api/engine/tool refuses other runs): nothing outside Ensemble.
  "mcp__ensemble__ensemble_list_tasks",
  "mcp__ensemble__ensemble_search",
  "mcp__ensemble__ensemble_create_task",
  // A saved secret used by reference: the owner's allowed destinations and the run's scope decide (credentials/secret-http.ts).
  "mcp__ensemble__secret_http",
]);

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function refused(result: { result: unknown } | null): EngineAnswer {
  if (!result) return ALLOW;
  const body = result.result as { error?: string; note?: string } | undefined;
  return { decision: "deny", message: [body?.error, body?.note].filter(Boolean).join(" ") || "Not allowed in this run." };
}

/** A path outside the folder: the hard floor first, then the mode (`outsidePath`). `asked`: the person was just asked about it. */
async function outside(ctx: JobContext, path: string, write: boolean, options: { command?: string; withdrawn?: AbortSignal } = {}): Promise<EngineAnswer & { asked?: boolean }> {
  const real = await realOutside(path);
  if (harmlessPath(real) || harmlessPath(path)) return ALLOW;
  const verdict = await outsidePath(ctx, real, write, options);
  return verdict.held ? { ...refused(verdict.held), asked: verdict.asked } : { decision: "allow", asked: verdict.asked };
}

function pathsOf(input: Record<string, unknown>): string[] {
  return [str(input.file_path), str(input.path), str(input.notebook_path)].filter((value): value is string => Boolean(value));
}

/** Rough shell split: each program's argv, quotes honoured (`parseShell`). */
export function shellSegments(command: string): string[][] {
  return parseShell(command, "/").map((segment) => segment.argv).filter((argv) => argv.length > 0);
}

/**
 * A POSIX shell command whose every program only reads files in the work folder (`quietArgs`:
 * links and globs followed), writes no file and gets no `VAR=value` in front: what the person's
 * own Claude Code, Codex and Copilot run without asking. Read-only git also needs the sandbox.
 */
export async function quietCommand(root: string, parsed: ShellSegment[], sandboxed: boolean): Promise<boolean> {
  if (!parsed.some((segment) => segment.argv.length)) return false;
  for (const segment of parsed) {
    if (segment.assigned || !within(root, segment.cwd)) return false;
    if (segment.redirects.some((redirect) => redirect.write && !harmlessPath(resolve(segment.cwd, expandHome(redirect.path))))) return false;
    if (!segment.argv.length) continue;
    if (!sandboxed && segment.argv[0]!.split(/[\\/]/).pop()!.replace(/\.exe$/i, "") === "git") return false;
    if (!(await quietArgs(root, segment.argv, segment.cwd))) return false;
  }
  return true;
}

/** Ensemble runs a clone for the engine (tools.ts `cloneForAgent`); tests replace it. */
let cloneRunner: typeof cloneForAgent = cloneForAgent;
export function setCloneRunnerForTests(runner: typeof cloneForAgent | null): void {
  cloneRunner = runner ?? cloneForAgent;
}

/**
 * `posix`: a POSIX shell reads the command (Bash, not PowerShell or Windows), so its parse holds.
 * `unsandboxed`: the agent asked to run it outside its OS sandbox (Claude Code's retry after the
 * sandbox stopped a command).
 */
async function shell(ctx: JobContext, command: string, withdrawn?: AbortSignal, posix = true, unsandboxed = false): Promise<EngineAnswer> {
  const parsed = parseShell(command, ctx.root);
  const segments = parsed.map((segment) => segment.argv).filter((argv) => argv.length > 0);
  // Claude Code's sandbox does not let git write .git/config or hooks anywhere in the run folder, so a
  // clone there always fails: Ensemble clones for it instead, hooks-free (clone.ts). Only Claude Code:
  // its hook passes this answer's message to the model, while Codex and Cursor get a bare decline.
  const cloneAt = ctx.sandboxed && !unsandboxed && ctx.job.provider === "claude-code" ? segments.findIndex((argv) => gitSubcommand(argv) === "clone") : -1;
  if (cloneAt > 0) {
    return { decision: "deny", message: "Run git clone as its own command, with nothing before it: Ensemble does the clone for you, because this run's sandbox does not let git write .git/config or hooks." };
  }
  if (cloneAt === 0) {
    const cloned = await cloneRunner(ctx, segments[0]!, command);
    const rest = cloned.ok && segments.length > 1 ? " The rest of your command after the clone was not run; run it now as its own command." : "";
    return { decision: "deny", message: `${cloned.message}${rest}` };
  }
  let remote = false;
  for (const argv of segments) {
    const program = argv[0]!;
    if (isNeverProgram(program)) return { decision: "deny", message: `${program.split(/[\\/]/).pop()} is not run by agents in Ensemble (privilege, persistence or system settings).${/pkill|killall/.test(program) ? " Stop a process with kill and its process id instead." : ""}` };
    if (isRemoteProgram(program)) {
      if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
      remote = true;
    }
    // gh and git push act with the person's own GitHub sign-in on this computer; the run's mode decides
    // whether they ask first, like any command. Only the internet setting and the person's git choice can stop them.
    if (program === "gh" || program.endsWith("/gh") || program.endsWith("\\gh.exe")) {
      if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
    }
    if (program === "git" || program.endsWith("/git")) {
      const delivery = (["local", "commit", "push"].includes(ctx.job.delivery) ? ctx.job.delivery : "local") as "local" | "commit" | "push";
      try {
        const { action } = checkGit(argv, { delivery, sandboxed: ctx.sandboxed && !unsandboxed });
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
  let asked = false;
  for (const [path, write] of touched) {
    const verdict = await outside(ctx, path, write, { command, withdrawn });
    if (verdict.decision === "deny") return verdict;
    asked ||= verdict.asked === true;
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
  const noted = async (answer: EngineAnswer) => {
    if (answer.decision === "allow") {
      for (const path of new Set(writesIn)) await ctx.changes?.note(path, { folder: parsed.some((segment) => segment.cwd === path) });
    }
    return answer;
  };
  // Outside the OS sandbox: unattended goes ahead; a command whose every outside path is in a folder the
  // person already let the run work in (the reason the sandbox stopped it) goes ahead in Review only; else ask once.
  if (unsandboxed && ctx.sandboxed) {
    const explained = ctx.accessMode === "auto" && touched.size > 0 && [...touched.keys()].every((path) => granted(ctx, path));
    if (asked || explained) return noted(ALLOW);
    return noted(refused(await allowOrRefuse(ctx, "escape", true, { toolName: "Bash (outside the sandbox)", title: `Run ${command.slice(0, 120)} outside the sandbox? The sandbox stopped it.`, command }, withdrawn)));
  }
  if (remote && !asked) return noted(refused(await allowOrRefuse(ctx, "remote", true, { toolName: "Bash", title: `Run ${command.slice(0, 120)}? It connects to another computer.`, command }, withdrawn)));
  // Paths outside the folder were judged above; reading inside it asks nobody, and a command the person just approved is not asked again.
  if (asked || (posix && (await quietCommand(ctx.root, parsed, ctx.sandboxed && !unsandboxed)))) return noted(ALLOW);
  return noted(refused(await allowOrRefuse(ctx, "command", true, { toolName: "Bash", title: `Run ${command.slice(0, 140)}`, command }, withdrawn)));
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
        const verdict = await outside(ctx, full, false, { withdrawn: call.signal });
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
      const verdict = await outside(ctx, full, true, { withdrawn: call.signal });
      if (verdict.decision === "deny") return verdict;
    }
    if (inside.length || !fulls.length) {
      if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no file changes." };
      const answer = refused(await allowOrRefuse(ctx, "write", true, { toolName: WRITE_TOOL, title: `${tool} ${pathsOf(input)[0] ?? ""}`.trim(), command: pathsOf(input)[0] }, call.signal));
      if (answer.decision !== "allow") return answer;
    }
    for (const full of fulls) await ctx.changes?.note(full);
    return ALLOW;
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
    return refused(await allowOrRefuse(ctx, "network", true, { toolName: tool, title: `${tool} ${str(input.url) ?? str(input.query) ?? ""}`.trim(), command: str(input.url) ?? undefined }, call.signal));
  }
  if (SHELLS.has(tool)) {
    const command = str(input.command);
    if (!command) return ALLOW;
    return shell(ctx, command, call.signal, tool === "Bash" && process.platform !== "win32", input.dangerouslyDisableSandbox === true);
  }
  // MCP tools and anything new: the mode decides, like a command.
  if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only." };
  return refused(await allowOrRefuse(ctx, "command", true, { toolName: tool, title: `Use ${tool.replace(/^mcp__/, "").replace(/__/g, " → ")}`, command: tool }, call.signal));
}
