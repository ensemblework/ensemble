/**
 * The desktop tools on a coding run's MCP server (scripts/ensemble-ask-mcp.mjs, evidence/capture-tools.ts):
 * the same screens as a node's (screens.ts), with the run as the controller (`run:<jobId>`). A sensitive
 * app, and the person's own pointer and keyboard, ask once per app and run through the run's own questions
 * (`allowOrRefuse`); an unattended run goes ahead above the floor; a read-only run only looks. A saved
 * recording, and a screenshot the agent shares (`share`), is the run's evidence, held for the person's
 * preview. Screenshots come back to the agent as pictures (images.ts).
 */
import { z } from "zod";
import { inputSchema } from "../../browser/tool-specs.js";
import { capturedFiles, recordCaptures, recordedNote } from "../../evidence/captures.js";
import { prepareEvidenceDir } from "../../evidence/files.js";
import { inScope, savedSecretValues, secretScopeOf } from "../../lib/run-secrets.js";
import { allowOrRefuse, type JobContext } from "../../workspace/tools.js";
import { secretFor } from "./secrets.js";
import { withDesktopImages } from "./images.js";
import { desktops, UNSUPPORTED_HERE } from "./index.js";
import { desktopReadiness } from "./readiness.js";
import type { Desktops } from "./screens.js";
import { GATE_WORDS } from "./sensitive.js";
import { DesktopError, type Caller, type GateAnswer, type GateApp, type Observation, type ScreenName } from "./service.js";
import { actText, appsText, failureText, imageMarker, observationText, openText, recordingText, recordStartText, statusText } from "./text.js";
import { DESKTOP_TOOLS, desktopTimeoutMs, isDesktopTool, type DesktopStep } from "./tool-specs.js";

export const DESKTOP_RUN_TOOLS: readonly string[] = DESKTOP_TOOLS.map((tool) => tool.name);
export { isDesktopTool };

/** What a run's MCP server lists: the desktop tools on Linux, nothing elsewhere. */
export function desktopToolDefinitions(platform: string = process.platform): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  if (platform !== "linux") return [];
  return DESKTOP_TOOLS.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: inputSchema(spec) }));
}

/** Tools that change the screen: a read-only run does not use them. */
const ACTING = new Set(["desktop_open", "desktop_act", "desktop_record", "desktop_handoff"]);

const withImage = (text: string, observation: Observation | null | undefined) => (observation?.image ? `${text}\n${imageMarker(observation.captureId)}` : text);

export async function runRunDesktopTool(ctx: JobContext, name: string, raw: unknown, injected?: Desktops): Promise<{ ok: boolean; text: string }> {
  const spec = DESKTOP_TOOLS.find((item) => item.name === name);
  if (!spec) return { ok: false, text: `Unknown desktop tool ${name}.` };
  if (process.platform !== "linux") return { ok: false, text: UNSUPPORTED_HERE };
  const parsed = (spec.input as z.ZodTypeAny).safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, text: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
  const input = parsed.data as Record<string, unknown>;
  if (ACTING.has(name) && ctx.accessMode === "review") return { ok: false, text: "This run is read-only: it may look at the screen (desktop_observe, desktop_zoom) but not act on it." };
  const share = (name === "desktop_observe" || name === "desktop_zoom") && input.share === true;
  if (share && input.screenshot === false) return { ok: false, text: "share sends a screenshot, so it needs one: drop screenshot false." };
  const scope = secretScopeOf(ctx.job.context);
  const gate = async (app: GateApp): Promise<GateAnswer> => {
    const title = app.category === "screen" ? "Use your own screen's pointer and keyboard" : `Use ${app.name} (${GATE_WORDS[app.category]}) on your computer`;
    const held = await allowOrRefuse(ctx, "escape", true, { toolName: "desktop_app", title, command: app.id });
    if (!held) return { allow: true };
    const why = (held.result as { error?: unknown } | undefined)?.error;
    return { allow: false, ask: false, reason: typeof why === "string" ? why : "The person did not allow it." };
  };
  const caller: Caller = {
    key: `run:${ctx.job.id}`,
    label: `the run “${ctx.taskTitle.slice(0, 60)}”`,
    budgetMs: Math.max(10_000, desktopTimeoutMs(name, input) - 5_000),
    gate,
    secret: async (secret, where) => (inScope(scope, secret) ? secretFor(ctx.prisma, ctx.userId, secret, where.origin) : null),
  };
  const screens = injected ?? desktops();
  const steps = Array.isArray(input.steps) ? (input.steps as DesktopStep[]) : [];
  const screen = screens.pick(caller.key, {
    screen: input.screen as ScreenName | undefined,
    captureId: (input.captureId as string | undefined) ?? steps.find((step) => step.captureId)?.captureId,
    recording: name === "desktop_record" && input.action !== "start",
  });
  // Handing over is of the person's screen only: the agent screen is the agent's own.
  const service = name === "desktop_handoff" ? screens.owner : screens.service(screen);
  const used = () => screens.remember(caller.key, service.screenName);
  /** The look's screenshot as the run's evidence, held for the person's preview; what became of it, in words. */
  const shared = async (look: Observation): Promise<string> => {
    const file = await service.shareCapture(caller, look.captureId, await prepareEvidenceDir(ctx.prisma, ctx.job.id));
    const recorded = await recordCaptures(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id }, capturedFiles({ file }), await savedSecretValues(ctx.prisma, ctx.userId).catch(() => []));
    for (const row of recorded.rows) await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: name, ...(row.held ? { held: true } : {}) });
    return recordedNote(recorded);
  };
  const looked = async (text: string, look: Observation) => withImage(share ? [text, await shared(look)].filter(Boolean).join("\n") : text, look);
  try {
    let text: string;
    switch (spec.name) {
      case "desktop_status":
        text = statusText(await screens.status(caller.budgetMs, () => desktopReadiness()));
        break;
      case "desktop_apps":
        text = appsText(await screens.apps(input as { query?: string; running?: boolean; screen?: ScreenName }, caller.budgetMs));
        break;
      case "desktop_open":
        text = openText(await service.open(caller, input as { app: string; waitSec?: number }));
        used();
        break;
      case "desktop_observe": {
        const observation = await service.observe(caller, input as { display?: string; app?: string; elements?: boolean; maxElements?: number; screenshot?: boolean });
        used();
        text = await looked(observationText(observation), observation);
        break;
      }
      case "desktop_zoom": {
        const zoomed = await service.zoom(caller, input as { captureId: string; box: [number, number, number, number] });
        text = await looked(observationText(zoomed), zoomed);
        break;
      }
      case "desktop_act": {
        const acted = await service.act(caller, input as { captureId?: string; steps: DesktopStep[]; observe?: boolean; foreground?: boolean });
        used();
        text = withImage(actText(acted), acted.observation);
        break;
      }
      case "desktop_record": {
        const action = input.action as "start" | "save" | "discard";
        const evidenceDir = await prepareEvidenceDir(ctx.prisma, ctx.job.id);
        if (action === "start") {
          const started = await service.recordStart(caller, { display: input.display as string | undefined, maxSec: input.maxSec as number | undefined, evidenceDir });
          used();
          text = recordStartText(started);
        } else if (action === "discard") {
          await service.recordDiscard(caller);
          text = "The recording was discarded.";
        } else {
          const saved = await service.recordSave(caller, { name: input.name as string | undefined });
          const recorded = await recordCaptures(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id }, capturedFiles({ file: saved }), await savedSecretValues(ctx.prisma, ctx.userId).catch(() => []));
          for (const row of recorded.rows) await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: name, ...(row.held ? { held: true } : {}) });
          text = [recordingText(saved, service.screenName), recordedNote(recorded)].filter(Boolean).join("\n");
        }
        break;
      }
      case "desktop_handoff":
        text = (await service.handoff(caller, input as { action?: "ask" | "release" | "status"; reason?: string; message?: string; waitSec?: number })).detail;
        break;
      default:
        return { ok: false, text: `Unknown desktop tool ${name}.` };
    }
    return { ok: true, text: (await withDesktopImages({ text })).text };
  } catch (error) {
    if (error instanceof DesktopError) return { ok: false, text: failureText(error) };
    throw error;
  }
}
