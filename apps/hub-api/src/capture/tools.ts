/**
 * The capture tools for both callers (ensemble-node design B19, E§8.5): screenshots and video of a
 * web page, an Electron app, another desktop app or a terminal transcript; starting and stopping an
 * app to capture; the checks that come before sending; and what this computer can capture.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { inputSchema, toolError, type ToolCallResult } from "../browser/tools.js";
import { CaptureError, type MediaFile } from "./media.js";
import type { CaptureRequest, CaptureService, ScreenshotTarget, VideoInput } from "./service.js";
import { CAPTURE_TOOLS } from "./tool-specs.js";

export { CAPTURE_TOOLS };

export type CaptureToolContext = CaptureRequest;

export type CaptureToolName = (typeof CAPTURE_TOOLS)[number]["name"];

export function captureToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return CAPTURE_TOOLS.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: inputSchema(spec) }));
}

export function isCaptureTool(name: string): name is CaptureToolName {
  return CAPTURE_TOOLS.some((spec) => spec.name === name);
}

function describe(file: MediaFile): string {
  const size = file.width ? ` ${file.width}×${file.height}` : "";
  const length = file.durationMs ? `, ${(file.durationMs / 1000).toFixed(1)} s at ${file.fps} fps` : "";
  return `Saved ${file.path}${size}${length}.${file.held ? ` Held for the owner to preview: ${file.reason}` : ""}${file.truncated ? " It reached the length limit." : ""}`;
}

type Args = Record<string, unknown>;

function target(a: Args): ScreenshotTarget {
  switch (a.target) {
    case "web":
      return { kind: "web", url: a.url as string | undefined, tab: a.tab as string | undefined, viewport: a.viewport as never, device: a.device as string | undefined, fullPage: a.fullPage as boolean | undefined, element: a.element as string | undefined, waitFor: a.waitFor as never };
    case "electron":
    case "gui":
      if (!a.app) throw new CaptureError("bad_input", "Give the app's handle from capture_app_start.");
      return { kind: a.target, app: a.app as string, window: a.window as string | undefined };
    case "terminal":
      if (typeof a.transcript !== "string") throw new CaptureError("bad_input", "Give the terminal transcript.");
      return { kind: "terminal", transcript: a.transcript, title: a.title as string | undefined, format: a.format === "html" ? "html" : "png", columns: a.columns as number | undefined };
    default:
      return { kind: "desktop" };
  }
}

async function inside(dir: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CaptureError("bad_input", "Give the file's full path.");
  const [root, real] = await Promise.all([realpath(dir), realpath(path).catch(() => null)]);
  const rel = real ? relative(root, real) : "..";
  if (!real || rel.startsWith("..") || isAbsolute(rel)) throw new CaptureError("refused", "Check images in this work's evidence folder only.");
  return real;
}

/** Validates and runs one capture tool call. Never throws. */
export async function runCaptureTool(service: CaptureService, name: string, input: unknown, context: CaptureToolContext): Promise<ToolCallResult> {
  const spec = CAPTURE_TOOLS.find((item) => item.name === name);
  if (!spec) return { ok: false, error: { code: "bad_input", message: `Unknown capture tool ${name}.` } };
  try {
    const a = spec.input.parse(input ?? {}) as Args;
    switch (spec.name) {
      case "capture_screenshot": {
        const file = await service.screenshot(context, target(a), a.name as string | undefined);
        return { ok: true, summary: describe(file), result: file };
      }
      case "capture_video": {
        const shot = target(a);
        if (shot.kind === "terminal") throw new CaptureError("not_supported", "A terminal is captured as its transcript, not as video.");
        const request: VideoInput = { target: shot, durationSec: a.durationSec as number, mode: a.mode as "realtime" | undefined, fps: a.fps as number | undefined, steps: a.steps as never, name: a.name as string | undefined };
        const file = await service.video(context, request);
        return { ok: true, summary: describe(file), result: file };
      }
      case "capture_app_start": {
        const size = a.width && a.height ? { width: a.width as number, height: a.height as number } : undefined;
        const app = await service.appStart(context, {
          kind: a.kind as "gui" | undefined,
          command: a.command as string | undefined,
          cwd: a.cwd as string,
          entry: a.entry as string | undefined,
          args: a.args as string[] | undefined,
          env: a.env as Record<string, string> | undefined,
          title: a.title as string | undefined,
          size,
          leaseMs: a.leaseMinutes ? (a.leaseMinutes as number) * 60_000 : undefined,
        });
        const where = app.display ? ` on virtual display ${app.display}` : "";
        const window = app.window ? ` Window: “${app.window.title}” ${app.window.width}×${app.window.height}.` : " No window yet.";
        return { ok: true, summary: `Started ${app.app} (pid ${app.pid})${where}.${window}`, result: app };
      }
      case "capture_app_stop": {
        const stopped = await service.appStop(context, a.app as string);
        return { ok: true, summary: `Stopped ${stopped.app}.`, result: stopped };
      }
      case "capture_apps": {
        const apps = await service.listApps(context);
        return { ok: true, summary: apps.length ? apps.map((app) => `${app.app}: ${app.running ? "running" : "ended"}${app.window ? `, “${app.window.title}”` : ""}`).join("\n") : "No apps started.", result: { apps } };
      }
      case "capture_check": {
        const label = { ...(a.id ? { id: a.id as string } : {}), ...(a.name ? { name: a.name as string } : {}) };
        if (a.kind === "app") {
          if (!a.app) throw new CaptureError("bad_input", "Give the app's handle.");
          const checks = await service.checkApp(context, a.app as string, { title: a.title as string | undefined, aliveMs: a.aliveSec === undefined ? undefined : (a.aliveSec as number) * 1000 });
          const labelled = checks.map((check) => ({ ...check, ...(label.id ? { id: label.id } : {}) }));
          return { ok: true, summary: labelled.map((check) => `${check.verdict}: ${check.name}${check.detail ? ` (${check.detail.split("\n")[0]})` : ""}`).join("\n"), result: { checks: labelled } };
        }
        if (a.kind === "image") {
          if (!a.path) throw new CaptureError("bad_input", "Give the image's path.");
          const check = await service.checkImage(await inside(context.evidenceDir, a.path as string), label);
          return { ok: true, summary: `${check.verdict}: ${check.name} (${check.detail})`, result: { checks: [check] } };
        }
        if (!(a.expected as string[] | undefined)?.length) throw new CaptureError("bad_input", "Give the expected strings.");
        const check = await service.checkText(context, { url: a.url as string | undefined, tab: a.tab as string | undefined, app: a.app as string | undefined }, a.expected as string[], label);
        return { ok: true, summary: `${check.verdict}: ${check.name} (${check.detail})`, result: { checks: [check] } };
      }
      case "capture_status": {
        const caps = await service.capabilities(true);
        const lines = Object.entries(caps.targets).map(([key, value]) => `${key}: screenshots ${value.screenshot ? "yes" : "no"}, video ${value.video ? "yes" : "no"}${value.reason ? ` (${value.reason})` : ""}`);
        return { ok: true, summary: lines.join("\n"), result: caps };
      }
    }
    return { ok: false, error: { code: "bad_input", message: `Unknown capture tool ${name}.` } };
  } catch (error) {
    return toolError(error);
  }
}
