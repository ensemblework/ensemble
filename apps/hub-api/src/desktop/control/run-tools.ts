/**
 * The desktop tools on a coding run's MCP server (scripts/ensemble-ask-mcp.mjs, evidence/capture-tools.ts):
 * the same service as a node's, with the run as the controller (`run:<jobId>`). A sensitive app asks
 * the person once per app and run through the run's own questions (`allowOrRefuse`); an unattended run
 * goes ahead above the floor; a read-only run only looks. A saved recording is the run's evidence, held
 * for the person's preview. Screenshots come back to the agent as pictures (images.ts).
 */
import { z } from "zod";
import { inputSchema } from "../../browser/tool-specs.js";
import { capturedFiles, recordCaptures, recordedNote } from "../../evidence/captures.js";
import { prepareEvidenceDir } from "../../evidence/files.js";
import { inScope, savedSecretValues, secretScopeOf } from "../../lib/run-secrets.js";
import { allowOrRefuse, type JobContext } from "../../workspace/tools.js";
import { secretFor } from "./secrets.js";
import { withDesktopImages } from "./images.js";
import { desktopService, UNSUPPORTED_HERE } from "./index.js";
import { SENSITIVE_WORDS } from "./sensitive.js";
import { DesktopError, type Caller, type GateAnswer, type Observation } from "./service.js";
import { actText, appsText, failureText, imageMarker, observationText, openText, recordingText, statusText } from "./text.js";
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

const withImage = (text: string, observation: Observation | null | undefined) => (observation ? `${text}\n${imageMarker(observation.captureId)}` : text);

export async function runRunDesktopTool(ctx: JobContext, name: string, raw: unknown): Promise<{ ok: boolean; text: string }> {
  const spec = DESKTOP_TOOLS.find((item) => item.name === name);
  if (!spec) return { ok: false, text: `Unknown desktop tool ${name}.` };
  if (process.platform !== "linux") return { ok: false, text: UNSUPPORTED_HERE };
  const parsed = (spec.input as z.ZodTypeAny).safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, text: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
  const input = parsed.data as Record<string, unknown>;
  if (ACTING.has(name) && ctx.accessMode === "review") return { ok: false, text: "This run is read-only: it may look at the screen (desktop_observe, desktop_zoom) but not act on it." };
  const scope = secretScopeOf(ctx.job.context);
  const gate = async (app: { id: string; name: string; category: keyof typeof SENSITIVE_WORDS }): Promise<GateAnswer> => {
    const held = await allowOrRefuse(ctx, "escape", true, { toolName: "desktop_app", title: `Use ${app.name} (${SENSITIVE_WORDS[app.category]}) on your screen`, command: app.id });
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
  const service = desktopService();
  try {
    let text: string;
    switch (spec.name) {
      case "desktop_status":
        text = statusText(await service.status(caller.budgetMs));
        break;
      case "desktop_apps":
        text = appsText(await service.apps(input as { query?: string; running?: boolean }, caller.budgetMs));
        break;
      case "desktop_open":
        text = openText(await service.open(caller, input as { app: string; waitSec?: number }));
        break;
      case "desktop_observe": {
        const observation = await service.observe(caller, input as { display?: string; app?: string; elements?: boolean; maxElements?: number });
        text = withImage(observationText(observation), observation);
        break;
      }
      case "desktop_zoom": {
        const zoomed = await service.zoom(caller, input as { captureId: string; box: [number, number, number, number] });
        text = withImage(observationText(zoomed), zoomed);
        break;
      }
      case "desktop_act": {
        const acted = await service.act(caller, input as { captureId?: string; steps: DesktopStep[]; observe?: boolean });
        text = withImage(actText(acted), acted.observation);
        break;
      }
      case "desktop_record": {
        const action = input.action as "start" | "save" | "discard";
        const evidenceDir = await prepareEvidenceDir(ctx.prisma, ctx.job.id);
        if (action === "start") {
          const started = await service.recordStart(caller, { display: input.display as string | undefined, maxSec: input.maxSec as number | undefined, evidenceDir });
          text = `Recording screen ${started.display} (${started.container}), for at most ${started.maxSec} s. Save it with desktop_record save, or discard it.`;
        } else if (action === "discard") {
          await service.recordDiscard(caller);
          text = "The recording was discarded.";
        } else {
          const saved = await service.recordSave(caller, { name: input.name as string | undefined });
          const recorded = await recordCaptures(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id }, capturedFiles({ file: saved }), await savedSecretValues(ctx.prisma, ctx.userId).catch(() => []));
          for (const row of recorded.rows) await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: name, ...(row.held ? { held: true } : {}) });
          text = [recordingText(saved), recordedNote(recorded)].filter(Boolean).join("\n");
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
