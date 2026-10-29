/**
 * The owner's answers for a node's tools on their computer (B9, plan §10.5). When the computer says a
 * call needs the owner (the first use of a folder or a web address, attended), one Needs me card asks,
 * with Once, This mission and Always for this folder; a second call for the same folder while it waits
 * does not ask again. The answer reaches the computer with the node's next call there (the computer
 * keeps "this mission" and "always" as its own rules), and wakes the node to go on. Cards are Ensemble's
 * Needs me decisions, answerable on Node, in the Hub, on the phone and with `ensemble needs`.
 */
import type { AgentDecision, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { decisionBus } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import type { NodeToolAsk, NodeToolGrant } from "../remote/contract.js";
import { enqueueTurn } from "./queue.js";

/** `agent_decisions.tool_name` of these cards. */
export const NODE_TOOL_DECISION = "Computer tools";
/** A card from work the owner started waits for them; it goes stale after this. */
const WAIT_DAYS = 30;

export const CHOICES = { once: "Once", mission: "This mission", folder: "Always for this folder", origin: "Always for this address" } as const;

export type NodeToolCard = {
  nodeId: string;
  nodeSlug: string;
  roomId: string;
  private: boolean;
  planId: string | null;
  planStep: string | null;
  mission: string;
  deviceId: string;
  deviceName: string;
  capability: NodeToolAsk["capability"];
  target: string;
  label: string;
  scope: NodeToolAsk["scope"];
  /** The computer has used the answer (it keeps "this mission" and "always" itself). */
  delivered: boolean;
  /** The node heard the answer. */
  announced: boolean;
};

type Detail = { nodeTool?: NodeToolCard; options?: string[] } & Record<string, unknown>;

const detailOf = (row: Pick<AgentDecision, "detail">): Detail => (row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? (row.detail as Detail) : {});

/** What the card's answer covers: once, the mission, or always (the folder or the address). */
export function grantScope(row: Pick<AgentDecision, "decision" | "reason" | "detail">): NodeToolGrant["scope"] | null {
  if (row.decision !== "allow") return null;
  const reason = (row.reason ?? "").trim();
  if (reason === CHOICES.mission) return "mission";
  if (reason === CHOICES.folder || reason === CHOICES.origin) return "always";
  return "once";
}

const VERBS: Record<NodeToolAsk["capability"], string> = { run: "run commands", git: "read git", files: "change files", http: "call", browse: "browse" };

/** The card's question: what the node wants to do, where, on which computer. */
function title(card: Pick<NodeToolCard, "nodeSlug" | "capability" | "label" | "scope" | "deviceName">): string {
  if (card.scope === "origin" && card.capability === "browse") return `@${card.nodeSlug} wants to open ${card.label} in the Ensemble browser on ${card.deviceName}`;
  if (card.scope === "origin") return `@${card.nodeSlug} wants to call ${card.label} on ${card.deviceName}`;
  return `@${card.nodeSlug} wants to ${VERBS[card.capability]} in ${card.label} on ${card.deviceName}`;
}

/**
 * Opens the card for this node, computer and folder (or address), or finds the one still waiting.
 * Returns its id and whether it is new.
 */
export async function askOwner(app: Pick<FastifyInstance, "prisma">, owner: string, card: Omit<NodeToolCard, "delivered" | "announced">, call: string, weak: boolean): Promise<{ id: string; created: boolean }> {
  const prisma = app.prisma;
  const waiting = await prisma.agentDecision.findMany({ where: { userId: owner, toolName: NODE_TOOL_DECISION, status: "pending" }, orderBy: { requestedAt: "asc" }, take: 200 });
  const same = waiting.find((row) => {
    const known = detailOf(row).nodeTool;
    return known && known.nodeId === card.nodeId && known.deviceId === card.deviceId && known.target === card.target;
  });
  if (same) return { id: same.id, created: false };
  // Where the computer's sandbox is weak, "always" would not cover commands there: it is not offered.
  const options = [CHOICES.once, CHOICES.mission, ...(weak ? [] : [card.scope === "origin" ? CHOICES.origin : CHOICES.folder])];
  const row = await prisma.agentDecision.create({
    data: {
      userId: owner,
      source: "ensemble",
      event: "question",
      toolName: NODE_TOOL_DECISION,
      title: title(card),
      cwd: card.scope === "folder" ? card.label : null,
      detail: {
        options,
        allowCustom: false,
        recommended: null,
        command: call.slice(0, 2000),
        header: weak ? "This computer's sandbox is weak, so commands ask once per mission" : null,
        nodeTool: { ...card, delivered: false, announced: false },
      } as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + WAIT_DAYS * 86_400_000),
    },
  });
  await prisma.notification.create({ data: { userId: owner, kind: "decision", title: row.title.slice(0, 200), body: card.label, urgent: true, url: "/needs-me" } });
  sseHub.publish(owner, { event: "decision", data: { id: row.id, status: "pending", title: row.title, source: "ensemble", runnerAccountId: null } });
  await appendLedger({ userId: owner, actor: "agent", action: "node.tool.asked", payload: { nodeId: card.nodeId, deviceId: card.deviceId, capability: card.capability, target: card.label } });
  return { id: row.id, created: true };
}

/** The owner's answers for this node on this computer that the computer has not used yet. */
export async function pendingGrants(prisma: Pick<PrismaClient, "agentDecision">, owner: string, nodeId: string, deviceId: string): Promise<NodeToolGrant[]> {
  const rows = await prisma.agentDecision.findMany({
    where: { userId: owner, toolName: NODE_TOOL_DECISION, status: "decided", decision: "allow", decidedAt: { gte: new Date(Date.now() - WAIT_DAYS * 86_400_000) } },
    orderBy: { decidedAt: "asc" },
    take: 200,
  });
  const grants: NodeToolGrant[] = [];
  for (const row of rows) {
    const card = detailOf(row).nodeTool;
    const scope = grantScope(row);
    if (!card || !scope || card.delivered || card.nodeId !== nodeId || card.deviceId !== deviceId) continue;
    grants.push({ id: row.id, scope, target: card.target });
  }
  return grants.slice(-20);
}

/** Changes a card's node-tool record when it still says `from` (a compare-and-set on the JSON). */
async function markCard(prisma: Pick<PrismaClient, "agentDecision">, id: string, field: "delivered" | "announced"): Promise<boolean> {
  const row = await prisma.agentDecision.findUnique({ where: { id } });
  const detail = row ? detailOf(row) : null;
  if (!row || !detail?.nodeTool || detail.nodeTool[field]) return false;
  const changed = await prisma.agentDecision.updateMany({
    where: { id, detail: { path: ["nodeTool", field], equals: false } },
    data: { detail: { ...detail, nodeTool: { ...detail.nodeTool, [field]: true } } as Prisma.InputJsonValue },
  });
  return changed.count === 1;
}

/** The computer used these answers: they are not sent again. */
export async function markGrantsUsed(prisma: Pick<PrismaClient, "agentDecision">, ids: readonly string[]): Promise<void> {
  for (const id of ids) await markCard(prisma, id, "delivered");
}

/** The node hears the owner's answer, once: allowed (and for how long), or not. */
async function announce(app: FastifyInstance, row: AgentDecision): Promise<void> {
  const card = detailOf(row).nodeTool;
  if (!card || row.status === "pending") return;
  if (!(await markCard(app.prisma, row.id, "announced"))) return;
  const scope = grantScope(row);
  const where = `${card.scope === "origin" ? card.label : `in ${card.label}`} on ${card.deviceName}`;
  const note =
    row.status !== "decided"
      ? `Your owner did not answer about your computer tools ${where}, and the question closed. Go on without them, or ask again later.`
      : !scope
        ? `Your owner said no to your computer tools ${where}. Go on without them, or say what cannot be done without them.`
        : `Your owner allowed your computer tools ${where}${scope === "once" ? " for one call" : scope === "mission" ? " for this mission" : " from now on"}. Make the call again now.`;
  await enqueueTurn(app, { nodeId: card.nodeId, roomId: card.roomId, reason: "approval", note, private: card.private, ...(card.planId ? { planId: card.planId, planStep: card.planStep } : {}) });
}

const watching = new Set<string>();
/** Between answers seen on the bus, the card is read again this often (an answer from another process). */
const RECHECK_MS = 5 * 60_000;

/** Resolves when the decision bus says this card changed, or after `RECHECK_MS`. */
function changed(id: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      decisionBus.off(id, done);
      resolve();
    };
    const timer = setTimeout(done, RECHECK_MS);
    timer.unref?.();
    decisionBus.once(id, done);
  });
}

/** Waits for the owner's answer in this process and then tells the node. A restart picks it up again (`recoverNodeToolDecisions`). */
export function watchDecision(app: FastifyInstance, id: string): void {
  if (watching.has(id)) return;
  watching.add(id);
  void (async () => {
    try {
      for (;;) {
        const row = await app.prisma.agentDecision.findUnique({ where: { id } });
        if (!row) return;
        if (row.status !== "pending") return await announce(app, row);
        if (row.expiresAt < new Date()) {
          await app.prisma.agentDecision.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
          continue;
        }
        await changed(id);
      }
    } catch (error) {
      app.log.warn({ err: error, decisionId: id }, "could not follow a node tool question");
    } finally {
      watching.delete(id);
    }
  })();
}

/** After a restart: follow the cards still waiting, and tell nodes about answers they missed. */
export async function recoverNodeToolDecisions(app: FastifyInstance): Promise<void> {
  const rows = await app.prisma.agentDecision.findMany({ where: { toolName: NODE_TOOL_DECISION, OR: [{ status: "pending" }, { decidedAt: { gte: new Date(Date.now() - 86_400_000) } }] }, take: 500 });
  for (const row of rows) {
    if (row.status === "pending") watchDecision(app, row.id);
    else if (!detailOf(row).nodeTool?.announced) await announce(app, row).catch(() => undefined);
  }
}
