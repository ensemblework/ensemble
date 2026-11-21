/**
 * A node's desktop tools on this computer (docs/25 §11): `node.tool.request` with `tool: "desktop"`, run
 * by the desktop service for the node's mission (`node:<nodeId>:<mission>` drives the desktop while it
 * works). A sensitive app is the policy's (device-tools/policy.ts, scope `app`): attended, the owner is
 * asked once per app and mission; unattended, it is allowed. The hard floor is the service's and is never
 * asked about. A saved recording is the node's evidence (device-tools/capture.ts `keepEvidence`), held
 * for the owner's preview; the model's screenshots are not evidence and come back only to the model.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config.js";
import { keepEvidence } from "../../device-tools/capture.js";
import { decide } from "../../device-tools/policy.js";
import { capturedFiles } from "../../evidence/captures.js";
import { operationEvidenceDir } from "../../evidence/files.js";
import { appendLedger } from "../../lib/ledger.js";
import type { HostedClient } from "../../remote/client.js";
import type { NodeDesktopAnswer, NodeToolAsk, NodeToolRequest } from "../../remote/contract.js";
import { loadSettings } from "../../remote/store.js";
import { desktopService, UNSUPPORTED_HERE } from "./index.js";
import { secretFor } from "./secrets.js";
import { DesktopError, type Caller, type DesktopService, type GateAnswer, type GateApp, type Observation } from "./service.js";
import { actText, appsText, failureText, observationText, openText, recordingText, statusText } from "./text.js";
import { DESKTOP_TOOLS, DESKTOP_TRANSPORT_MS, desktopTimeoutMs, type DesktopStep } from "./tool-specs.js";

export type DesktopRequest = Extract<NodeToolRequest, { tool: "desktop" }>;
type App = Pick<FastifyInstance, "prisma">;
export type DesktopDone = { status: number; body: Record<string, unknown>; grantsUsed: string[] };

/** The ask a sensitive app raises: once per app and mission, on the node's card. */
export function appAsk(app: GateApp): NodeToolAsk {
  return { capability: "desktop", target: app.id, label: app.name, scope: "app", weak: false };
}

function image(observation: Observation | null | undefined): NodeDesktopAnswer["image"] {
  if (!observation) return undefined;
  const mime = observation.image.mime === "image/png" ? "image/png" : "image/jpeg";
  return { captureId: observation.captureId, mime, width: observation.image.width, height: observation.image.height, ...(observation.image.base64 ? { base64: observation.image.base64 } : {}) };
}

/** What the agent reads besides the summary: small, without the screenshot or element lists. */
function lean(observation: Observation | null | undefined): Record<string, unknown> | undefined {
  if (!observation) return undefined;
  return { captureId: observation.captureId, display: observation.display.id, image: { width: observation.image.width, height: observation.image.height }, app: observation.focus?.app ?? null, elements: observation.tree?.elements.length ?? 0 };
}

export async function runNodeDesktop(app: App, client: HostedClient, request: DesktopRequest, injected?: DesktopService): Promise<DesktopDone> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const grantsUsed: string[] = [];
  const answer = (status: number, body: Record<string, unknown>): DesktopDone => ({ status, body, grantsUsed });
  const spec = DESKTOP_TOOLS.find((item) => item.name === request.name);
  if (!spec) return answer(400, { error: `Unknown desktop tool ${request.name}. Update Ensemble on this computer.` });
  if (process.platform !== "linux") return answer(409, { error: UNSUPPORTED_HERE });
  const parsed = (spec.input as z.ZodTypeAny).safeParse(request.input ?? {});
  if (!parsed.success) return answer(200, { ok: false, error: { code: "bad_input", message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ").slice(0, 2000) }, evidence: [], refused: [] });
  const input = parsed.data as Record<string, unknown>;
  const settings = loadSettings();
  const gate = async (target: GateApp): Promise<GateAnswer> => {
    const verdict = await decide(app.prisma, userId, { capability: "desktop", target: target.id, label: target.name, scope: "app", mission: request.mission, attended: request.attended, grants: request.grants }, { weak: false, acceptWeb: settings.acceptWebApprovals });
    for (const id of "grantsUsed" in verdict ? verdict.grantsUsed : []) if (!grantsUsed.includes(id)) grantsUsed.push(id);
    if (verdict.kind === "allow") return { allow: true };
    if (verdict.kind === "ask") return { allow: false, ask: true };
    return { allow: false, ask: false, reason: verdict.reason };
  };
  const caller: Caller = {
    key: `node:${request.nodeId}:${request.mission}`,
    label: request.nodeSlug ? `@${request.nodeSlug}'s other work` : "another conversation",
    budgetMs: Math.max(10_000, desktopTimeoutMs(request.name, input) - DESKTOP_TRANSPORT_MS),
    inline: request.inlineImage,
    gate,
    secret: (name, where) => secretFor(app.prisma as never, userId, name, where.origin),
  };
  const service = injected ?? desktopService();
  const ok = (summary: string, extra: Record<string, unknown> = {}) => answer(200, { ok: true, summary, evidence: [], refused: [], ...extra });
  try {
    let done: DesktopDone;
    switch (request.name) {
      case "desktop_status": {
        const status = await service.status(caller.budgetMs);
        done = ok(statusText(status), { result: { session: status.session, lease: status.lease } });
        break;
      }
      case "desktop_apps": {
        const apps = await service.apps(input as { query?: string; running?: boolean }, caller.budgetMs);
        done = ok(appsText(apps));
        break;
      }
      case "desktop_open": {
        const opened = await service.open(caller, input as { app: string; waitSec?: number });
        done = ok(openText(opened), { result: opened });
        break;
      }
      case "desktop_observe": {
        const observation = await service.observe(caller, input as { display?: string; app?: string; elements?: boolean; maxElements?: number });
        done = ok(observationText(observation), { result: lean(observation), image: image(observation) });
        break;
      }
      case "desktop_zoom": {
        const zoomed = await service.zoom(caller, input as { captureId: string; box: [number, number, number, number] });
        done = ok(observationText(zoomed), { result: lean(zoomed), image: image(zoomed) });
        break;
      }
      case "desktop_act": {
        const acted = await service.act(caller, input as { captureId?: string; steps: DesktopStep[]; observe?: boolean });
        if (acted.needsOwner && acted.ran === 0) return answer(428, { ask: appAsk(acted.needsOwner) });
        for (const step of acted.steps) {
          if (step.rule) await appendLedger({ userId, actor: "agent", action: "node.tool.refused", payload: { nodeId: request.nodeId, tool: "desktop", rule: step.rule } }).catch(() => undefined);
        }
        done = ok(actText(acted), { result: { ran: acted.ran, steps: acted.steps.map(({ index, action, verdict, ran }) => ({ index, action, verdict, ran })), ...(acted.observation ? { observation: lean(acted.observation) } : {}) }, image: image(acted.observation) });
        break;
      }
      case "desktop_record": {
        const action = input.action as "start" | "save" | "discard";
        if (action === "start") {
          const started = await service.recordStart(caller, { display: input.display as string | undefined, maxSec: input.maxSec as number | undefined, evidenceDir: operationEvidenceDir(request.operation) });
          done = ok(`Recording screen ${started.display} (${started.container}), for at most ${started.maxSec} s. Save it with desktop_record save, or discard it.`, { result: started });
        } else if (action === "discard") {
          await service.recordDiscard(caller);
          done = ok("The recording was discarded.");
        } else {
          if (!request.uploadId) return answer(400, { error: "Saving a recording needs its upload id. Update Ensemble on the web." });
          const saved = await service.recordSave(caller, { name: input.name as string | undefined });
          const kept = await keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId }, capturedFiles({ file: saved }));
          done = answer(200, { ok: true, summary: recordingText(saved), result: { durationMs: saved.durationMs, width: saved.width, height: saved.height, codec: saved.codec, sha256: saved.sha256 }, ...kept });
        }
        break;
      }
      case "desktop_handoff": {
        const handed = await service.handoff(caller, input as { action?: "ask" | "release" | "status"; reason?: string; message?: string; waitSec?: number });
        done = ok(handed.detail, { result: handed });
        break;
      }
      default:
        return answer(400, { error: `Unknown desktop tool ${request.name}.` });
    }
    await appendLedger({ userId, actor: "agent", action: "node.tool.desktop", payload: { nodeId: request.nodeId, name: request.name, ...(request.operationId ? { operationId: request.operationId } : {}) } }).catch(() => undefined);
    return done;
  } catch (error) {
    if (error instanceof DesktopError) {
      // A sensitive app before anything ran: the owner's card, then the same call again.
      if (error.code === "needs_owner" && error.extra.app) return answer(428, { ask: appAsk(error.extra.app as GateApp) });
      if (error.code === "refused" && error.extra.rule) {
        await appendLedger({ userId, actor: "agent", action: "node.tool.refused", payload: { nodeId: request.nodeId, tool: "desktop", rule: String(error.extra.rule) } }).catch(() => undefined);
      }
      return answer(200, { ok: false, error: { code: error.code.slice(0, 40), message: failureText(error).slice(0, 2000) }, evidence: [], refused: [] });
    }
    throw error;
  }
}
