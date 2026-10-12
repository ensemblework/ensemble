/**
 * The Code tab, read only: its folders and the agent changes waiting for review.
 *
 * The assistant looks; it never edits code. Changing code is the person's editor (through
 * Ensemble's MCP, docs/CONTEXT_BRIDGE.md) or an agent run the person assigns. Both tools follow
 * the Code module and the same host-access gate as /api/code (`lib/hosted-access.ts`).
 */
import { z } from "zod";
import { hasModule } from "@ensemble/shared-types";
import { env } from "../../config.js";
import { usableCodeRoots } from "../../lib/code-folders.js";
import { discoverRepos } from "../../lib/git.js";
import { HostedAccessError, requireHostAccess } from "../../lib/hosted-access.js";
import { loadSettings } from "../../lib/settings.js";
import { expandHome } from "../../workspace/guard.js";
import { defineTool, toolOk, ToolBlockedError, type ToolContext } from "../types.js";

const LOOK_ONLY =
  "Look only: to change code, the person's editor works through Ensemble's MCP, or the person assigns the task to an agent.";
const FOLDERS_SETTING = "/settings?tab=data#jump-terminal-folders-code-can-use";

async function codeAccess(ctx: ToolContext): Promise<void> {
  if (ctx.modules !== undefined && !hasModule(ctx.modules, "code")) {
    throw new ToolBlockedError("The Code feature is off in this space.", "Turn it on in Settings → Account → Features (/settings?tab=account#jump-feature-code).");
  }
  try {
    await requireHostAccess(ctx.userId, "Code filesystem");
  } catch (error) {
    if (error instanceof HostedAccessError) throw new ToolBlockedError(error.message, "Code runs on the person's own computer: the desktop app or a paired computer.");
    throw error;
  }
}

export const workspaceTools = [
  defineTool({
    name: "hub_list_code_folders",
    area: "context",
    description: `The Code tab's folders (Settings → Folders Code can use, the Ensemble workspace, agent checkouts) and the git repositories in them, with a link to review each one's uncommitted changes. ${LOOK_ONLY}`,
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      await codeAccess(ctx);
      const settings = await loadSettings(ctx.prisma, ctx.userId);
      const saved = await usableCodeRoots(settings, ctx.userId);
      const workspace = expandHome(env.ENSEMBLE_WORKSPACE_ROOT);
      const jobs = await ctx.prisma.workspaceJob.findMany({
        where: { userId: ctx.userId, repoPath: { not: "" } },
        orderBy: { createdAt: "desc" },
        distinct: ["repoPath"],
        take: 10,
        select: { repoPath: true },
      });
      const checkouts = jobs.map((job) => job.repoPath).filter((path) => path !== workspace && !saved.includes(path));
      const repos = await discoverRepos([workspace, ...saved, ...checkouts]);
      const data = {
        folders: [...saved.map((path) => ({ path, kind: "Code folder" })), { path: workspace, kind: "Ensemble workspace" }],
        agentCheckouts: checkouts,
        repositories: repos.slice(0, 30).map((path) => ({ path, link: `/code/review?repo=${encodeURIComponent(path)}` })),
        ...(repos.length > 30 ? { moreRepositories: repos.length - 30 } : {}),
        addFolders: FOLDERS_SETTING,
      };
      const none = saved.length ? "" : " No Code folders are saved yet; the person adds them in Settings.";
      return toolOk(`${saved.length} Code folder(s), ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}.${none}`, data, { href: "/code#local-repositories" });
    },
  }),
  defineTool({
    name: "hub_list_agent_changes",
    area: "context",
    description: `Code → Agent changes: files agent runs changed that wait for the person to accept or reject (status waiting), or were already reviewed. Each has a link to review it. ${LOOK_ONLY}`,
    input: z.object({
      status: z.enum(["waiting", "reviewed", "all"]).default("waiting"),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      await codeAccess(ctx);
      const where = {
        userId: ctx.userId,
        expiredAt: null,
        ...(input.status === "waiting" ? { completedAt: null } : input.status === "reviewed" ? { completedAt: { not: null } } : {}),
      };
      const [reviews, total] = await Promise.all([
        ctx.prisma.codeReview.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit,
          select: {
            id: true,
            repoPath: true,
            agentPaths: true,
            createdAt: true,
            completedAt: true,
            expiresAt: true,
            job: { select: { branch: true, model: true, runId: true, task: { select: { id: true, title: true } } } },
          },
        }),
        ctx.prisma.codeReview.count({ where }),
      ]);
      const rows = reviews.map((review) => ({
        id: review.id,
        task: review.job.task,
        folder: review.repoPath,
        ...(review.job.branch ? { branch: review.job.branch } : {}),
        model: review.job.model,
        files: review.agentPaths.length,
        status: review.completedAt ? "reviewed" : "waiting",
        created: review.createdAt.toISOString(),
        expires: review.expiresAt.toISOString(),
        ...(review.job.runId ? { runId: review.job.runId } : {}),
        link: `/code/review?review=${review.id}`,
      }));
      const what = input.status === "waiting" ? "waiting for review" : input.status === "reviewed" ? "already reviewed" : "in all";
      return toolOk(rows.length ? `${total} agent change(s) ${what}.` : `No agent changes ${what}.`, { changes: rows, total }, { href: "/code#reviews" });
    },
  }),
];
