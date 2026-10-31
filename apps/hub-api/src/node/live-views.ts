/**
 * Live terminals and live views (docs/35 §8.17). A node keeps terminals open on its owner's computer
 * between calls (`terminal_open`, `terminal_send`, `terminal_read`, `terminal_close`; the computer runs
 * and judges them, device-tools/terminal-sessions.ts), and gives its owner a live view of one of them or
 * of one of its browser tabs (`live_view`): one owner-only card in the chat per session or tab, which
 * the owner opens through the sealed takeover channel (`POST /api/node/takeovers {liveCardId}`,
 * node/takeovers.ts) to watch, type and take control while the node keeps working. The card ends when
 * the session or tab does (`POST /api/devices/self/live/:liveId/ended`). Only in turns only the owner
 * reads and started, like every computer tool; nothing typed or shown is kept here.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Device, NodeMessage } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext } from "../assistant/types.js";
import { needsAdministrator } from "../device-tools/dangerous.js";
import { appendLedger } from "../lib/ledger.js";
import { truncateText } from "../lib/text.js";
import { LIVE_MAX_MS, LiveAnswer, LiveId, LiveSessionId } from "../remote/contract.js";
import { callComputer, callText, captureOperation, isResult, modeFor, refuseDangerous } from "./device-tools.js";
import { postMessage, updateMessageData } from "./store.js";
import type { NodeScope } from "./tools.js";

export const LIVE_CARD = "live";

/** A live card's data, exactly as Node renders it. */
export const LiveCardData = z.object({
  type: z.literal(LIVE_CARD),
  kind: z.enum(["terminal", "browser"]),
  status: z.enum(["open", "ended"]),
  liveId: LiveId,
  deviceId: z.string(),
  computer: z.string(),
  title: z.string(),
  session: LiveSessionId.optional(),
  tab: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type LiveCardData = z.infer<typeof LiveCardData>;

type Redisish = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
};

/** A terminal session as the web knows it: whose, on which computer. */
type SessionRecord = { session: string; deviceId: string; computer: string; nodeId: string; ownerId: string; title: string; folder: string; startedAt: string };

const RECORD_TTL_SECONDS = Math.ceil(LIVE_MAX_MS / 1000) + 3600;
const sessionKey = (id: string) => `ensemble:live:session:${id}`;
const cardKey = (liveId: string) => `ensemble:live:card:${liveId}`;
const tabKey = (deviceId: string, tab: string, nodeId: string) => `ensemble:live:tab:${deviceId}:${tab}:${nodeId}`;
const redisOf = (app: Pick<FastifyInstance, "redis">) => app.redis as unknown as Redisish;
/** What a node reads of a screen at most. */
const SCREEN_CHARS = 8_000;

async function sessionRecord(app: Pick<FastifyInstance, "redis">, id: string): Promise<SessionRecord | null> {
  const raw = await redisOf(app).get(sessionKey(id));
  return raw ? (JSON.parse(raw) as SessionRecord) : null;
}

/** The card for a live id, by its key, else by its data. */
export async function liveCard(app: FastifyInstance, liveId: string, ownerId: string): Promise<NodeMessage | null> {
  const cardId = await redisOf(app).get(cardKey(liveId));
  const byKey = cardId ? await app.prisma.nodeMessage.findUnique({ where: { id: cardId } }) : null;
  if (byKey && byKey.userId === ownerId) return byKey;
  return app.prisma.nodeMessage.findFirst({ where: { userId: ownerId, kind: "text", AND: [{ data: { path: ["type"], equals: LIVE_CARD } }, { data: { path: ["liveId"], equals: liveId } }] }, orderBy: { createdAt: "desc" } });
}

/** Posts the owner-only live card for a session or tab, once: a second call gives the same card while it is open. */
export async function postLiveCard(
  app: FastifyInstance,
  scope: NodeScope,
  input: { device: Pick<Device, "id" | "name">; kind: "terminal" | "browser"; liveId: string; title: string; session?: string; tab?: string },
): Promise<{ card: NodeMessage; again: boolean }> {
  const { node } = scope;
  const existing = await liveCard(app, input.liveId, node.userId);
  if (existing && (existing.data as { status?: unknown }).status === "open") return { card: existing, again: true };
  const data: LiveCardData = {
    type: LIVE_CARD,
    kind: input.kind,
    status: "open",
    liveId: input.liveId,
    deviceId: input.device.id,
    computer: input.device.name,
    title: input.title.slice(0, 200),
    ...(input.session ? { session: input.session } : {}),
    ...(input.tab ? { tab: input.tab } : {}),
    startedAt: new Date().toISOString(),
  };
  const { message } = await postMessage(app.prisma, {
    roomId: scope.room.id,
    userId: node.userId,
    authorKind: "node",
    authorNodeId: node.id,
    kind: "text",
    body: input.kind === "terminal" ? `@${node.slug}'s terminal on ${input.device.name}, live: ${data.title}` : `@${node.slug}'s browser on ${input.device.name}, live: ${data.title}`,
    data,
    visibleTo: [node.userId],
    rootMessageId: scope.lineage.rootMessageId ?? null,
  });
  await redisOf(app).set(cardKey(input.liveId), message.id, "EX", RECORD_TTL_SECONDS);
  await appendLedger({ userId: node.userId, actor: "agent", action: "node.live_view", payload: { nodeId: node.id, deviceId: input.device.id, kind: input.kind, liveId: input.liveId } });
  return { card: message, again: false };
}

/** The session or tab ended: its card says so. False when there is no open card for it. */
export async function endLiveCard(app: FastifyInstance, ownerId: string, liveId: string, reason: string): Promise<boolean> {
  if (/^ts/.test(liveId)) await redisOf(app).del(sessionKey(liveId));
  const card = await liveCard(app, liveId, ownerId);
  if (!card || (card.data as { status?: unknown }).status !== "open") return false;
  await updateMessageData(app.prisma, card, { status: "ended", endedAt: new Date().toISOString() });
  await appendLedger({ userId: ownerId, actor: "agent", action: "node.live_ended", payload: { liveId, reason: reason.slice(0, 40) } }).catch(() => undefined);
  return true;
}

/** An open live card the owner may open a live view of: its computer, what it shows, and the node's operation that owns it. */
export async function liveCardTarget(app: FastifyInstance, accountId: string, cardId: string): Promise<{ card: NodeMessage; data: LiveCardData; operation: string } | null> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: cardId } });
  const parsed = card ? LiveCardData.safeParse(card.data) : null;
  if (!card || !parsed?.success || card.kind !== "text" || card.userId !== accountId || !card.authorNodeId || card.visibleTo.length !== 1 || card.visibleTo[0] !== accountId) return null;
  return { card, data: parsed.data, operation: captureOperation({ node: { id: card.authorNodeId } as NodeScope["node"] }) };
}

const Computer = z.string().max(120).optional().describe("The computer's name, when your owner has more than one.");
const Session = LiveSessionId.describe("The terminal's id from terminal_open (ts…).");

/** What the node reads of a terminal answer. */
function screenOf(body: Record<string, unknown>): { answer: LiveAnswer; data: Record<string, unknown> } {
  const parsed = LiveAnswer.safeParse(body);
  if (!parsed.success) throw new ToolBlockedError("The computer sent an answer that could not be read.");
  const answer = parsed.data;
  return {
    answer,
    data: {
      session: answer.session,
      screen: truncateText(answer.screen ?? "", SCREEN_CHARS),
      atPrompt: answer.atPrompt ?? false,
      ended: answer.ended ?? false,
      ...(answer.controlled ? { controlled: true } : {}),
      ...(answer.hidden ? { hidden: "A secret on the screen is hidden." } : {}),
    },
  };
}

/** The node's own session, known here, or why not. */
async function ownRecord(ctx: ToolContext, scope: NodeScope, id: string): Promise<SessionRecord> {
  const record = await sessionRecord(ctx.app, id);
  if (!record || record.ownerId !== scope.node.userId) throw new ToolBlockedError(`There is no terminal ${id}.`, "Open one with terminal_open.");
  if (record.nodeId !== scope.node.id) throw new ToolBlockedError(`Terminal ${id} is not yours.`);
  return record;
}

/** A terminal that ended: its card ends and the node hears it. */
async function ended(ctx: ToolContext, scope: NodeScope, record: SessionRecord, answer: LiveAnswer, data: Record<string, unknown>) {
  await endLiveCard(ctx.app, scope.node.userId, record.session, "ended");
  const exit = typeof answer.exitCode === "number" ? ` (exit code ${answer.exitCode})` : "";
  return toolOk(`Terminal ${record.session} has ended${exit}. Open another with terminal_open if you still need one.`, { ...data, ended: true });
}

export function liveTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  if (!scope.ownerOnly || scope.lineage.fromNonOwner) return [];
  const operation = captureOperation(scope);

  /** One call on the session's computer. */
  const onSession = async (ctx: ToolContext, record: SessionRecord, name: string, input: Record<string, unknown>, call: Record<string, unknown>, timeoutMs: number) => {
    const mode = await modeFor(prisma, node);
    return callComputer(ctx, scope, record.deviceId, { tool: "live", session: record.session, operation, network: mode.network, keys: [], ...call } as never, {
      timeoutMs,
      describe: `${name} ${record.session}`,
      again: callText(name, input),
      need: { live: "keep a terminal open there" },
    });
  };

  return [
    defineTool({
      name: "terminal_open",
      area: "tasks",
      description:
        "Open a terminal on your owner's computer that stays open between your calls: a shell in your own folder (or folder), sandboxed like computer_run. " +
        "For interactive or long-lived work: a REPL, a program that asks questions, a login that waits, watching a server. Then terminal_send to type and terminal_read to look; terminal_close when done. " +
        "At most 3 open; one unused for 30 minutes closes. A one-off command: computer_run. live: true when your owner wants to watch it (their live card is posted at once).",
      input: z
        .object({
          computer: Computer,
          folder: z.string().min(1).max(4096).optional().describe("Omit it for your own folder there."),
          title: z.string().max(200).optional(),
          live: z.boolean().optional().describe("true: your owner watches it live (their card is posted now)."),
        })
        .strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        const mode = await modeFor(prisma, node);
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "live", action: "terminal_open", folder: input.folder, title: input.title, operation, network: mode.network, keys: [] },
          { timeoutMs: 45_000, describe: `Open a terminal in ${input.folder ?? "your own folder"}`, again: callText("terminal_open", input), need: { live: "keep a terminal open there", ...(input.folder ? {} : { ownFolder: "work in your own folder there" }) } },
        );
        if (isResult(done)) return done;
        const { answer, data } = screenOf(done.body);
        if (!answer.session) throw new ToolBlockedError(`${done.device.name} opened no terminal.`);
        const record: SessionRecord = { session: answer.session, deviceId: done.device.id, computer: done.device.name, nodeId: node.id, ownerId: node.userId, title: answer.title ?? "Terminal", folder: answer.folder ?? input.folder ?? "", startedAt: new Date().toISOString() };
        await redisOf(ctx.app).set(sessionKey(record.session), JSON.stringify(record), "EX", RECORD_TTL_SECONDS);
        if (input.live) {
          const { card } = await postLiveCard(ctx.app, scope, { device: { id: done.device.id, name: done.device.name }, kind: "terminal", liveId: record.session, title: record.title, session: record.session });
          return toolOk(`Terminal ${record.session} is open on ${done.device.name} in ${record.folder} (${record.title}), and your owner has its live card in this chat to watch and type. Type with terminal_send; mention the card in one line.`, { ...data, computer: done.device.name, card: card.id });
        }
        return toolOk(`Terminal ${record.session} is open on ${done.device.name} in ${record.folder} (${record.title}). Type with terminal_send; if your owner wants to watch it, live_view.`, { ...data, computer: done.device.name });
      },
    }),
    defineTool({
      name: "terminal_send",
      area: "tasks",
      description:
        "Type into your open terminal: text (a new line in it is Enter), then keys by name (Enter, Tab, Up, Ctrl+C, Escape, q). Answers the screen once the command is back at the prompt, or after waitMs (3 s after an Enter, 1 s otherwise). " +
        "Each line is judged like computer_run: dangerous commands are refused and cleared. Administrator commands: computer_sudo.",
      input: z
        .object({
          session: Session,
          text: z.string().max(8000).optional(),
          keys: z.array(z.string().min(1).max(40)).max(40).default([]),
          waitMs: z.number().int().min(0).max(60_000).optional(),
        })
        .strict(),
      isWrite: false,
      risk: "medium",
      async run(ctx, input) {
        if (!input.text && !input.keys.length) throw new ToolBlockedError("Send text or keys.");
        for (const line of (input.text ?? "").split(/\r\n|\r|\n/)) {
          const admin = needsAdministrator(line);
          if (admin) throw new ToolBlockedError(`That needs the administrator (${admin}), which a terminal cannot do.`, "Use computer_sudo with the command (without `sudo`): your owner approves it on a card in this chat.");
          refuseDangerous(line);
        }
        const record = await ownRecord(ctx, scope, input.session);
        const done = await onSession(ctx, record, "terminal_send", input, { action: "terminal_send", text: input.text, keys: input.keys, waitMs: input.waitMs }, (input.waitMs ?? 3_000) + 30_000);
        if (isResult(done)) return done;
        const { answer, data } = screenOf(done.body);
        if (answer.ended) return ended(ctx, scope, record, answer, data);
        return toolOk(answer.atPrompt ? "Back at the prompt." : "Something is still running, or waits for input: terminal_read later, or send keys.", data);
      },
    }),
    defineTool({
      name: "terminal_read",
      area: "tasks",
      description: "The screen of your open terminal now. lines: the last lines instead, scrollback included (up to 500).",
      input: z.object({ session: Session, lines: z.number().int().min(1).max(500).optional() }).strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        const record = await ownRecord(ctx, scope, input.session);
        const done = await onSession(ctx, record, "terminal_read", input, { action: "terminal_read", lines: input.lines }, 30_000);
        if (isResult(done)) return done;
        const { answer, data } = screenOf(done.body);
        if (answer.ended) return ended(ctx, scope, record, answer, data);
        return toolOk(answer.atPrompt ? "At the prompt." : "Something is running, or waits for input.", data);
      },
    }),
    defineTool({
      name: "terminal_close",
      area: "tasks",
      description: "Close your terminal and everything running in it.",
      input: z.object({ session: Session }).strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        const record = await ownRecord(ctx, scope, input.session);
        const done = await onSession(ctx, record, "terminal_close", input, { action: "terminal_close" }, 30_000);
        if (isResult(done)) return done;
        await endLiveCard(ctx.app, node.userId, record.session, "closed");
        return toolOk(`Closed terminal ${record.session}.`, { session: record.session, ended: true });
      },
    }),
    defineTool({
      name: "live_view",
      area: "tasks",
      description:
        "Let your owner watch your terminal (session) or your browser tab (tab) live in this chat: a card they open to watch, type or take control while you keep working. " +
        "Use it when they ask to watch, see it live, or take over. One card per terminal or tab; the card shows by itself, so say only that it is there.",
      input: z
        .object({
          kind: z.enum(["terminal", "browser"]),
          session: Session.optional(),
          tab: z.string().regex(/^t\d{1,9}$/).optional().describe("Your tab (t1, t2…) from browser_open or browser_tabs."),
          computer: Computer,
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        if (input.kind === "terminal") {
          if (!input.session) throw new ToolBlockedError("Name the terminal (session) from terminal_open.");
          const record = await ownRecord(ctx, scope, input.session);
          const done = await onSession(ctx, record, "live_view", input, { action: "terminal_read" }, 30_000);
          if (isResult(done)) return done;
          const { answer, data } = screenOf(done.body);
          if (answer.ended) return ended(ctx, scope, record, answer, data);
          const { card, again } = await postLiveCard(ctx.app, scope, { device: { id: done.device.id, name: done.device.name }, kind: "terminal", liveId: record.session, title: record.title, session: record.session });
          return toolOk(again ? "Your owner already has the live view card for this terminal in this chat." : "Your owner has a card in this chat to watch this terminal live and take control. Keep working; mention the card in one line.", { card: card.id, session: record.session });
        }
        if (!input.tab) throw new ToolBlockedError("Name your tab (t1, t2…): browser_tabs lists them.");
        const tab = input.tab;
        const mode = await modeFor(prisma, node);
        let liveId = "";
        const done = await callComputer(
          ctx,
          scope,
          input.computer,
          { tool: "live", action: "browser_tab", tab, operation, network: mode.network, keys: [] },
          {
            timeoutMs: 30_000,
            describe: `Show tab ${tab} live`,
            again: callText("live_view", input),
            need: { live: "show your browser live there" },
            // The tab's live id: the same one while its card is open.
            before: async (device) => {
              const key = tabKey(device.id, tab, node.id);
              liveId = (await redisOf(ctx.app).get(key)) ?? `lv${randomBytes(8).toString("hex")}`;
              await redisOf(ctx.app).set(key, liveId, "EX", RECORD_TTL_SECONDS);
              return { liveId };
            },
          },
        );
        if (isResult(done)) return done;
        const shown = LiveAnswer.safeParse(done.body);
        const url = shown.success ? (shown.data.url ?? "") : "";
        let site = "";
        try {
          site = url ? new URL(url).host : "";
        } catch {
          site = "";
        }
        const title = (shown.success ? shown.data.title : "") || site || `Tab ${tab}`;
        const { card, again } = await postLiveCard(ctx.app, scope, { device: { id: done.device.id, name: done.device.name }, kind: "browser", liveId, title, tab });
        return toolOk(again ? "Your owner already has the live view card for this tab in this chat." : "Your owner has a card in this chat to watch this tab live and take control (which pauses you on it). Keep working; mention the card in one line.", { card: card.id, tab });
      },
    }),
  ];
}
