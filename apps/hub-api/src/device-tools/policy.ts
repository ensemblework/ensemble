/**
 * Who decides whether a node's tool call runs on this computer (ensemble-node plan §10.5), evaluated
 * here, not on the server: the hard floor first (the caller resolves the folder or address and refuses
 * what no answer can open), then the owner's saved answers, then the mode. The node's own folder and
 * public web pages need no answer (the owner can have public pages asked about too:
 * `askBeforeBrowsing`). Attended, the first use of any other folder (or of this computer's own or its
 * network's addresses) asks the owner once, and the answer covers that call, the mission, or the
 * folder from then on. Unattended, it runs inside the sandbox. Where this computer's sandbox is weak,
 * "always" does not cover commands, and commands ask once per mission even in the node's own folder.
 *
 * Answers come from Needs me on the web, so they count only while this computer accepts approvals
 * from the web (`acceptWebApprovals`); otherwise web settings only narrow, and the mode is attended.
 */
import type { PrismaClient } from "@prisma/client";
import type { NodeToolAsk, NodeToolGrant } from "../remote/contract.js";

/** `decision_rules.source` for the owner's answers to node tools on this computer. */
export const NODE_TOOL_RULE_SOURCE = "node-tools";

export type ToolCapability = NodeToolAsk["capability"];

export type PolicyInput = {
  capability: ToolCapability;
  /** The folder's real path, or the address's origin. */
  target: string;
  label: string;
  scope: NodeToolAsk["scope"];
  mission: string;
  attended: boolean;
  grants: NodeToolGrant[];
  /** The node's own folder on this computer (device-tools/folders.ts `ownToolFolder`). */
  own?: boolean;
  /** browse: the address is a public web page, not this computer's or its network's. */
  publicWeb?: boolean;
};

export type Verdict = { kind: "allow"; grantsUsed: string[] } | { kind: "ask"; ask: NodeToolAsk; grantsUsed: string[] } | { kind: "refuse"; status: 409; reason: string };

type Db = Pick<PrismaClient, "decisionRule">;

/** The decision rule's tool name for a scope: one answer covers every tool in a folder, or every call to an address. */
const ruleTool = (scope: NodeToolAsk["scope"]) => (scope === "origin" ? "origin" : "folder");

export async function decide(prisma: Db, userId: string, input: PolicyInput, options: { weak: boolean; acceptWeb: boolean; askBeforeBrowsing?: boolean }): Promise<Verdict> {
  // An answer the owner gave before nothing asked any more is still marked used, so the web stops sending it.
  const settled = () => ({ kind: "allow" as const, grantsUsed: options.acceptWeb ? input.grants.filter((grant) => grant.target === input.target).map((grant) => grant.id) : [] });
  if (input.own && !(options.weak && input.capability === "run")) return settled();
  if (input.capability === "browse" && input.publicWeb && !options.askBeforeBrowsing) return settled();
  const toolName = ruleTool(input.scope);
  // "Always" is not enough for commands where the sandbox is weak: they ask once per mission.
  const alwaysCounts = !(options.weak && input.capability === "run");
  const grantsUsed: string[] = [];
  if (options.acceptWeb) {
    for (const grant of input.grants) {
      if (grant.target !== input.target) continue;
      grantsUsed.push(grant.id);
      if (grant.scope === "once") return { kind: "allow", grantsUsed };
      const always = grant.scope === "always" && alwaysCounts;
      const sessionId = always ? null : input.mission;
      const existing = await prisma.decisionRule.findFirst({ where: { userId, source: NODE_TOOL_RULE_SOURCE, toolName, pattern: input.target, decision: "allow", sessionId } });
      if (!existing) await prisma.decisionRule.create({ data: { userId, source: NODE_TOOL_RULE_SOURCE, toolName, pattern: input.target, decision: "allow", sessionId } });
      return { kind: "allow", grantsUsed };
    }
  }
  const rules = await prisma.decisionRule.findMany({ where: { userId, source: NODE_TOOL_RULE_SOURCE, toolName, pattern: input.target, decision: "allow" }, select: { sessionId: true } });
  if (rules.some((rule) => rule.sessionId === input.mission || (rule.sessionId === null && alwaysCounts))) return { kind: "allow", grantsUsed };
  if (!input.attended && options.acceptWeb) return { kind: "allow", grantsUsed };
  if (!options.acceptWeb) {
    return {
      kind: "refuse",
      status: 409,
      reason: "This computer takes approvals only on itself (approvals from the web are off), so a node's first use of a folder cannot be approved. Turn them on there with `ensemble approvals on`.",
    };
  }
  return { kind: "ask", ask: { capability: input.capability, target: input.target, label: input.label, scope: input.scope, weak: options.weak && input.capability === "run" }, grantsUsed };
}
