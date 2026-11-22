/**
 * A node's desktop tools on this computer (docs/25 §11): `node.tool.request` with `tool: "desktop"`, run
 * on the agent screen or the owner's screen (screens.ts) for the node's mission (`node:<nodeId>:<mission>`
 * drives that screen while it works). A sensitive app, and the owner's own pointer and keyboard
 * (`screen:owner`), are the policy's (device-tools/policy.ts, scope `app`): attended, the owner is asked
 * once per app and mission; unattended, it is allowed. The hard floor is the service's and is never asked
 * about. A saved recording, and a screenshot the node shares (`share`), is the node's evidence
 * (device-tools/capture.ts `keepEvidence`), held for the owner's preview; its other screenshots come back
 * only to the model.
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
import { desktops, desktopSystem, UNSUPPORTED_HERE, WINDOWS_UNSUPPORTED } from "./index.js";
import { desktopReadiness } from "./readiness.js";
import type { Desktops } from "./screens.js";
import { secretFor } from "./secrets.js";
import { DesktopError, type Caller, type GateAnswer, type GateApp, type Observation, type ScreenName } from "./service.js";
import { actText, appsText, failureText, observationText, openText, recordingText, recordStartText, statusText } from "./text.js";
import { DESKTOP_TOOLS, DESKTOP_TRANSPORT_MS, desktopTimeoutMs, type DesktopStep } from "./tool-specs.js";

export type DesktopRequest = Extract<NodeToolRequest, { tool: "desktop" }>;
type App = Pick<FastifyInstance, "prisma">;
export type DesktopDone = { status: number; body: Record<string, unknown>; grantsUsed: string[] };

/** The ask a sensitive app raises, naming the screen it is on: once per app and mission, on the node's card. */
export function appAsk(app: GateApp, screen: ScreenName): NodeToolAsk {
  return { capability: "desktop", target: app.id, label: app.name, scope: "app", weak: false, screen };
}

function image(observation: Observation | null | undefined): NodeDesktopAnswer["image"] {
  if (!observation?.image) return undefined;
  const mime = observation.image.mime === "image/png" ? "image/png" : "image/jpeg";
  return { captureId: observation.captureId, mime, width: observation.image.width, height: observation.image.height, ...(observation.image.base64 ? { base64: observation.image.base64 } : {}) };
}

/** What the agent reads besides the summary: small, without the screenshot or element lists. */
function lean(observation: Observation | null | undefined): Record<string, unknown> | undefined {
  if (!observation) return undefined;
  return {
    screen: observation.screen,
    captureId: observation.captureId,
    display: observation.display?.id ?? null,
    image: observation.image ? { width: observation.image.width, height: observation.image.height } : null,
    app: observation.focus?.app ?? observation.tree?.app ?? null,
    elements: observation.tree?.elements.length ?? 0,
  };
}

export async function runNodeDesktop(app: App, client: HostedClient, request: DesktopRequest, injected?: Desktops): Promise<DesktopDone> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const grantsUsed: string[] = [];
  const answer = (status: number, body: Record<string, unknown>): DesktopDone => ({ status, body, grantsUsed });
  const spec = DESKTOP_TOOLS.find((item) => item.name === request.name);
  if (!spec) return answer(400, { error: `Unknown desktop tool ${request.name}. Update Ensemble on this computer.` });
  if (!desktopSystem()) return answer(409, { error: process.platform === "win32" ? WINDOWS_UNSUPPORTED : UNSUPPORTED_HERE });
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
  const screens = injected ?? desktops();
  const steps = Array.isArray(input.steps) ? (input.steps as DesktopStep[]) : [];
  const screen =
    request.name === "desktop_open" && !input.screen
      ? await screens.opening(caller.key, async () => (await desktopReadiness()).agentScreen.ready)
      : screens.pick(caller.key, {
          screen: input.screen as ScreenName | undefined,
          captureId: (input.captureId as string | undefined) ?? steps.find((step) => step.captureId)?.captureId,
          recording: request.name === "desktop_record" && input.action !== "start",
        });
  // Handing over is of the owner's screen only: the agent screen is the agent's own.
  const service = request.name === "desktop_handoff" ? screens.owner : screens.service(screen);
  const ok = (summary: string, extra: Record<string, unknown> = {}) => answer(200, { ok: true, summary, evidence: [], refused: [], ...extra });
  const share = (request.name === "desktop_observe" || request.name === "desktop_zoom") && input.share === true;
  if (share && input.screenshot === false) return answer(200, { ok: false, error: { code: "bad_input", message: "share sends a screenshot, so it needs one: drop screenshot false." }, evidence: [], refused: [] });
  if (share && !request.uploadId) return answer(400, { error: "Sharing a screenshot needs its upload id. Update Ensemble on the web." });
  /** The look's screenshot as the node's evidence, for its owner (held for their preview). */
  const shared = async (look: Observation) =>
    keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId! }, capturedFiles({ file: await service.shareCapture(caller, look.captureId, operationEvidenceDir(request.operation)) }));
  try {
    let done: DesktopDone;
    switch (request.name) {
      case "desktop_status": {
        const both = await screens.status(caller.budgetMs, () => desktopReadiness());
        done = ok(statusText(both), { result: { owner: { session: both.owner.session, lease: both.owner.lease }, agent: both.agent ? { session: both.agent.session } : { ready: both.agentReadiness.ready, running: false } } });
        break;
      }
      case "desktop_apps": {
        const apps = await screens.apps(input as { query?: string; running?: boolean; screen?: ScreenName }, caller.budgetMs);
        done = ok(appsText(apps));
        break;
      }
      case "desktop_open": {
        const opened = await service.open(caller, input as { app: string; waitSec?: number });
        screens.remember(caller.key, service.screenName);
        done = ok(openText(opened), { result: opened });
        break;
      }
      case "desktop_observe": {
        const observation = await service.observe(caller, input as { display?: string; app?: string; elements?: boolean; maxElements?: number; screenshot?: boolean });
        screens.remember(caller.key, service.screenName);
        done = ok(observationText(observation), { result: lean(observation), image: image(observation), ...(share ? await shared(observation) : {}) });
        break;
      }
      case "desktop_zoom": {
        const zoomed = await service.zoom(caller, input as { captureId: string; box: [number, number, number, number] });
        done = ok(observationText(zoomed), { result: lean(zoomed), image: image(zoomed), ...(share ? await shared(zoomed) : {}) });
        break;
      }
      case "desktop_act": {
        const acted = await service.act(caller, input as { captureId?: string; steps: DesktopStep[]; observe?: boolean; foreground?: boolean });
        if (acted.needsOwner && acted.ran === 0) return answer(428, { ask: appAsk(acted.needsOwner, service.screenName) });
        screens.remember(caller.key, service.screenName);
        for (const step of acted.steps) {
          if (step.rule) await appendLedger({ userId, actor: "agent", action: "node.tool.refused", payload: { nodeId: request.nodeId, tool: "desktop", rule: step.rule } }).catch(() => undefined);
        }
        done = ok(actText(acted), { result: { screen: acted.screen, mode: acted.mode, ran: acted.ran, steps: acted.steps.map(({ index, action, verdict, ran, code }) => ({ index, action, verdict, ran, ...(code ? { code } : {}) })), ...(acted.observation ? { observation: lean(acted.observation) } : {}) }, image: image(acted.observation) });
        break;
      }
      case "desktop_record": {
        const action = input.action as "start" | "save" | "discard";
        if (action === "start") {
          const started = await service.recordStart(caller, { display: input.display as string | undefined, maxSec: input.maxSec as number | undefined, evidenceDir: operationEvidenceDir(request.operation) });
          screens.remember(caller.key, service.screenName);
          done = ok(recordStartText(started), { result: started });
        } else if (action === "discard") {
          await service.recordDiscard(caller);
          done = ok("The recording was discarded.");
        } else {
          if (!request.uploadId) return answer(400, { error: "Saving a recording needs its upload id. Update Ensemble on the web." });
          const saved = await service.recordSave(caller, { name: input.name as string | undefined });
          const kept = await keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId }, capturedFiles({ file: saved }));
          done = answer(200, { ok: true, summary: recordingText(saved, service.screenName), result: { screen: service.screenName, durationMs: saved.durationMs, width: saved.width, height: saved.height, codec: saved.codec, sha256: saved.sha256 }, ...kept });
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
      if (error.code === "needs_owner" && error.extra.app) return answer(428, { ask: appAsk(error.extra.app as GateApp, service.screenName) });
      if (error.code === "refused" && error.extra.rule) {
        await appendLedger({ userId, actor: "agent", action: "node.tool.refused", payload: { nodeId: request.nodeId, tool: "desktop", rule: String(error.extra.rule) } }).catch(() => undefined);
      }
      return answer(200, { ok: false, error: { code: error.code.slice(0, 40), message: failureText(error).slice(0, 2000) }, evidence: [], refused: [] });
    }
    throw error;
  }
}
