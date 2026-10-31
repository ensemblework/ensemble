/**
 * A node's own hands on its owner's paired computer (B9, docs/35 §8.9): run a command, read git, call a
 * development server on localhost, write, move or delete a file, take a screenshot of a terminal, bring
 * a file into the chat, run a command as the administrator, and browse and capture, without starting an
 * agent session. Each call goes to the computer as `node.tool.request` (devices/file-relay.ts), which
 * judges it by its own policy (device-tools/policy.ts: the hard floor, the owner's answers, attended or
 * unattended) and runs it under its sandbox. A call without a folder works in the node's own folder on
 * the computer (nodeTools 2). The first use of a folder asks the owner once, on a card in this chat
 * (node/device-tool-decisions.ts): the call waits for the answer and goes on by itself. Public web pages
 * need no answer unless the owner asks before browsing. Only in a turn only the owner reads and
 * started: what a command prints never reaches a room with other people.
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
import { truncateText } from "../lib/text.js";
import { BROWSER_API, LOGIN_CHECKS_API, CodeAnswer, NODE_TOOL_FOREGROUND_MS, NODE_TOOL_MAX_SECONDS, NODE_TOOL_WRITE_BYTES, NODE_TOOLS_OWN_FOLDER, NodeCaptureAnswer, NodeToolAsk, NodeToolRequest, WEB_TOOLS } from "../remote/contract.js";
import { BROWSER_TOOLS } from "../browser/tool-specs.js";
import { CAPTURE_TOOLS } from "../capture/tool-specs.js";
import { dangerousCommand, dangerousMessage, needsAdministrator } from "../device-tools/dangerous.js";
import { grantUpload } from "../evidence/grants.js";
import { postPreviewCard } from "../evidence/held.js";
import { postLoginCard } from "./logins.js";
import { nodeSaveFileTool } from "../assistant/tools/save-file.js";
import { askOwner, awaitAnswer, computerCard, markGrantsUsed, noticeAsked, ownerName, pendingGrants, permissionWaitMs, placeOf, waitForOwner, watchDecision } from "./device-tool-decisions.js";
import { computerWorkAsks } from "./sessions.js";
import { helperFolders, helperGrant } from "./helpers.js";
import { ownerMedia, rememberCaptured, shownKinds } from "./media.js";
import { requestPark } from "./queue.js";
import { askSudo } from "./sudo.js";
import { ENSEMBLE_IN_BROWSER, ensembleAppOrigin } from "../lib/ensemble-origins.js";
import type { NodeScope } from "./tools.js";

const ASK_MS = 30_000;
/** A command's answer comes within its foreground minute, plus the way there and back. */
const RUN_ASK_MS = NODE_TOOL_FOREGROUND_MS + 25_000;
const OUTPUT_READ_BYTES = 60_000;
/** One call asks its owner at most this often (each answer covers one folder or address). */
const MAX_ASKS = 3;
/** What a terminal screenshot's screen gives the node as text. */
const SCREEN_CHARS = 8_000;

type Redisish = Parameters<typeof openToolRun>[0];

/** What a call needs of the computer: the browser and capture tools (by tool name), or a nodeTools 2 feature (what it lets the node do there). */
type Need = { browser?: string; ownFolder?: string };

const nodeToolsOf = (device: Pick<Device, "capabilities">): number => {
  const value = (device.capabilities as { nodeTools?: unknown } | null)?.nodeTools;
  return typeof value === "number" ? value : 0;
};

/** The owner's computer for a node tool: by name, else the one online; it must be new enough (and, for the browser and capture tools, have them). */
async function toolComputer(prisma: PrismaClient, ownerId: string, name: string | undefined, need?: Need): Promise<Device> {
  const devices = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  if (!devices.length) throw new ToolBlockedError("Your owner has no paired computer.", "They can pair one with `ensemble login` (the Ensemble CLI) or the Ensemble desktop app.");
  const wanted = name?.trim().toLowerCase();
  const device = wanted && wanted !== "any" ? devices.find((row) => row.name.toLowerCase() === wanted || row.id === name) : devices.find((row) => deviceOnline(row.lastSeenAt));
  if (!device) throw new ToolBlockedError(wanted && wanted !== "any" ? `There is no computer called “${name}”.` : "None of your owner's computers is online.", `Their computers: ${devices.map((row) => row.name).join(", ")}.`);
  if (!deviceOnline(device.lastSeenAt)) throw new ToolBlockedError(`${device.name} is offline.`, "Ensemble must be running there (`ensemble runner start`).");
  const caps = (device.capabilities ?? {}) as { nodeTools?: unknown; browser?: unknown; logins?: unknown; capture?: { browser?: unknown } | null };
  if (nodeToolsOf(device) < 1) {
    throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to let a node use it directly.`, "Your owner updates it there (`ensemble update`, or the desktop app's update). Until then, have a coding agent do it (node_session_start).");
  }
  if (need?.ownFolder && nodeToolsOf(device) < NODE_TOOLS_OWN_FOLDER) {
    throw new ToolBlockedError(`Update Ensemble on ${device.name} (\`ensemble update\`, or the desktop app's update) to ${need.ownFolder}.`, "Your owner updates it there; tell them in one line if it matters now.");
  }
  if (need?.browser) {
    if (typeof caps.browser !== "number" || caps.browser < 1) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to browse or capture for a node.`, "Your owner updates it there (`ensemble update`, or the desktop app's update).");
    }
    if (WEB_TOOLS.includes(need.browser) && caps.browser < BROWSER_API) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name} to use ${need.browser}: it is too old for it.`, "Your owner updates it there (`ensemble update`, or the desktop app's update). Until then use browser_open and browser_screenshot.");
    }
    if (need.browser === "browser_login_needed" && (typeof caps.logins !== "number" || caps.logins < 1)) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to hand a sign-in to your owner.`, "Your owner updates it there (`ensemble update`, or the desktop app's update), or signs in by hand in the browser there.");
    }
    if (need.browser === "browser_login_check" && (typeof caps.logins !== "number" || caps.logins < LOGIN_CHECKS_API)) {
      throw new ToolBlockedError(`Update Ensemble on ${device.name} to check a sign-in from here.`, "Their card in this chat still works: your owner presses I'm done there, and you are woken when they are signed in.");
    }
    if (caps.capture?.browser === false && need.browser !== "capture_status") {
      throw new ToolBlockedError(`${device.name} has no browser for Ensemble yet.`, "Your owner runs `ensemble capture setup` there once; it installs one. capture_status says what else that computer can capture.");
    }
  }
  return device;
}

type Mode = { attended: boolean; delivery: "local" | "commit" | "push"; network: boolean; askBeforeBrowsing: boolean };

/** Attended unless the owner's run profile for this node runs unattended (and they did not ask this node to check first); whether they ask before browsing. */
async function modeFor(prisma: PrismaClient, node: NodeAgent): Promise<Mode> {
  const settings = await loadSettings(prisma, node.userId);
  const profile = pickRunProfile(settings, node.runProfileId);
  return { attended: computerWorkAsks(node) || profile.mode !== "unattended", delivery: profile.delivery, network: profile.network, askBeforeBrowsing: settings.node.askBeforeBrowsing };
}

/** What a "This mission" answer covers: the plan the turn works for, else this conversation (its shared or private thread). */
function missionOf(scope: Pick<NodeScope, "plan" | "room" | "privateTo">): string {
  return scope.plan?.planId ?? `conversation:${scope.room.id}:${scope.privateTo ? "private" : "shared"}`;
}

type Called = { device: Device; status: number; body: Record<string, unknown> };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** One call as a tool builds it; the node, mission, mode and answers are added on the way. */
type ToolCall = DistributiveOmit<z.input<typeof NodeToolRequest>, "id" | "nodeId" | "mission" | "attended" | "grants" | "operationId" | "nodeSlug">;

/** What the ledger keeps of a call: the folder or address and the program, never what it printed. */
function ledgerOf(call: ToolCall): Record<string, string | null> {
  if (call.tool === "browser" || call.tool === "capture") return { name: call.name, origin: typeof call.input?.url === "string" ? safeOrigin(call.input.url) : null };
  if (call.tool === "http" || call.tool === "secret_http") return { origin: safeOrigin(call.url) };
  if (call.tool === "run" || call.tool === "terminal" || call.tool === "sudo") return { folder: call.folder ?? null, program: call.command.trim().split(/\s+/)[0]?.slice(0, 60) ?? "", ...(call.tool === "sudo" ? { sudo: "yes" } : {}) };
  if (call.tool === "git") return { folder: call.folder ?? null, op: call.op };
  return { folder: call.folder ?? null, action: call.action };
}

/** The call exactly as the node made it, for the note that has it make the call again. */
function callText(name: string, input: unknown): string {
  return truncateText(`${name} ${JSON.stringify(input ?? {})}`, 800);
}

type CallOptions = {
  timeoutMs: number;
  /** What the node tried, in a line for its owner ("Run: npm test"). */
  describe: string;
  /** The call exactly (`callText`). */
  again: string;
  before?: (device: Device) => Promise<void | Record<string, unknown>>;
  need?: Need;
};

/**
 * Sends one call to the computer and reads its answer. A call that needs the owner's answer asks on a
 * card in this chat and waits for it: allowed, the same call goes again with the answer; denied, the
 * node hears no; not answered in time (or the owner wrote meanwhile), the turn parks.
 */
/** Options of the browser tools a computer before `capabilities.browser` 2 refuses: left out there, so the call still works. */
const BROWSER_2_OPTIONS = ["focus", "clean", "mode"] as const;

/** The request as this computer takes it: a 0.6.0 one gets the browser tools' older inputs (its input checks are strict). */
export function forComputer<T extends Record<string, unknown>>(device: Pick<Device, "capabilities">, request: T): T {
  const caps = (device.capabilities ?? {}) as { browser?: unknown; logins?: unknown };
  const input = request.input;
  if (request.tool !== "browser" || !input || typeof input !== "object") return request;
  const older = { ...(input as Record<string, unknown>) };
  if (!(typeof caps.browser === "number" && caps.browser >= BROWSER_API)) for (const key of BROWSER_2_OPTIONS) delete older[key];
  // A sign-in's purpose (a human check) is for logins 2; an older computer finds a human check itself.
  if (request.name === "browser_login_needed" && !(typeof caps.logins === "number" && caps.logins >= LOGIN_CHECKS_API)) delete older.purpose;
  return Object.keys(older).length === Object.keys(input).length ? request : { ...request, input: older };
}

async function callComputer(ctx: ToolContext, scope: NodeScope, computer: string | undefined, request: ToolCall, options: CallOptions): Promise<Called | ToolResult> {
  const { prisma, node } = scope;
  if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
  const device = await toolComputer(prisma, node.userId, computer, options.need);
  const mode = await modeFor(prisma, node);
  for (let asks = 0; ; asks += 1) {
    const extra = (await options.before?.(device)) ?? {};
    const grants = await pendingGrants(prisma, node.userId, node.id, device.id);
    const operationId = `${scope.turnId}:${randomUUID()}`;
    // Public web pages need no answer on the computer (device-tools/policy.ts) unless the owner asks to be asked, there or here.
    const data = { ...forComputer(device, request), ...extra, nodeId: node.id, nodeSlug: node.slug, mission: missionOf(scope), attended: mode.attended, grants, operationId, ...(mode.askBeforeBrowsing ? { askBeforeBrowsing: true } : {}) } as Record<string, unknown>;
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
      if (asks >= MAX_ASKS) throw new ToolBlockedError(`${device.name} still needs your owner's answer for this call after ${MAX_ASKS} answers.`, "Try a narrower call, or say what it needs.");
      const result = await askAndWait(ctx, scope, device, ask.data, options);
      if (result) return result;
      continue;
    }
    if (answer.data.status >= 400) {
      const why = typeof body.error === "string" ? body.error : `status ${answer.data.status}`;
      throw new ToolBlockedError(`${device.name} refused: ${why}`, answer.data.status === 403 ? "That is the computer's hard floor (keys, Ensemble's own data, system folders, dangerous commands), not a setting to work around." : undefined);
    }
    await appendLedger({ userId: node.userId, actor: "agent", action: `node.device_tool.${request.tool}`, payload: { nodeId: node.id, deviceId: device.id, ...ledgerOf(request), operationId } });
    return { device, status: answer.data.status, body };
  }
}

/**
 * The owner's card for what the computer asked, in this chat, and the wait for its answer. Null when
 * they allowed it (the call goes again); else what the node is told: no, or that its turn parks.
 */
async function askAndWait(ctx: ToolContext, scope: NodeScope, device: Device, ask: NodeToolAsk, options: CallOptions): Promise<ToolResult | null> {
  const { prisma, node } = scope;
  const tool = {
    nodeId: node.id,
    nodeSlug: node.slug,
    roomId: scope.room.id,
    private: Boolean(scope.privateTo),
    planId: scope.plan?.planId ?? null,
    planStep: scope.plan?.planStep ?? null,
    mission: missionOf(scope),
    deviceId: device.id,
    deviceName: device.name,
    capability: ask.capability,
    target: ask.target,
    label: ask.label,
    scope: ask.scope,
  };
  const asked = await askOwner(ctx.app, node.userId, tool, options.describe, ask.weak);
  const card = await computerCard(ctx.app, asked.row, {
    node,
    roomId: scope.room.id,
    private: Boolean(scope.privateTo),
    rootMessageId: scope.lineage.rootMessageId,
    botDepth: scope.lineage.botDepth,
    call: options.describe,
    planId: tool.planId,
    planStep: tool.planStep,
  });
  if (asked.created) await noticeAsked(ctx.app, asked.row, scope.room.id, card.id);
  const answered = await waitForOwner(
    { turnId: scope.turnId, ownerId: node.userId, nodeId: node.id, roomId: scope.room.id, private: Boolean(scope.privateTo), threadRootId: scope.lineage.rootMessageId },
    card.id,
    (signal) => awaitAnswer(ctx.app, asked.row.id, signal, permissionWaitMs(), { roomId: tool.roomId, private: tool.private, planId: tool.planId, planStep: tool.planStep, retry: options.again }),
  );
  const where = placeOf(tool);
  if (answered?.status === "decided" && answered.decision === "allow") return null;
  if (answered?.status === "decided") return toolOk(`Your owner chose not to allow this call (${options.describe}) ${where}. Continue without it, or say what cannot be done without it.`, { allowed: false });
  if (answered) return toolOk(`Your owner did not answer the card about ${options.describe} ${where}, and it closed. Continue without it, or ask again later if it is still needed.`, { allowed: false });
  // Not answered yet: the answer wakes this conversation or step later, with this call to make again.
  watchDecision(ctx.app, asked.row.id);
  const waits = `Waiting for ${await ownerName(prisma, node.userId)} to answer the card about ${options.describe} (${where}).`;
  requestPark(scope.turnId, waits);
  return toolOk(`${waits} End your turn now without a reply: you continue when they answer.`, { waitingForOwner: true, card: card.id });
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
const Folder = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe("Omit it to work in your own folder on the computer. Or a folder the computer shares with Ensemble (its label, or a path node_computer_files lists), or a project folder's full path.");

/** A command no answer runs (the hard floor's list, checked again on the computer): refused before anything is sent. */
function refuseDangerous(command: string, root = false): void {
  const hit = dangerousCommand(command, { root });
  if (hit) throw new ToolBlockedError(dangerousMessage(hit));
}

/** A call without a folder works in the node's own folder, which older computers do not have. */
const ownFolder = (folder: string | undefined): Need | undefined => (folder ? undefined : { ownFolder: "work in your own folder there. Until then, name a folder it shares with Ensemble" });

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
        "Run a command on your owner's computer yourself and read what it prints: a quick check, a download, reading a file, a build or tests. " +
        "Examples: download `curl -L -o app.deb https://example.com/app.deb`; read `cat notes.md` or `sed -n 1,80p build.log`; look `ls -la`, `df -h`, `git status`; test `npm test`. " +
        "One program and its arguments; for pipes, && or > use `bash -c \"…\"`. It runs in the computer's sandbox and changes files only in its folder. Omit folder to work in your own folder on the computer. " +
        "Up to 900 seconds: a long build or a server, background: true, and you are woken when it ends. Administrator rights (apt install, systemctl): computer_sudo. A screenshot of a terminal: computer_terminal_screenshot. " +
        "Writing or changing code in a repository is an agent session's job (node_session_start).",
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
        const admin = needsAdministrator(input.command);
        if (admin) throw new ToolBlockedError(`That needs the administrator (${admin}), which computer_run cannot do.`, "Use computer_sudo with the command (without `sudo`), for example `apt-get install -y ./app.deb`: your owner approves it on a card in this chat. Download with computer_run first.");
        refuseDangerous(input.command);
        const runId = randomUUID();
        const mode = await modeFor(prisma, node);
        const where = input.folder ?? "your own folder";
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "run", folder: input.folder, cwd: input.cwd, command: input.command, timeoutSec: input.timeoutSec, background: input.background, secrets: input.secrets, runId, delivery: mode.delivery, network: mode.network },
          {
            timeoutMs: input.background ? ASK_MS : RUN_ASK_MS,
            describe: `Run: ${input.command}`,
            again: callText("computer_run", input),
            need: ownFolder(input.folder),
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
                folder: where,
                startedAt: new Date().toISOString(),
              }),
          },
        );
        if (isResult(done)) return done;
        if (done.status === 202) {
          return toolOk(`\`${input.command}\` is running in the background on ${done.device.name}. You are woken when it ends; do not wait for it.`, { computer: done.device.name, run: runId, output: done.body.output ?? "" });
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
      description: "Read the output of a command you ran with computer_run or computer_sudo that ran in the background or printed too much to show (its run id). from: where the last read stopped (its next).",
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
      description: "Read git in a folder on your owner's computer: status, diff, log, show, or the branch list. args: extra arguments (a path, a commit, -n 5). Read only; to commit, pull or push use computer_run (`git pull`).",
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
        const done = await callComputer(ctx, scope, input.computer, { tool: "git", folder: input.folder, op: input.op, args: input.args }, { timeoutMs: ASK_MS + 30_000, describe: `git ${input.op} ${input.args.join(" ")}`.trim(), again: callText("computer_git", input), need: ownFolder(input.folder) });
        if (isResult(done)) return done;
        return toolOk(`git ${input.op}: exit code ${done.body.exitCode ?? "unknown"}.`, { computer: done.device.name, output: done.body.output ?? "", truncated: done.body.truncated === true });
      },
    }),
    defineTool({
      name: "computer_http",
      area: "tasks",
      description: "Call a development server on your owner's computer (http://localhost:3000/…): check it answers, read a page or an API. Only this computer's own addresses; redirects elsewhere are refused. The answer is cut to 64 KB. For websites use browser_open.",
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
        const done = await callComputer(ctx, scope, input.computer, { tool: "http", url: input.url, method: input.method, body: input.body, contentType: input.contentType }, { timeoutMs: ASK_MS + 10_000, describe: `${input.method} ${input.url}`, again: callText("computer_http", input) });
        if (isResult(done)) return done;
        return toolOk(`${input.method} ${typeof done.body.url === "string" ? done.body.url : input.url}: ${done.body.status}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_write",
      area: "tasks",
      description:
        "Write a text file on your owner's computer: its whole new content, at most 1 MB (a report in Markdown, notes, a config, a script). Omit folder to write in your own folder there. " +
        "To show the file to your owner in this chat, then call node_share_file. Never git's own files or files of keys and secrets.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000).describe("The file's path inside the folder, for example report.md."), content: z.string().max(NODE_TOOL_WRITE_BYTES) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "write", folder: input.folder, path: input.path, content: input.content }, { timeoutMs: ASK_MS, describe: `Write ${input.path}`, again: callText("computer_files_write", { ...input, content: `(${input.content.length} characters)` }), need: ownFolder(input.folder) });
        if (isResult(done)) return done;
        return toolOk(`${done.body.created ? "Created" : "Wrote"} ${input.path}${input.folder ? "" : " in your own folder"}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_move",
      area: "tasks",
      description: "Move or rename a file inside a folder on your owner's computer (omit folder: your own folder there). It never replaces a file.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000), to: z.string().min(1).max(1000) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "move", folder: input.folder, path: input.path, to: input.to }, { timeoutMs: ASK_MS, describe: `Move ${input.path} to ${input.to}`, again: callText("computer_files_move", input), need: ownFolder(input.folder) });
        if (isResult(done)) return done;
        return toolOk(`Moved ${input.path} to ${input.to}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_files_delete",
      area: "tasks",
      description: "Delete one file in a folder on your owner's computer (omit folder: your own folder there). Not a folder.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000) }).strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const done = await callComputer(ctx, scope, input.computer, { tool: "files", action: "delete", folder: input.folder, path: input.path }, { timeoutMs: ASK_MS, describe: `Delete ${input.path}`, again: callText("computer_files_delete", input), need: ownFolder(input.folder) });
        if (isResult(done)) return done;
        return toolOk(`Deleted ${input.path}.`, { computer: done.device.name, ...done.body });
      },
    }),
    defineTool({
      name: "computer_terminal_screenshot",
      area: "tasks",
      description:
        "Take a screenshot of a terminal on your owner's computer: it runs a command in a real terminal and captures the screen as a picture, which appears with your reply by itself. " +
        "Use it whenever your owner asks for a screenshot of their terminal, shell, htop, top or any command's output (`htop`, `top`, `df -h`, `ls -la`, `git log --oneline`). " +
        "seconds: how long it runs before the picture (3 by default; htop and top keep running until then, and are stopped for you after it). keys: only to change what it shows once it started ({Down}, {F6}, a search); never a key that quits it (q, {F10}, {Ctrl+C}). You also get the screen as text.",
      input: z
        .object({
          computer: Computer,
          folder: Folder,
          command: z.string().min(1).max(4000),
          seconds: z.number().min(0.5).max(60).default(3),
          columns: z.number().int().min(40).max(300).default(120),
          rows: z.number().int().min(10).max(100).default(32),
          keys: z.array(z.string().max(200)).max(20).default([]),
          title: z.string().max(200).optional().describe("A name for the picture, for example htop."),
        })
        .strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        if (/^\s*sudo\s/.test(input.command)) throw new ToolBlockedError("A terminal screenshot does not run a command as the administrator.", "Run that part with computer_sudo first.");
        refuseDangerous(input.command);
        const operation = captureOperation(scope);
        const mode = await modeFor(prisma, node);
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "terminal", folder: input.folder, command: input.command, seconds: input.seconds, columns: input.columns, rows: input.rows, keys: input.keys, title: input.title, operation, uploadId: "pending", network: mode.network },
          {
            timeoutMs: 75_000 + Math.ceil(input.seconds * 1000),
            describe: `Terminal screenshot: ${input.command}`,
            again: callText("computer_terminal_screenshot", input),
            need: { ownFolder: "take terminal screenshots there" },
            before: async (device) => ({ uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) }),
          },
        );
        if (isResult(done)) return done;
        const kept = await keepCaptures(ctx, scope, done, operation, "all", "picture of the terminal");
        const result = (kept.answer.result ?? {}) as { screen?: unknown; exitCode?: unknown; ended?: unknown };
        const screen = typeof result.screen === "string" ? truncateText(result.screen, SCREEN_CHARS) : "";
        return toolOk(kept.lines.join("\n"), { computer: done.device.name, screen, exitCode: typeof result.exitCode === "number" ? result.exitCode : null, ended: result.ended === true, evidence: kept.evidence });
      },
    }),
    defineTool({
      name: "node_share_file",
      area: "tasks",
      description:
        "Bring a file from your owner's computer into this chat (a report .md, a log, an image, a PDF): they see it with your reply. " +
        "path: the file inside the folder (omit folder for your own folder there, where computer_files_write puts files). caption: one line on what it is.",
      input: z.object({ computer: Computer, folder: Folder, path: z.string().min(1).max(1000), caption: z.string().max(300).optional() }).strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        const operation = captureOperation(scope);
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "files", action: "share", folder: input.folder, path: input.path, operation, uploadId: "pending", ...(input.caption ? { caption: input.caption } : {}) },
          {
            timeoutMs: 90_000,
            describe: `Share ${input.path}`,
            again: callText("node_share_file", input),
            need: { ownFolder: "share files from it" },
            before: async (device) => ({ uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) }),
          },
        );
        if (isResult(done)) return done;
        const kept = await keepCaptures(ctx, scope, done, operation, "all", "file");
        return toolOk(kept.lines.join("\n"), { computer: done.device.name, evidence: kept.evidence });
      },
    }),
    // hub_save_file with a path too: the file is shared from the computer as evidence, then saved in Files (assistant/tools/save-file.ts).
    nodeSaveFileTool({
      computerFields: { computer: Computer, folder: Folder },
      async share(ctx, input) {
        const operation = captureOperation(scope);
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "files", action: "share", folder: input.folder, path: input.path, operation, uploadId: "pending" },
          {
            timeoutMs: 90_000,
            describe: `Save ${input.path} to Ensemble Files`,
            again: callText("hub_save_file", input),
            need: { ownFolder: "share files from it" },
            before: async (device) => ({ uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) }),
          },
        );
        if (isResult(done)) return done;
        const kept = await keepCaptures(ctx, scope, done, operation, "none");
        const file = kept.evidence.find((item) => !item.held);
        if (file) return { evidence: file.id };
        const held = kept.evidence[0];
        if (!held) throw new ToolBlockedError(`${done.device.name} shared nothing for ${input.path}.`);
        return toolOk(`${kept.lines.join("\n")}\nOnce your owner releases it, save it with hub_save_file {evidence: "${held.id}"}.`, { computer: done.device.name, evidence: kept.evidence, saved: false });
      },
    }),
    // A helper never runs commands as the administrator.
    ...(node.parentNodeId ? [] : [sudoTool(scope)]),
    ...captureTools(scope),
  ];
  return folders.length ? tools.map((tool) => onlyIn(tool, folders)) : tools;
}

/** `computer_sudo`: the owner approves the exact command on a card in the chat (and types their password there); the call waits for them. */
function sudoTool(scope: NodeScope): AnyHubTool {
  const { prisma, node } = scope;
  return defineTool({
    name: "computer_sudo",
    area: "tasks",
    description:
      "Run one command as the administrator (sudo) on your owner's computer: installing software (`apt-get install -y xvfb`), a service (`systemctl restart nginx`), a system setting. " +
      "Your owner sees the exact command on a card in this chat and approves it (typing their password there; you never see it). Write the whole command on one line without `sudo`, and say in reason why it is needed. " +
      "The call waits for their answer and gives you what it printed. Anything that needs no administrator rights: computer_run.",
    input: z
      .object({
        computer: Computer,
        command: z.string().min(1).max(4000),
        reason: z.string().min(1).max(300).describe("Why, in one line your owner understands (“to install Xvfb so apps can be captured”)."),
        folder: Folder,
        timeoutSec: z.number().int().min(1).max(1800).default(600),
      })
      .strict(),
    isWrite: false,
    risk: "high",
    async run(ctx, input) {
      if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
      // A leading sudo is the tool's own.
      const command = input.command.trim().replace(/^sudo\s+(?=[^-\s])/, "");
      refuseDangerous(command, true);
      const device = await toolComputer(prisma, node.userId, input.computer, { ownFolder: "run commands as the administrator there" });
      return askSudo(ctx.app, { scope, device, command, reason: input.reason, folder: input.folder ?? null, timeoutSec: input.timeoutSec, mission: missionOf(scope) });
    },
  });
}

/**
 * The node's tool operation for the browser, capture, terminal and share tools: one per node, so its
 * tabs, apps and evidence last across its conversations and its background work.
 */
export function captureOperation(scope: Pick<NodeScope, "node">): string {
  return `node:${scope.node.id}:own`;
}

/** How long a call may take on the computer: a video for its length, a shop for its stores, every call for its upload. */
function captureTimeout(name: string, input: Record<string, unknown>): number {
  const seconds = typeof input.durationSec === "number" ? Math.min(input.durationSec, 600) : 0;
  if (name === "capture_video") return 120_000 + seconds * 2_000;
  if (name === "browser_shop") return 190_000;
  if (name === "browser_view" || name === "browser_extract" || name === "browser_fetch" || name === "browser_set_location") return 120_000;
  return name === "capture_app_start" ? 90_000 : 75_000;
}

/** Page text the summary already carries (a snapshot, a page's Markdown, a store's text): left out of the result. */
const TEXT_FIELDS = new Set(["snapshot", "markdown", "text"]);

function withoutText(value: unknown, depth = 0): unknown {
  if (depth > 3 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => withoutText(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !TEXT_FIELDS.has(key)).map(([key, item]) => [key, withoutText(item, depth + 1)]));
}

/** A small result the node reads besides the summary (checks, a status, apps, offers); a page's text is in its summary. */
function smallResult(result: unknown): Record<string, unknown> {
  if (result === undefined) return {};
  const lean = withoutText(result);
  const text = JSON.stringify(lean);
  return text.length <= 8_000 ? { result: lean } : {};
}

const NOUNS: Record<string, string> = { screenshot: "screenshot", image: "picture", video: "video" };
/** What a capture tool is meant to bring back. */
const EXPECTS: Record<string, string> = { browser_screenshot: "screenshot", browser_view: "screenshot", browser_shop: "screenshot", capture_screenshot: "screenshot", capture_video: "video" };
/** Tools whose files are documents to keep, not pictures to show: nothing comes with the reply by itself. */
const DOCUMENTS = new Set(["browser_fetch", "browser_download"]);

/**
 * What a capture-like call kept: its evidence is the node's own; a capture the computer holds waits for
 * the owner's preview card; what it kept and may show (pictures and videos, or every file it was asked
 * to share) comes with the node's reply by itself.
 */
/** `expects`: what the call was meant to bring back (a screenshot, a file), so the node hears plainly when nothing will show. */
async function keepCaptures(ctx: ToolContext, scope: NodeScope, done: Called, operation: string, show: "pictures" | "all" | "none", expects?: string) {
  const { prisma, node } = scope;
  const parsed = NodeCaptureAnswer.safeParse(done.body);
  if (!parsed.success) throw new ToolBlockedError(`${done.device.name} sent an answer that could not be read.`);
  const answer = parsed.data;
  const main = answer.evidence.filter((item) => !item.variantOf);
  const held = main.filter((item) => item.held);
  const kept = main.filter((item) => !item.held);
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
  const showable = show === "none" ? [] : (show === "all" ? kept : shownKinds(kept)).filter((item) => !item.local);
  const { media } = showable.length ? await ownerMedia(prisma, node.userId, showable.map((item) => item.id)) : { media: [] };
  if (media.length) rememberCaptured(scope.turnId, media);
  const lines = [
    answer.ok ? (answer.summary ?? "Done.") : `It did not work: ${answer.error?.message ?? "the tool failed"}`,
    kept.length ? `Kept as your evidence: ${kept.map((item) => `${item.kind} “${item.name}” [${item.id}]${item.local ? " (kept on the computer: evidence upload is off there)" : ""}`).join("; ")}.` : "",
    media.length === 1 ? `This ${NOUNS[media[0]!.kind] ?? "file"} will appear with your reply.` : media.length > 1 ? `These ${media.length} files will appear with your reply (node_show to choose fewer).` : "",
    held.length ? `Held for your owner to preview first, on a card in this chat: nothing is shown or sent until they release it, and you are told when they do. The card asks them; do not ask in your reply.` : "",
    expects && answer.ok && !media.length && !held.length ? `No ${expects} came back, so nothing will show with your reply: never say one is attached or shown. Try again, or tell your owner it did not work.` : "",
    show === "none" && kept.length
      ? `It is in your evidence, not yet in your owner's Ensemble Files: to put it there, call hub_save_file with evidence "${kept[0]!.id}"; to show it in this chat, node_show. Never write a link to it yourself.`
      : "",
    answer.refused.length ? `Not kept: ${answer.refused.map((item) => `“${item.name}”: ${item.reason}`).join("; ")}.` : "",
  ].filter(Boolean);
  if (!answer.ok) throw new ToolBlockedError(lines.join("\n"));
  return { answer, lines, evidence: main.map((item) => ({ id: item.id, name: item.name, kind: item.kind, held: item.held })) };
}

/**
 * Refuses, before anything reaches the computer, a browser or capture call that would open Ensemble's
 * own web app (lib/ensemble-origins.ts): the node already acts there through its Ensemble tools.
 */
export function refuseEnsembleApp(name: string, input: Record<string, unknown>): void {
  // browser_wait's url is a pattern the tab's address is waited for, not a page to open.
  const targets = [name !== "browser_wait" && typeof input.url === "string" ? input.url : null, ...(name === "browser_shop" && Array.isArray(input.stores) ? input.stores : [])];
  for (const target of targets) {
    const origin = typeof target === "string" ? ensembleAppOrigin(target) : null;
    if (origin) throw new ToolBlockedError(`${origin} is Ensemble itself, not a website to open or sign in to.`, ENSEMBLE_IN_BROWSER);
  }
}

/**
 * The browser and capture tools (B10, B19) on the owner's computer, for this node: the same tools a
 * coding agent's run has, through `node.tool.request` (device-tools/capture.ts on the computer). What
 * they capture is the node's own evidence and comes with its reply; a capture the computer holds
 * waits for the owner's preview card.
 */
export function captureTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  const specs = [...BROWSER_TOOLS, ...CAPTURE_TOOLS] as ReadonlyArray<{ name: string; description: string; input: z.ZodTypeAny }>;
  return specs.map((spec) =>
    defineTool({
      name: spec.name,
      area: "tasks",
      description: `On your owner's computer: ${spec.description} Screenshots and videos you capture appear with your reply by themselves; a capture the computer holds waits for your owner's preview.`,
      input: (spec.input as z.AnyZodObject).extend({ computer: Computer }),
      isWrite: false,
      risk: spec.name === "capture_app_start" || spec.name === "browser_type" || spec.name === "browser_upload" ? "medium" : "low",
      async run(ctx, raw) {
        const { computer, ...input } = raw as Record<string, unknown> & { computer?: string };
        refuseEnsembleApp(spec.name, input);
        const tool = spec.name.startsWith("browser_") ? ("browser" as const) : ("capture" as const);
        const operation = captureOperation(scope);
        const mode = await modeFor(prisma, node);
        const done = await callComputer(
          ctx,
          scope,
          computer,
          { tool, name: spec.name, input, operation, uploadId: "pending", network: mode.network },
          {
            timeoutMs: captureTimeout(spec.name, input),
            describe: typeof input.url === "string" ? `Open ${input.url}` : spec.name === "capture_app_start" ? `Start ${String(input.command ?? "the app")} in ${String(input.cwd ?? "")}` : spec.name,
            again: callText(spec.name, raw),
            need: { browser: spec.name },
            // Its files have somewhere to go before the computer makes them.
            before: async (device) => ({ uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) }),
          },
        );
        if (isResult(done)) return done;
        const kept = await keepCaptures(ctx, scope, done, operation, DOCUMENTS.has(spec.name) ? "none" : "pictures", EXPECTS[spec.name]);
        const { login } = kept.answer;
        // The tab waits for the owner to sign in (B11): one owner-only card; the turn parks and the node is woken when it ends.
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
          requestPark(scope.turnId, `Waiting for ${await ownerName(prisma, node.userId)} to sign in to ${login.origin} on ${done.device.name} (the card in this chat).`);
          kept.lines.push(`Your owner is asked on a card in this chat to sign in to ${login.origin} on ${done.device.name}. End your turn now without a reply: you continue when they have signed in (or chose not to).`);
          return toolOk(kept.lines.join("\n"), { computer: done.device.name, waitingForOwner: true, decisionId: card.id, signIn: { origin: login.origin, tab: login.tab } });
        }
        return toolOk(kept.lines.join("\n"), { computer: done.device.name, evidence: kept.evidence, ...smallResult(kept.answer.result) });
      },
    }),
  );
}

/** The tools that take a folder: a helper names one of its own each time. */
const FOLDER_TOOLS = new Set(["computer_run", "computer_git", "computer_files_write", "computer_files_move", "computer_files_delete", "computer_terminal_screenshot", "node_share_file"]);

/** A helper's tool that works only in the folders its parent named (by label, path or last part); an app it starts for capture too. */
function onlyIn(tool: AnyHubTool, folders: readonly string[]): AnyHubTool {
  const last = (value: string) => value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const allowed = (folder: string) => folders.some((name) => name.trim() === folder.trim() || last(name) === last(folder));
  const named = folders.map((name) => `“${name}”`).join(", ");
  return {
    ...tool,
    async run(ctx, input) {
      // An app started for capture runs in its folder, as a command does.
      const given = input as { folder?: unknown; cwd?: unknown } | null;
      const folder = tool.name === "capture_app_start" ? given?.cwd : given?.folder;
      if (typeof folder === "string" && !allowed(folder)) throw new ToolBlockedError(`You may only use ${named}.`, "Those are the folders your node gave you; report what needs another folder.");
      if (typeof folder !== "string" && FOLDER_TOOLS.has(tool.name)) throw new ToolBlockedError(`Name the folder: you may only use ${named}.`, "Those are the folders your node gave you.");
      return tool.run(ctx, input as never);
    },
  } as AnyHubTool;
}
