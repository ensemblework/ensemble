/**
 * Judging a tool call from another coding agent (Claude Code, and later ACP
 * agents) by the run's own rules: the mode (Ask, Review only, Run unattended),
 * folder trust, the sandbox's outside-path rule, the git permission and the
 * internet setting. The same rules Ensemble's own agent follows
 * (`tools.ts`, `trust.ts`); this only translates the other agent's tool names.
 *
 * A refusal goes back to that agent as the tool's answer, with a reason, so
 * it carries on (no run is ended because one call was refused). Anything that
 * needs the person becomes a Needs me card, answerable from the app, the web,
 * the phone or `ensemble needs`.
 */
import { resolve } from "node:path";
import { checkGit, expandHome, GuardError, isNeverProgram, outsideRefusal, within } from "../guard.js";
import { allowOrRefuse, askPerson, OUTSIDE_TOOL, outsideArgs, readsOnly, realOutside, WRITE_TOOL, type JobContext } from "../tools.js";

export type EngineCall = { tool: string; input: Record<string, unknown> };
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
  const floor = outsideRefusal(real, write);
  if (floor) return { decision: "deny", message: `${real}: ${floor}` };
  if (write && ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no file changes." };
  return refused(await allowOrRefuse(ctx, "outside", false, { toolName: OUTSIDE_TOOL, title: `${write ? "Change" : "Read"} ${real}, outside the folder?`, command: real, write }));
}

function pathsOf(input: Record<string, unknown>): string[] {
  return [str(input.file_path), str(input.path), str(input.notebook_path)].filter((value): value is string => Boolean(value));
}

/** Rough shell split: enough to see each program, its git subcommand, and path-looking arguments. */
export function shellSegments(command: string): string[][] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((segment) =>
      (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
        .map((token) => token.replace(/^["']|["']$/g, ""))
        .filter((token) => !/^\w+=/.test(token) || token.includes("/")),
    )
    .filter((argv) => argv.length > 0);
}

async function shell(ctx: JobContext, command: string): Promise<EngineAnswer> {
  const segments = shellSegments(command);
  for (const argv of segments) {
    const program = argv[0]!;
    if (isNeverProgram(program)) return { decision: "deny", message: `${program} is not allowed in Ensemble runs (privilege, persistence or remote access).` };
    if (program === "git" || program.endsWith("/git")) {
      const delivery = (["local", "commit", "push"].includes(ctx.job.delivery) ? ctx.job.delivery : "local") as "local" | "commit" | "push";
      try {
        const { action } = checkGit(argv, { delivery, branch: ctx.chosenBranch, runBranch: ctx.runBranch || undefined, who: "agent" });
        if (action === "push") return { decision: "deny", message: "Don't push. Ensemble pushes this run's branch for you when the run finishes (Commit + push), with your sign-in." };
        if (action === "network" && !ctx.network) return { decision: "deny", message: "The internet is off for this run." };
        if (action === "commit" && ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no commits." };
        if (action === "commit" && ctx.job.askBeforePublish && !ctx.job.unattended) {
          const answer = await askPerson(ctx, { event: "permission", toolName: "git commit", title: `Commit in ${ctx.root.split(/[\\/]/).slice(-2).join("/")}`, command });
          if (answer.decision !== "allow") return { decision: "deny", message: `The person did not approve this commit.${answer.answer ? ` They said: ${answer.answer}` : ""} Leave the changes uncommitted.` };
          return ALLOW;
        }
      } catch (error) {
        if (error instanceof GuardError) return { decision: "deny", message: error.message };
        throw error;
      }
    }
  }
  const paths: string[] = [];
  for (const argv of segments) for (const path of outsideArgs(ctx.root, argv)) if (!paths.includes(path)) paths.push(path);
  // Reading outside the folder (cat, ls, grep, git log…) is not writing it.
  const writes = !segments.every((argv) => readsOnly(argv));
  for (const path of paths) {
    const verdict = await outside(ctx, path, writes);
    if (verdict.decision === "deny") return verdict;
  }
  return refused(await allowOrRefuse(ctx, "command", true, { toolName: "Bash", title: `Run ${command.slice(0, 140)}`, command }));
}

/**
 * Claude Code's multiple-choice questions. Unattended: the agent's
 * recommended option (Claude marks it "(Recommended)"; else the first) is
 * taken and listed on the task summary. Otherwise each question is a Needs me
 * card with the same options and a typed answer.
 */
async function questions(ctx: JobContext, input: Record<string, unknown>): Promise<EngineAnswer> {
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
    const answer = await askPerson(ctx, { event: "question", toolName: "question", title: question, options, allowCustom: true, recommended });
    if (answer.decision !== "allow" || !answer.answer) return { decision: "deny", message: "The person did not answer this question. Make a sensible choice, say which in your summary, and continue." };
    answers[question] = answer.answer;
  }
  return { decision: "allow", updatedInput: { ...input, answers } };
}

export async function judgeEngineCall(ctx: JobContext, call: EngineCall): Promise<EngineAnswer> {
  const { tool, input } = call;
  if (tool === "AskUserQuestion") return questions(ctx, input);
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
    const paths = pathsOf(input);
    for (const path of paths) {
      const full = resolve(ctx.root, expandHome(path));
      if (!within(ctx.root, full)) return outside(ctx, full, true);
      if (full.split(/[\\/]/).includes(".git")) return { decision: "deny", message: "Files inside .git are off limits. Use git commands instead." };
    }
    if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only: no file changes." };
    return refused(await allowOrRefuse(ctx, "write", true, { toolName: WRITE_TOOL, title: `${tool} ${paths[0] ?? ""}`.trim(), command: paths[0] }));
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    if (!ctx.network) return { decision: "deny", message: "The internet is off for this run." };
    return refused(await allowOrRefuse(ctx, "network", true, { toolName: tool, title: `${tool} ${str(input.url) ?? str(input.query) ?? ""}`.trim(), command: str(input.url) ?? undefined }));
  }
  if (SHELLS.has(tool)) {
    const command = str(input.command);
    if (!command) return ALLOW;
    return shell(ctx, command);
  }
  // MCP tools and anything new: the mode decides, like a command.
  if (ctx.accessMode === "review") return { decision: "deny", message: "This run is read-only." };
  return refused(await allowOrRefuse(ctx, "command", true, { toolName: tool, title: `Use ${tool.replace(/^mcp__/, "").replace(/__/g, " → ")}`, command: tool }));
}
