/**
 * A node's own hands on its owner's paired computer (B9, docs/35 §8.9): run a command, read git, call a
 * development server on localhost, and write, move or delete a file, without starting an agent
 * session. Each call goes to the computer as `node.tool.request` (devices/file-relay.ts), which judges it
 * by its own policy (device-tools/policy.ts: the hard floor, the owner's answers, attended or
 * unattended) and runs it under its sandbox. The first use of a folder asks the owner once in Needs me
 * (node/device-tool-decisions.ts). Only in a turn only the owner reads and started: what a command
 * prints never reaches a room with other people.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Device, NodeAgent, PrismaClient } from "@prisma/client";
import { pickRunProfile } from "@ensemble/shared-types";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext, type ToolResult } from "../assistant/types.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { openToolRun, toolRunOf, toolRunOutput } from "../devices/tool-runs.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { CodeAnswer, NODE_TOOL_FOREGROUND_MS, NODE_TOOL_MAX_SECONDS, NODE_TOOL_WRITE_BYTES, NodeToolAsk, NodeToolRequest } from "../remote/contract.js";
import { askOwner, markGrantsUsed, pendingGrants, watchDecision } from "./device-tool-decisions.js";
import { computerWorkAsks } from "./sessions.js";
import { helperFolders, helperGrant } from "./helpers.js";
import type { NodeScope } from "./tools.js";

const ASK_MS = 30_000;
/** A command's answer comes within its foreground minute, plus the way there and back. */
const RUN_ASK_MS = NODE_TOOL_FOREGROUND_MS + 25_000;
const OUTPUT_READ_BYTES = 60_000;

type Redisish = Parameters<typeof openToolRun>[0];

/** The owner's computer for a node tool: by name, else the one online; it must be new enough. */
async function toolComputer(prisma: PrismaClient, ownerId: string, name: string | undefined): Promise<Device> {
  const devices = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  if (!devices.length) throw new ToolBlockedError("Your owner has no paired computer.", "They can pair one with `ensemble login` (the Ensemble CLI) or the Ensemble desktop app.");
  const wanted = name?.trim().toLowerCase();
  const device = wanted && wanted !== "any" ? devices.find((row) => row.name.toLowerCase() === wanted || row.id === name) : devices.find((row) => deviceOnline(row.lastSeenAt));
  if (!device) throw new ToolBlockedError(wanted && wanted !== "any" ? `There is no computer called “${name}”.` : "None of your owner's computers is online.", `Their computers: ${devices.map((row) => row.name).join(", ")}.`);
  if (!deviceOnline(device.lastSeenAt)) throw new ToolBlockedError(`${device.name} is offline.`, "Ensemble must be running there (`ensemble runner start`).");
  const caps = (device.capabilities ?? {}) as { nodeTools?: unknown };
  if (typeof caps.nodeTools !== "number" || caps.nodeTools < 1) {
    throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to let a node use it directly.`, "Your owner updates it there (`ensemble update`, or the desktop app's update). Until then, have a coding agent do it (node_session_start).");
  }
  return device;
}

/** Attended unless the owner's run profile for this node runs unattended (and they did not ask this node to check first). */
async function attendedFor(prisma: PrismaClient, node: NodeAgent): Promise<{ attended: boolean; delivery: "local" | "commit" | "push"; network: boolean }> {
  const profile = pickRunProfile(await loadSettings(prisma, node.userId), node.runProfileId);
  return { attended: computerWorkAsks(node) || profile.mode !== "unattended", delivery: profile.delivery, network: profile.network };
}

/** What a "This mission" answer covers: the plan the turn works for, else this conversation (its shared or private thread). */
function missionOf(scope: NodeScope): string {
  return scope.plan?.planId ?? `conversation:${scope.room.id}:${scope.privateTo ? "private" : "shared"}`;
}

type Called = { device: Device; status: number; body: Record<string, unknown> };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** One call as a tool builds it; the node, mission, mode and answers are added on the way. */
type ToolCall = DistributiveOmit<z.input<typeof NodeToolRequest>, "id" | "nodeId" | "mission" | "attended" | "grants" | "operationId">;

/** What the ledger keeps of a call: the folder or address and the program, never what it printed. */
function ledgerOf(call: ToolCall): Record<string, string | null> {
  if (call.tool === "http") return { origin: safeOrigin(call.url) };
  if (call.tool === "run") return { folder: call.folder, program: call.command.trim().split(/\s+/)[0]?.slice(0, 60) ?? "" };
  if (call.tool === "git") return { folder: call.folder, op: call.op };
  return { folder: call.folder, action: call.action };
}

/** Sends one call to the computer and reads its answer; a call that needs the owner opens one Needs me card. */
async function callComputer(
  ctx: ToolContext,
  scope: NodeScope,
  computer: string | undefined,
  request: ToolCall,
  options: { timeoutMs: number; describe: string; before?: (device: Device) => Promise<void> },
): Promise<Called | ToolResult> {
  const { prisma, node } = scope;
  if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
  const device = await toolComputer(prisma, node.userId, computer);
  const mode = await attendedFor(prisma, node);
  const grants = await pendingGrants(prisma, node.userId, node.id, device.id);
  await options.before?.(device);
  const operationId = `${scope.turnId}:${randomUUID()}`;
  const data = { ...request, nodeId: node.id, mission: missionOf(scope), attended: mode.attended, grants, operationId } as Record<string, unknown>;
  const raw = await askDeviceFor(ctx.app.redis, { deviceId: device.id, event: "node.tool.request", data }, options.timeoutMs);
  if (!raw) throw new ToolBlockedError(`${device.name} did not answer. It may be asleep or busy; try again.`);
  const answer = CodeAnswer.safeParse(raw);
  if (!answer.success) throw new ToolBlockedError(`${device.name} sent an answer that could not be read.`);
  const body = (answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as Record<string, unknown>;
  const used = Array.isArray(body.grantsUsed) ? body.grantsUsed.filter((id): id is string => typeof id === "string") : [];
  if (used.length) await markGrantsUsed(prisma, used);
  if (answer.data.status === 428) {
    const ask = NodeToolAsk.safeParse(body.ask);
    if (!ask.success) throw new ToolBlockedError(`${device.name} asked for an answer that could not be read.`);
    const card = await askOwner(
      ctx.app,
      node.userId,
      {
        nodeId: node.id,
        nodeSlug: node.slug,
        roomId: scope.room.id,
        private: Boolean(scope.privateTo),
        planId: scope.plan?.planId ?? null,
        planStep: scope.plan?.planStep ?? null,
        mission: missionOf(scope),
        deviceId: device.id,
        deviceName: device.name,
        capability: ask.data.capability,
        target: ask.data.target,
        label: ask.data.label,
        scope: ask.data.scope,
      },
      options.describe,
      ask.data.weak,
    );
    watchDecision(ctx.app, card.id);
    const where = ask.data.scope === "origin" ? ask.data.label : `${ask.data.label} on ${device.name}`;
    return toolOk(
      card.created
        ? `Your owner is asked once in Needs me to let you use ${where}. You are woken when they answer; make the call again then. Do not ask in the chat, and reply now.`
        : `Your owner was already asked about ${where} and has not answered yet. You are woken when they do; reply now.`,
      { waitingForOwner: true, decisionId: card.id },
    );
  }
  if (answer.data.status >= 400) {
    const why = typeof body.error === "string" ? body.error : `status ${answer.data.status}`;
    throw new ToolBlockedError(`${device.name} refused: ${why}`, answer.data.status === 403 ? "That is the computer's hard floor (keys, Ensemble's own data, system folders), not a setting to work around." : undefined);
  }
  await appendLedger({ userId: node.userId, actor: "agent", action: `node.device_tool.${request.tool}`, payload: { nodeId: node.id, deviceId: device.id, ...ledgerOf(request), operationId } });
  return { device, status: answer.data.status, body };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const isResult = (value: Called | ToolResult): value is ToolResult => !("device" in value);

const Computer = z.string().max(120).optional().describe("The computer's name, when your owner has more than one.");
const Folder = z.string().min(1).max(4096).describe("A folder the computer shares with Ensemble (its label, or a path node_computer_files lists), or a project folder's full path.");

export function deviceTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  // Only where only the owner reads and the owner started the turn; a helper only with a computer grant.
  if (!scope.ownerOnly || scope.lineage.fromNonOwner) return [];
  if (node.parentNodeId && helperGrant(node) !== "computer") return [];
  const folders = node.parentNodeId ? helperFolders(node) : [];
  const redis = (ctx: ToolContext) => ctx.app.redis as unknown as Redisish;

  const tools: AnyHubTool[] = [
    defineTool({
      name: "computer_run",
      area: "tasks",
      description:
        "Run one command on your owner's computer, in a folder, yourself: tests, a build, a quick check (`npm test`, `git status`, `ls`). It runs in the computer's sandbox and changes files only in that folder. " +
        "One program and its arguments, no pipes or &&; for a shell line use `bash -c \"…\"`. Up to 900 seconds; one still going after a minute goes on in the background and you are woken when it ends. " +
        "For work that edits code or needs iteration, start an agent session instead (node_session_start). The first use of a folder may ask your owner once.",
      input: z
        .object({
          computer: Computer,
          folder: Folder,
          command: z.string().min(1).max(4000),
          cwd: z.string().max(1000).optional().describe("A subfolder to run in, inside the folder."),
          timeoutSec: z.number().int().min(1).max(NODE_TOOL_MAX_SECONDS).default(120),
          background: z.boolean().default(false).describe("true: answer at once and run in the background (a dev server, a long build); you are woken when it ends."),
          secrets: z.array(z.string().min(2).max(64)).max(20).default([]).describe("Saved secrets this command needs, by name (STRIPE_KEY): in its environment only, never shown to you."),
        })
        .strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const runId = randomUUID();
        const mode = await attendedFor(prisma, node);
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "run", folder: input.folder, cwd: input.cwd, command: input.command, timeoutSec: input.timeoutSec, background: input.background, secrets: input.secrets, runId, delivery: mode.delivery, network: mode.network },
          {
            timeoutMs: input.background ? ASK_MS : RUN_ASK_MS,
            describe: `Run: ${input.command}`,
            // Its output has somewhere to go before the computer starts it.
            before: (device) =>
              openToolRun(redis(ctx), runId, {
                deviceId: device.id,
                deviceName: device.name,
                ownerId: node.userId,
                nodeId: node.id,
                roomId: scope.room.id,
                private: Boolean(scope.privateTo),
                planId: scope.plan?.planId ?? null,
                planStep: scope.plan?.planStep ?? null,
                command: input.command.slice(0, 200),
                folder: input.folder,
                startedAt: new Date().toISOString(),
              }),
          },
        );
        if (isResult(done)) return done;
        if (done.status === 202) {
          return toolOk(`\`${input.command}\` is running in the background on ${done.device.name}. You are woken when it ends; do not wait for it. Reply now.`, { computer: done.device.name, run: runId, output: done.body.output ?? "" });
        }
        const exit = typeof done.body.exitCode === "number" ? done.body.exitCode : null;
        return toolOk(`Exit code ${exit ?? "unknown"}${done.body.timedOut ? " (stopped at its time limit)" : ""}.`, {
          computer: done.device.name,
          exitCode: exit,
          output: typeof done.body.output === "string" ? done.body.output : "",
          ms: done.body.ms,
          ...(done.body.clipped ? { run: runId, note: "The output was long: the middle is left out. Read all of it with computer_run_output." } : {}),
        });
      },
    }),
    defineTool({
      name: "computer_run_output",
      area: "tasks",
      description: "Read the output of a command you ran with computer_run that ran in the background or printed too much to show (its run id). from: where the last read stopped (its next).",
      input: z.object({ run: z.string().uuid(), from: z.number().int().min(0).max(100_000).optional() }).strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
        const run = await toolRunOf(redis(ctx), input.run);
        if (!run || run.nodeId !== node.id || run.ownerId !== node.userId) throw new ToolBlockedError("That run's output is not available (it is kept for a few hours).");
        const out = await toolRunOutput(redis(ctx), input.run, { from: input.from, maxBytes: OUTPUT_READ_BYTES });
        if (!out) throw new ToolBlockedError("That run's output is gone.");
        return toolOk(out.done ? `Ended with exit code ${out.exitCode ?? "unknown"}.` : "Still running.", { output: out.text, next: out.next, more: out.more, done: out.done, exitCode: out.exitCode });
      },
    }),
    defineTool({
      name: "computer_git",
      area: "tasks",
      description: "Read git in a folder on your owner's computer: status, diff, log, show, or the branch list. args: extra arguments (a path, a commit, -n 5). Read only; for anything that changes the repository use computer_run.",
      input: z
        .object({
          computer: Computer,
          folder: Folder,
          op: z.enum(["status", "diff", "log", "show", "branch"]),
          args: z.array(z.string().max(500)).max(20).default([]),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "git", folder: input.folder, op: input.op, args: input.args }, { timeoutMs: ASK_MS + 30_000, describe: `git ${input.op} ${input.args.join(" ")}`.trim() });
        if (isResult(done)) return done;
        return toolOk(`git ${input.op}: exit code ${done.body.exitCode ?? "unknown"}.`, { computer: done.device.name, output: done.body.output ?? "", truncated: done.body.truncated === true });
      },
    }),
    defineTool({
      name: "computer_http",
      area: "tasks",
      description: "Call a development server on your owner's computer (http://localhost:3000/…): check it answers, read a page or an API. Only this computer's own addresses; redirects elsewhere are refused. The answer is cut to 64 KB.",
      input: z
        .object({
          computer: Computer,
          url: z.string().min(1).max(2000),
          method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
          body: z.string().max(64 * 1024).optional(),
          contentType: z.string().max(200).optional(),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "http", url: input.url, method: input.method, body: input.body, contentType: input.contentType }, { timeoutMs: ASK_MS + 10_000, describe: `${input.method} ${input.url}` });
        if (isResult(done)) return done;
        return toolOk(`${input.method} ${typeof done.body.url === "string" ? done.body.url : input.url}: ${done.body.status}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_write",
      area: "tasks",
      description: "Write a text file in a folder on your owner's computer (its whole new content; at most 1 MB). Never git's own files or files of keys and secrets.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000), content: z.string().max(NODE_TOOL_WRITE_BYTES) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "write", folder: input.folder, path: input.path, content: input.content }, { timeoutMs: ASK_MS, describe: `Write ${input.path}` });
        if (isResult(done)) return done;
        return toolOk(`${done.body.created ? "Created" : "Wrote"} ${input.path}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_move",
      area: "tasks",
      description: "Move or rename a file inside a folder on your owner's computer. It never replaces a file.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000), to: z.string().min(1).max(1000) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "move", folder: input.folder, path: input.path, to: input.to }, { timeoutMs: ASK_MS, describe: `Move ${input.path} to ${input.to}` });
        if (isResult(done)) return done;
        return toolOk(`Moved ${input.path} to ${input.to}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_delete",
      area: "tasks",
      description: "Delete one file in a folder on your owner's computer (not a folder).",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "delete", folder: input.folder, path: input.path }, { timeoutMs: ASK_MS, describe: `Delete ${input.path}` });
        if (isResult(done)) return done;
        return toolOk(`Deleted ${input.path}.`, { computer: done.device.name, ...done.body });
      },
    }),
  ];
  return folders.length ? tools.map((tool) => onlyIn(tool, folders)) : tools;
}

/** A helper's tool that works only in the folders its parent named (by label, path or last part). */
function onlyIn(tool: AnyHubTool, folders: readonly string[]): AnyHubTool {
  const last = (value: string) => value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const allowed = (folder: string) => folders.some((name) => name.trim() === folder.trim() || last(name) === last(folder));
  return {
    ...tool,
    async run(ctx, input) {
      const folder = (input as { folder?: unknown } | null)?.folder;
      if (typeof folder === "string" && !allowed(folder)) {
        throw new ToolBlockedError(`You may only use ${folders.map((name) => `“${name}”`).join(", ")}.`, "Those are the folders your node gave you; report what needs another folder.");
      }
      return tool.run(ctx, input as never);
    },
  } as AnyHubTool;
}
