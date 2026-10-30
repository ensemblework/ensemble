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
import { BROWSER_API, CodeAnswer, NODE_TOOL_FOREGROUND_MS, NODE_TOOL_MAX_SECONDS, NODE_TOOL_WRITE_BYTES, NodeCaptureAnswer, NodeToolAsk, NodeToolRequest } from "../remote/contract.js";
import { BROWSER_TOOLS } from "../browser/tool-specs.js";
import { CAPTURE_TOOLS } from "../capture/tool-specs.js";
import { grantUpload } from "../evidence/grants.js";
import { postPreviewCard } from "../evidence/held.js";
import { postLoginCard } from "./logins.js";
import { askOwner, markGrantsUsed, pendingGrants, watchDecision } from "./device-tool-decisions.js";
import { computerWorkAsks } from "./sessions.js";
import { helperFolders, helperGrant } from "./helpers.js";
import type { NodeScope } from "./tools.js";

const ASK_MS = 30_000;
/** A command's answer comes within its foreground minute, plus the way there and back. */
const RUN_ASK_MS = NODE_TOOL_FOREGROUND_MS + 25_000;
const OUTPUT_READ_BYTES = 60_000;

type Redisish = Parameters<typeof openToolRun>[0];

/** The owner's computer for a node tool: by name, else the one online; it must be new enough (and, for the browser and capture tools, have them). */
async function toolComputer(prisma: PrismaClient, ownerId: string, name: string | undefined, need?: { browser: string }): Promise<Device> {
  const devices = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  if (!devices.length) throw new ToolBlockedError("Your owner has no paired computer.", "They can pair one with `ensemble login` (the Ensemble CLI) or the Ensemble desktop app.");
  const wanted = name?.trim().toLowerCase();
  const device = wanted && wanted !== "any" ? devices.find((row) => row.name.toLowerCase() === wanted || row.id === name) : devices.find((row) => deviceOnline(row.lastSeenAt));
  if (!device) throw new ToolBlockedError(wanted && wanted !== "any" ? `There is no computer called “${name}”.` : "None of your owner's computers is online.", `Their computers: ${devices.map((row) => row.name).join(", ")}.`);
  if (!deviceOnline(device.lastSeenAt)) throw new ToolBlockedError(`${device.name} is offline.`, "Ensemble must be running there (`ensemble runner start`).");
  const caps = (device.capabilities ?? {}) as { nodeTools?: unknown; browser?: unknown; logins?: unknown; capture?: { browser?: unknown } | null };
  if (typeof caps.nodeTools !== "number" || caps.nodeTools < 1) {
    throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to let a node use it directly.`, "Your owner updates it there (`ensemble update`, or the desktop app's update). Until then, have a coding agent do it (node_session_start).");
  }
  if (need) {
    if (typeof caps.browser !== "number" || caps.browser < BROWSER_API) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to browse or capture for a node.`, "Your owner updates it there (`ensemble update`, or the desktop app's update).");
    }
    if (need.browser === "browser_login_needed" && (typeof caps.logins !== "number" || caps.logins < 1)) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to hand a sign-in to your owner.`, "Your owner updates it there (`ensemble update`, or the desktop app's update), or signs in by hand in the browser there.");
    }
    if (caps.capture?.browser === false && need.browser !== "capture_status") {
      throw new ToolBlockedError(`${device.name} has no browser for Ensemble yet.`, "Your owner runs `ensemble capture setup` there once; it installs one. capture_status says what else that computer can capture.");
    }
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
  if (call.tool === "browser" || call.tool === "capture") return { name: call.name, origin: typeof call.input?.url === "string" ? safeOrigin(call.input.url) : null };
  if (call.tool === "http" || call.tool === "secret_http") return { origin: safeOrigin(call.url) };
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
  options: { timeoutMs: number; describe: string; before?: (device: Device) => Promise<void | Record<string, unknown>>; need?: { browser: string } },
): Promise<Called | ToolResult> {
  const { prisma, node } = scope;
  if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
  const device = await toolComputer(prisma, node.userId, computer, options.need);
  const mode = await attendedFor(prisma, node);
  const grants = await pendingGrants(prisma, node.userId, node.id, device.id);
  const extra = (await options.before?.(device)) ?? {};
  const operationId = `${scope.turnId}:${randomUUID()}`;
  const data = { ...request, ...extra, nodeId: node.id, mission: missionOf(scope), attended: mode.attended, grants, operationId } as Record<string, unknown>;
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
    ...captureTools(scope),
  ];
  return folders.length ? tools.map((tool) => onlyIn(tool, folders)) : tools;
}

/**
 * The node's tool operation for the browser and capture tools: one per node and mission (or
 * conversation), so its tabs and apps last across its turns there.
 */
export function captureOperation(scope: Pick<NodeScope, "node" | "plan" | "room" | "privateTo">): string {
  return `node:${scope.node.id}:${missionOf(scope as NodeScope).replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 200)}`;
}

/** How long a call may take on the computer: a video for its length, every call for its upload. */
function captureTimeout(name: string, input: Record<string, unknown>): number {
  const seconds = typeof input.durationSec === "number" ? Math.min(input.durationSec, 600) : 0;
  return name === "capture_video" ? 120_000 + seconds * 2_000 : name === "capture_app_start" ? 90_000 : 75_000;
}

/** A small result the node reads besides the summary (checks, a status, apps); a page's snapshot is in its summary. */
function smallResult(result: unknown): Record<string, unknown> {
  if (result === undefined) return {};
  const text = JSON.stringify(result);
  return text.length <= 8_000 ? { result } : {};
}

/**
 * The browser and capture tools (B10, B19) on the owner's computer, for this node: the same tools a
 * coding agent's run has, through `node.tool.request` (device-tools/capture.ts on the computer). What
 * they capture is the node's own evidence; a capture the computer holds waits for the owner's
 * preview card.
 */
function captureTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  const specs = [...BROWSER_TOOLS, ...CAPTURE_TOOLS] as ReadonlyArray<{ name: string; description: string; input: z.ZodTypeAny }>;
  return specs.map((spec) =>
    defineTool({
      name: spec.name,
      area: "tasks",
      description: `On your owner's computer: ${spec.description} What it captures is evidence you can show (node_show) once it was checked (capture_check); a capture the computer holds waits for your owner's preview.`,
      input: (spec.input as z.AnyZodObject).extend({ computer: Computer }),
      isWrite: false,
      risk: spec.name === "capture_app_start" || spec.name === "browser_type" || spec.name === "browser_upload" ? "medium" : "low",
      async run(ctx, raw) {
        const { computer, ...input } = raw as Record<string, unknown> & { computer?: string };
        const tool = spec.name.startsWith("browser_") ? ("browser" as const) : ("capture" as const);
        const operation = captureOperation(scope);
        const mode = await attendedFor(prisma, node);
        const done = await callComputer(
          ctx,
          scope,
          computer,
          { tool, name: spec.name, input, operation, uploadId: "pending", network: mode.network },
          {
            timeoutMs: captureTimeout(spec.name, input),
            describe: typeof input.url === "string" ? `Open ${input.url}` : spec.name === "capture_app_start" ? `Start ${String(input.command ?? "the app")} in ${String(input.cwd ?? "")}` : spec.name,
            need: { browser: spec.name },
            // Its files have somewhere to go before the computer makes them.
            before: async (device) => ({ uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) }),
          },
        );
        if (isResult(done)) return done;
        const answer = NodeCaptureAnswer.safeParse(done.body);
        if (!answer.success) throw new ToolBlockedError(`${done.device.name} sent an answer that could not be read.`);
        const { ok, summary, result, error, evidence, refused, login } = answer.data;
        const main = evidence.filter((item) => !item.variantOf);
        const held = main.filter((item) => item.held);
        if (held.length) {
          const rows = await prisma.jobEvidence.findMany({ where: { id: { in: held.map((item) => item.id) }, userId: node.userId } });
          await postPreviewCard(ctx.app, {
            ownerId: node.userId,
            nodeId: node.id,
            roomId: scope.room.id,
            rows,
            operation,
            planId: scope.plan?.planId ?? null,
            planStep: scope.plan?.planStep ?? null,
            rootMessageId: scope.lineage.rootMessageId,
            private: Boolean(scope.privateTo),
          });
        }
        const lines = [
          ok ? (summary ?? "Done.") : `It did not work: ${error?.message ?? "the tool failed"}`,
          main.filter((item) => !item.held).length ? `Kept as your evidence (show with node_show after checking it): ${main.filter((item) => !item.held).map((item) => `${item.kind} “${item.name}” [${item.id}]${item.local ? " (kept on the computer: evidence upload is off there)" : ""}`).join("; ")}.` : "",
          held.length ? `Held for your owner to preview first, on a card in this chat (nothing is shown or sent until they release it): ${held.map((item) => `“${item.name}”: ${item.holdReason ?? "not checked"}`).join("; ")}.` : "",
          refused.length ? `Not kept: ${refused.map((item) => `“${item.name}”: ${item.reason}`).join("; ")}.` : "",
        ].filter(Boolean);
        if (!ok) throw new ToolBlockedError(lines.join("\n"));
        // The tab waits for the owner to sign in (B11): one owner-only card; the node is woken when it ends.
        if (login) {
          const card = await postLoginCard(ctx.app, {
            ownerId: node.userId,
            node,
            roomId: scope.room.id,
            device: done.device,
            login,
            operation,
            planId: scope.plan?.planId ?? null,
            planStep: scope.plan?.planStep ?? null,
            rootMessageId: scope.lineage.rootMessageId,
            private: Boolean(scope.privateTo),
          });
          lines.push(`Your owner is asked on a card in this chat to sign in to ${login.origin} on ${done.device.name}. You are woken when they have (or chose not to). Do not ask in the chat, and reply now, briefly.`);
          return toolOk(lines.join("\n"), { computer: done.device.name, waitingForOwner: true, decisionId: card.id, signIn: { origin: login.origin, tab: login.tab } });
        }
        return toolOk(lines.join("\n"), { computer: done.device.name, evidence: main.map((item) => ({ id: item.id, name: item.name, kind: item.kind, held: item.held })), ...smallResult(result) });
      },
    }),
  );
}

/** A helper's tool that works only in the folders its parent named (by label, path or last part); an app it starts for capture too. */
function onlyIn(tool: AnyHubTool, folders: readonly string[]): AnyHubTool {
  const last = (value: string) => value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const allowed = (folder: string) => folders.some((name) => name.trim() === folder.trim() || last(name) === last(folder));
  return {
    ...tool,
    async run(ctx, input) {
      // An app started for capture runs in its folder, as a command does.
      const given = input as { folder?: unknown; cwd?: unknown } | null;
      const folder = tool.name === "capture_app_start" ? given?.cwd : given?.folder;
      if (typeof folder === "string" && !allowed(folder)) {
        throw new ToolBlockedError(`You may only use ${folders.map((name) => `“${name}”`).join(", ")}.`, "Those are the folders your node gave you; report what needs another folder.");
      }
      return tool.run(ctx, input as never);
    },
  } as AnyHubTool;
}
