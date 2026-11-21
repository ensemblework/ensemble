/**
 * A node's desktop tools (docs/35 §8.16): a private agent screen on its owner's paired computer, and their
 * real screen, through `node.tool.request` with `tool: "desktop"` (desktop/control/device.ts there). Like
 * the browser and capture tools they work only in a turn only the owner reads and started; a sensitive
 * app, and the owner's own pointer and keyboard, ask the owner once per mission on a card in this chat.
 * The model sees each screenshot:
 * as a picture with the tool's result on Ensemble's API, or (on the owner's own subscription) through
 * the line images.ts turns into one on the computer. The owner sees a screenshot only when the node
 * shares it (desktop_observe or desktop_zoom with `share`), and a saved recording: both are evidence,
 * held for the owner's preview on a card in this chat.
 */
import { z } from "zod";
import type { Device } from "@prisma/client";
import { defineTool, ToolBlockedError, type AnyHubTool, type ToolResult } from "../../assistant/types.js";
import { grantUpload } from "../../evidence/grants.js";
import { DESKTOP_API, NodeDesktopAnswer } from "../../remote/contract.js";
import { callComputer, callText, captureOperation, isResult, keepCaptures, missionOf } from "../../node/device-tools.js";
import { recordingEnded, recordingStarted } from "../../node/recordings.js";
import type { NodeScope } from "../../node/tools.js";
import { imageMarker } from "./text.js";
import { DESKTOP_TOOLS, desktopTimeoutMs } from "./tool-specs.js";

const computer = z.string().max(120).optional().describe("The computer's name, when your owner has more than one.");

/**
 * The computer must answer desktop calls (`capabilities.desktop`) and, but for desktop_status, have a screen
 * ready for them, or (macOS) be able to read and press elements in the background.
 */
export function requireDesktop(device: Pick<Device, "name" | "capabilities">, tool = "desktop_observe"): void {
  const caps = (device.capabilities ?? {}) as { desktop?: unknown; desktopReadiness?: { ready?: unknown; reason?: unknown; background?: unknown; agentScreen?: { ready?: unknown; reason?: unknown } } | null };
  if (!(typeof caps.desktop === "number" && caps.desktop >= DESKTOP_API)) {
    // A system without desktop control in this version (Windows) says so in its readiness.
    if (typeof caps.desktopReadiness?.reason === "string") throw new ToolBlockedError(`${device.name} cannot control its desktop: ${caps.desktopReadiness.reason}`, "Tell your owner in one line if they asked for it; use the browser tools and computer_run instead.");
    throw new ToolBlockedError(`Update Ensemble on ${device.name} to control its desktop: it is too old for it, or not on Linux or macOS.`, "Your owner updates it there (`ensemble update`, or the desktop app's update). Until then use the browser tools and computer_run.");
  }
  const ready = caps.desktopReadiness;
  // Either screen will do: the agent screen works without the owner's session, the owner's without GNOME Shell's headless mode.
  if (tool !== "desktop_status" && ready && ready.ready === false && ready.agentScreen?.ready !== true && ready.background !== true && typeof ready.reason === "string") {
    const agent = typeof ready.agentScreen?.reason === "string" ? ` The agent screen: ${ready.agentScreen.reason}` : "";
    throw new ToolBlockedError(`${device.name} cannot control its desktop yet: ${ready.reason}${agent}`, "Tell your owner in one line what it needs.");
  }
}

function describe(name: string, input: Record<string, unknown>): string {
  if (name === "desktop_open") return `Open ${String(input.app ?? "an app")} on the screen`;
  if (name === "desktop_act") return "Use the screen";
  if ((name === "desktop_observe" || name === "desktop_zoom") && input.share === true) return "Show you a screenshot of the screen";
  if (name === "desktop_record") return `${input.action === "start" ? "Record" : input.action === "save" ? "Save the recording of" : "Discard the recording of"} the screen`;
  return name.replace("desktop_", "Desktop ");
}

export function desktopTools(scope: NodeScope): AnyHubTool[] {
  const { node } = scope;
  return DESKTOP_TOOLS.map((spec) =>
    defineTool({
      name: spec.name,
      area: "tasks",
      description: `On your owner's computer: ${spec.description}`,
      input: (spec.input as unknown as z.AnyZodObject).extend({ computer }),
      isWrite: false,
      ...("readOnly" in spec && spec.readOnly ? { readOnly: true } : {}),
      risk: spec.name === "desktop_act" || spec.name === "desktop_open" || spec.name === "desktop_record" ? "medium" : "low",
      async run(ctx, raw): Promise<ToolResult> {
        const { computer: name, ...input } = raw as Record<string, unknown> & { computer?: string };
        const operation = captureOperation(scope);
        const saving = spec.name === "desktop_record" && input.action === "save";
        const sharing = (spec.name === "desktop_observe" || spec.name === "desktop_zoom") && input.share === true;
        const done = await callComputer(
          ctx,
          scope,
          name,
          // On the owner's own subscription the picture comes from the computer itself (images.ts), not in the answer.
          { tool: "desktop", name: spec.name, input, operation, inlineImage: !ctx.ownPlan },
          {
            timeoutMs: desktopTimeoutMs(spec.name, input),
            describe: describe(spec.name, input),
            again: callText(spec.name, raw),
            before: async (device) => {
              requireDesktop(device, spec.name);
              // A saved recording or a shared screenshot has somewhere to go before the computer makes it.
              return saving || sharing ? { uploadId: await grantUpload(ctx.app.redis as never, { mode: "new", deviceId: device.id, ownerId: node.userId, nodeId: node.id, operation }) } : {};
            },
          },
        );
        if (isResult(done)) return done;
        const kept = await keepCaptures(ctx, scope, done, operation, "pictures", saving ? "video" : sharing ? "picture" : undefined);
        const parsed = NodeDesktopAnswer.safeParse(done.body);
        // A recording going on is the node's until it is saved or discarded: a stop discards it (node/stop.ts).
        if (spec.name === "desktop_record" && parsed.success && parsed.data.ok) {
          const where = { deviceId: done.device.id, mission: missionOf(scope) };
          if (input.action === "start") await recordingStarted(ctx.app.redis as never, node.id, where);
          else await recordingEnded(ctx.app.redis as never, node.id, where);
        }
        const picture = parsed.success ? parsed.data.image : undefined;
        const lines = [...kept.lines];
        if (picture && ctx.ownPlan) lines.push(imageMarker(picture.captureId));
        const result = parsed.success && parsed.data.result !== undefined ? { result: parsed.data.result } : {};
        return {
          summary: lines.join("\n"),
          data: { computer: done.device.name, ...(kept.evidence.length ? { evidence: kept.evidence } : {}), ...result },
          ...(picture?.base64 ? { pictures: [{ type: "text" as const, text: `Screenshot ${picture.captureId} (${picture.width}×${picture.height})` }, { type: "image_url" as const, image_url: { url: `data:${picture.mime};base64,${picture.base64}` } }] } : {}),
        };
      },
    }),
  );
}
