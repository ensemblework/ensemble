/**
 * Putting a task in an agent's hands from the chat: the same request the Assign dialog and Quick
 * assign send (`createJob`, workspace/assign.ts), under the person's run profile. A run on a paired
 * computer is queued for that computer, which checks it again against its own folders and rules
 * (docs/25). The assistant never runs commands itself.
 */
import { z } from "zod";
import { CODE_ENGINES, pickRunProfile, type RunProfile } from "@ensemble/shared-types";
import { deviceOnline, serverRunnerEnabled } from "../../devices/constants.js";
import { deviceEngines, deviceOpensPullRequests, folderLabels, repositoryLabels } from "../../devices/labels.js";
import { isPaused } from "../../lib/activity.js";
import { actorFor } from "../../sharing/context.js";
import { Assign, createJob } from "../../workspace/assign.js";
import { defineTool, toolOk, ToolBlockedError, type ToolContext } from "../types.js";
import { engineName, profileLine } from "./code.js";

const Engine = z.enum(["ensemble", ...CODE_ENGINES]);
const PAIR_A_COMPUTER = "Pair a computer first: Settings → Connected computers (/settings?tab=connections#devices), or install the desktop app or the CLI and sign in.";

type Computer = { id: string; name: string; platform: string; online: boolean; folders: string[]; repositories: string[]; engines: string[]; pullRequests: boolean };

/** The person's paired computers, most recently seen first. In a shared space, their own ones. */
async function pairedComputers(ctx: ToolContext): Promise<Computer[]> {
  const owner = actorFor(ctx.userId) ?? ctx.userId;
  const rows = await ctx.prisma.device.findMany({
    where: { userId: owner, revokedAt: null },
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
    select: { id: true, name: true, platform: true, lastSeenAt: true, capabilities: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    online: deviceOnline(row.lastSeenAt),
    folders: folderLabels(row.capabilities),
    repositories: repositoryLabels(row.capabilities),
    engines: deviceEngines(row.capabilities),
    pullRequests: deviceOpensPullRequests(row.capabilities),
  }));
}

function savedProfiles(ctx: ToolContext): { list: RunProfile[]; fallback: RunProfile } {
  return { list: ctx.settings.runProfiles, fallback: pickRunProfile(ctx.settings) };
}

/** A profile the person named (id, exact name, then a name containing the words), else their default. */
export function chooseProfile(ctx: ToolContext, wanted?: string): RunProfile {
  const { list, fallback } = savedProfiles(ctx);
  const key = wanted?.trim().toLowerCase().replace(/\s+profile$/, "");
  if (!key || key === "default") return fallback;
  const found =
    list.find((profile) => profile.id.toLowerCase() === key || profile.name.toLowerCase() === key) ??
    list.find((profile) => profile.name.toLowerCase().includes(key) || key.includes(profile.name.toLowerCase()));
  if (found) return found;
  if (key === "quick" && !list.length) return fallback;
  throw new ToolBlockedError(
    list.length ? `There is no run profile called “${wanted}”. Their profiles: ${list.map((profile) => `“${profile.name}”`).join(", ")}.` : `There are no saved run profiles yet, so “${wanted}” does not exist; the built-in Quick settings are used.`,
    "Ask which profile to use, or leave profile out for their default.",
  );
}

type Where = { deviceId?: string; computer?: Computer };

/** Where the run happens: the computer named, the profile's computer, this server when it can, else a paired computer. */
async function chooseComputer(ctx: ToolContext, profile: RunProfile, engine: z.infer<typeof Engine>, wanted?: string): Promise<Where> {
  const computers = await pairedComputers(ctx);
  const named = wanted?.trim();
  if (named && named.toLowerCase() !== "any") {
    const key = named.toLowerCase();
    const found = computers.find((row) => row.id === named || row.name.toLowerCase() === key) ?? computers.find((row) => row.name.toLowerCase().includes(key));
    if (!found) {
      throw new ToolBlockedError(
        computers.length ? `No paired computer is called “${named}”. Paired: ${computers.map((row) => `“${row.name}”`).join(", ")}.` : `No computer is paired. ${PAIR_A_COMPUTER}`,
        "Ask which computer, or use \"any\" for their usual one.",
      );
    }
    return { deviceId: found.id, computer: found };
  }
  const profiled = profile.deviceId ? computers.find((row) => row.id === profile.deviceId) : undefined;
  if (profiled) return { deviceId: profiled.id, computer: profiled };
  if (!named && serverRunnerEnabled() && engine === "ensemble") return {};
  const picked = computers.find((row) => row.online) ?? computers[0];
  if (!picked) throw new ToolBlockedError(`No computer is paired, so there is nowhere to run ${engineName(engine)}. ${PAIR_A_COMPUTER}`);
  return { deviceId: picked.id, computer: picked };
}

const AssignInput = z
  .object({
    taskId: z.string().uuid().describe("The task: from an @task mention, the open task, or hub_list_tasks."),
    profile: z.string().min(1).max(60).optional().describe("A run profile's name or id when the person names one. Leave out for their default profile."),
    computer: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("A paired computer's name or id when the person names one; \"any\" when they say to run it on their computer, laptop or machine without naming it. Leave out to follow the profile."),
    agent: Engine.optional().describe("Only when the person names who should do the work: ensemble (Ensemble's agent), claude-code, codex, cursor-agent or copilot-cli (GitHub Copilot). Leave out to follow the profile."),
    mode: z.enum(["ask", "review", "unattended"]).optional().describe("Only when the person says: ask (asks before commands), review (asks only for decisions), unattended."),
    repoUrl: z.string().max(500).optional().describe("A repository to clone and work in (https URL or owner/repo), e.g. from the task's page."),
    folder: z.string().max(200).optional().describe("One of the computer's shared folder names (hub_list_agent_options). Never a path."),
    instructions: z.string().max(6000).optional().describe("What to do, how to check it, what done looks like. The profile's own instructions are added."),
    model: z.string().max(120).optional().describe("Only when the person names a model for the agent (e.g. gpt-5.6-luna for GitHub Copilot). Leave out to follow the profile."),
    effort: z.string().max(20).optional().describe("Only when the person names a thinking level (low, medium, high, xhigh, max). Leave out to follow the profile."),
    context: z.enum(["default", "long_context"]).optional().describe("GitHub Copilot only: long_context when the person asks for the long context window."),
    branch: z.string().max(200).optional().describe("Only when the person names the branch to work on: a new branch with exactly that name (made from the pull request's base when there is one)."),
    pullRequest: z
      .object({
        base: z.string().max(200).default("").describe("The branch the pull request goes into, as the person says (any branch, e.g. testing or main). Empty: the repository's default branch."),
        merge: z.enum(["ask", "auto", "never"]).default("ask").describe("ask: open it, then ask the person on Needs me before merging; auto: merge when its checks pass (only when the person says to merge it); never: leave it open."),
      })
      .optional()
      .describe("When the person wants the work to end in a pull request Ensemble opens (and merges if they say so) after the agent finishes. Without it the agent can still push, open and merge pull requests itself when the instructions ask (git choice No limits)."),
  })
  .strict();
type AssignInput = z.infer<typeof AssignInput>;

type Plan = { title: string; profile: RunProfile; engine: z.infer<typeof Engine>; where: Where; body: z.infer<typeof Assign> };

async function plan(ctx: ToolContext, input: AssignInput): Promise<Plan> {
  const task = await ctx.prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.userId, deletedAt: null }, select: { id: true, title: true } });
  if (!task) throw new ToolBlockedError("That task is not on the board. Use the @task mention's id or hub_list_tasks.");
  const profile = chooseProfile(ctx, input.profile);
  const engine = input.agent ?? (profile.kind === "research" ? "ensemble" : profile.engine);
  const kind = engine === "ensemble" ? profile.kind : "code";
  const where = await chooseComputer(ctx, profile, engine, input.computer);
  if (input.folder && where.computer && !where.computer.folders.includes(input.folder.trim())) {
    throw new ToolBlockedError(
      `“${where.computer.name}” has no shared folder called “${input.folder}”.${where.computer.folders.length ? ` Its folders: ${where.computer.folders.map((name) => `“${name}”`).join(", ")}.` : " It has not shared any folders."}`,
      "Pass repoUrl to work in a fresh clone, or leave folder out for a fresh empty folder.",
    );
  }
  const model = profile.model.trim();
  const [provider, modelId] = model.includes("::") ? model.split("::", 2) : [undefined, model];
  const body = Assign.parse({
    taskId: task.id,
    kind,
    engine,
    ...(model && engine === profile.engine ? (engine === "ensemble" ? { ...(provider ? { provider } : {}), model: modelId } : { model }) : {}),
    ...((engine === "ensemble" || engine === "copilot-cli") && profile.effort !== "default" && engine === profile.engine ? { reasoningEffort: profile.effort } : {}),
    ...(engine === "copilot-cli" && engine === profile.engine && profile.context ? { contextTier: profile.context } : {}),
    instructions: [profile.instructions, input.instructions].filter((part) => part?.trim()).join("\n\n"),
    markDone: profile.markDone,
    network: profile.network,
    ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
    ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    ...(kind === "code"
      ? {
          branchMode: profile.branchMode,
          ...(profile.branchMode === "new" ? { branch: `ensemble/task-${task.id.slice(0, 8)}-${Date.now().toString(36)}` } : {}),
          delivery: profile.delivery,
          askBeforePublish: profile.askBeforePublish,
          mode: input.mode ?? profile.mode,
          sandbox: profile.sandbox,
          useCredentials: profile.useCredentials,
        }
      : {}),
    ...(where.deviceId ? { deviceId: where.deviceId } : {}),
    ...(input.repoUrl?.trim() ? { repoUrl: input.repoUrl.trim() } : {}),
    ...(input.folder?.trim() ? (where.deviceId ? { folderLabel: input.folder.trim() } : { folder: input.folder.trim() }) : {}),
    // What the person named in this request wins over the profile.
    ...(input.model?.trim() && engine !== "ensemble" ? { model: input.model.trim() } : {}),
    ...(input.effort?.trim() && input.effort !== "default" ? { reasoningEffort: input.effort.trim() } : {}),
    ...(input.context && engine === "copilot-cli" ? { contextTier: input.context } : {}),
    ...(kind === "code" && (input.pullRequest ?? profile.pullRequest) ? { pullRequest: input.pullRequest ?? profile.pullRequest! } : {}),
    ...(kind === "code" && input.branch?.trim() ? { branchMode: "new" as const, branch: input.branch.trim() } : {}),
  });
  return { title: task.title, profile, engine, where, body };
}

function describePlan(found: Plan): string {
  const place = found.where.computer ? `on ${found.where.computer.name}${found.where.computer.online ? "" : " (offline now: it starts when that computer is back)"}` : "on Ensemble's server";
  const work = found.body.repoUrl ? `, in a fresh clone of ${found.body.repoUrl}` : found.body.folderLabel ? `, in its “${found.body.folderLabel}” folder` : "";
  const mode = found.body.mode && found.body.mode !== found.profile.mode ? ` (mode: ${found.body.mode === "unattended" ? "Run unattended" : found.body.mode === "review" ? "Review only" : "Ask"})` : "";
  const pull = found.body.pullRequest
    ? ` · then a pull request${found.body.branch ? ` from ${found.body.branch}` : ""} into ${found.body.pullRequest.base || "the default branch"}, ${found.body.pullRequest.merge === "auto" ? "merged when its checks pass" : found.body.pullRequest.merge === "ask" ? "merged if you approve on Needs me" : "left open"}`
    : "";
  return `Assign “${found.title}” to ${engineName(found.engine)} ${place}${work} · profile ${profileLine(found.profile)}${mode}${pull}`;
}

export const agentAssignTools = [
  defineTool({
    name: "hub_list_agent_options",
    area: "tasks",
    description:
      "Before assigning a task to an agent: the person's run profiles (which one is the default, and what each allows) and their paired computers (online or not, the folder names each one shares, which of those are shared as repositories, the coding agents it can run, and the branches it opens pull requests into). Read this when they name a profile or computer, or ask what is available.",
    input: z.object({}).strict(),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const { list, fallback } = savedProfiles(ctx);
      const computers = await pairedComputers(ctx);
      const profiles = (list.length ? list : [fallback]).map((profile) => ({
        id: profile.id,
        name: profile.name,
        default: profile.id === fallback.id,
        agent: engineName(profile.kind === "research" ? "ensemble" : profile.engine),
        computer: profile.deviceId ? (computers.find((row) => row.id === profile.deviceId)?.name ?? "a computer no longer paired") : null,
        summary: profileLine(profile),
      }));
      return toolOk(`${profiles.length} run profile(s), ${computers.length} paired computer(s).`, {
        profiles,
        computers: computers.map(({ id, name, platform, online, folders, repositories, engines, pullRequests }) => ({ id, name, platform, online, folders, repositories, engines, pullRequests })),
        serverRuns: serverRunnerEnabled(),
      });
    },
  }),
  defineTool({
    name: "hub_assign_to_agent",
    area: "tasks",
    description:
      "Assign a task to an agent so it does the work: Ensemble's agent, or the person's own Claude Code, Codex, Cursor agent or GitHub Copilot on their paired computer (“do this on my machine”, “have an agent do it”, “assign it to Copilot”). Uses their default run profile unless they name one (profile), and that profile's computer unless they name one (computer; \"any\" for “my computer/laptop/machine”). Pass repoUrl when the work is in a repository named on the task, or folder when it is one the computer shares as a repository. When the person wants a pull request (“make branch A, open a PR against testing, merge it”), pass branch and pullRequest {base, merge}: Ensemble pushes the branch, opens the pull request into any branch they name and merges it (merge: auto when they say to merge it; ask to confirm on Needs me first; never to leave it open). With the profile's git choice No limits the agent itself may also commit, push any branch and open or merge pull requests; its questions reach the person. Always waits for Apply.",
    input: AssignInput,
    isWrite: true,
    risk: "medium",
    outsideTransaction: true,
    alwaysHold: true,
    async prepare(ctx, input) {
      // The preview names one computer and profile; Apply must use those, not whatever is first by then.
      const found = await plan(ctx, input);
      return { ...input, profile: found.profile.id, ...(found.where.deviceId ? { computer: found.where.deviceId } : {}) };
    },
    async preview(ctx, input) {
      return describePlan(await plan(ctx, input));
    },
    async run(ctx, input) {
      const found = await plan(ctx, input);
      if (found.body.deviceId && ctx.app.redis && (await isPaused(ctx.app.redis, ctx.userId))) {
        throw new ToolBlockedError("The agent is paused. Resume it before assigning work to a computer.");
      }
      let created;
      try {
        created = await createJob(ctx.prisma, ctx.userId, found.body, { actor: "agent" });
      } catch (error) {
        // Trust, sandbox, engine and folder refusals are the person's to resolve; say exactly what.
        throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
      }
      if (!created) throw new ToolBlockedError("That task is not on the board.");
      const place = found.where.computer ? ` on ${found.where.computer.name}` : "";
      return toolOk(
        `Assigned “${found.title}” to ${engineName(found.engine)}${place} with the “${found.profile.name}” profile.${found.where.computer && !found.where.computer.online ? " That computer is offline; the run starts when it is back." : ""}`,
        { jobId: created.jobId, taskId: found.body.taskId, agent: engineName(found.engine), computer: found.where.computer?.name ?? null, profile: found.profile.name },
        { href: `/tasks/${found.body.taskId}`, invalidate: ["tasks", "workspace"] },
      );
    },
  }),
];
