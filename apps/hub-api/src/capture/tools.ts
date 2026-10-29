/**
 * The capture tools for both callers (ensemble-node design B19, E§8.5): screenshots and video of a
 * web page, an Electron app, another desktop app or a terminal transcript; starting and stopping an
 * app to capture; the checks that come before sending; and what this computer can capture.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { inputSchema, toolError, type ToolCallResult, type ToolSpec } from "../browser/tools.js";
import { CaptureError, type MediaFile } from "./media.js";
import type { CaptureRequest, CaptureService, ScreenshotTarget, VideoInput } from "./service.js";

export type CaptureToolContext = CaptureRequest;

const viewport = z.object({ width: z.number().int().min(100).max(4000), height: z.number().int().min(100).max(4000) }).strict();
const waitFor = z.object({ text: z.string().max(500).optional(), selector: z.string().max(500).optional(), ms: z.number().int().min(0).max(30_000).optional() }).strict();
const step = z
  .object({
    action: z.enum(["click", "type", "press", "wait", "scroll"]),
    selector: z.string().max(500).optional(),
    text: z.string().max(5_000).optional(),
    key: z.string().max(40).optional(),
    ms: z.number().int().min(0).max(30_000).optional(),
    y: z.number().int().min(-20_000).max(20_000).optional(),
  })
  .strict();

const where = {
  url: z.string().max(4000).optional().describe("web: a page to open in a private tab (a localhost dev server is fine)."),
  tab: z.string().max(20).optional().describe("web: one of this work's browser tabs instead of a URL."),
  app: z.string().max(40).optional().describe("electron or gui: the handle from capture_app_start."),
  window: z.string().max(200).optional().describe("electron or gui: part of the window title, when the app has several."),
  viewport: viewport.optional(),
  device: z.string().max(80).optional().describe("web: a Playwright device to emulate, such as \"iPhone 13\"."),
  waitFor: waitFor.optional(),
  name: z.string().max(80).optional().describe("A short file name."),
};

export const CAPTURE_TOOLS = [
  {
    name: "capture_screenshot",
    description:
      "Save a screenshot to this work's evidence folder. Targets: web (a URL or tab; viewport, device, fullPage, element), electron and gui (an app from capture_app_start, on a private virtual display), terminal (a transcript rendered as PNG or HTML, secrets hidden). Password and code fields are masked; an image that may show a secret, or a desktop app's window, comes back held for the owner to preview.",
    input: z
      .object({
        target: z.enum(["web", "electron", "gui", "terminal", "desktop"]),
        ...where,
        fullPage: z.boolean().optional(),
        element: z.string().max(500).optional().describe("web: a CSS selector, or a ref for a tab."),
        transcript: z.string().max(2_000_000).optional().describe("terminal: the text, with its colour codes."),
        title: z.string().max(200).optional(),
        format: z.enum(["png", "html"]).optional(),
        columns: z.number().int().min(40).max(300).optional(),
      })
      .strict(),
  },
  {
    name: "capture_video",
    description:
      "Record a video into the evidence folder, with a poster frame and a small preview. mode realtime records as it happens (optionally running steps: click, type, press, wait, scroll); mode frames steps time frame by frame for smooth, exact animation video (web and Electron). MP4 where this computer has an H.264 encoder, else WebM. Two minutes at most unless the owner allows more.",
    input: z
      .object({
        target: z.enum(["web", "electron", "gui", "desktop"]),
        ...where,
        durationSec: z.number().min(0.1).max(3600),
        mode: z.enum(["realtime", "frames"]).optional(),
        fps: z.number().int().min(1).max(60).optional(),
        steps: z.array(step).max(50).optional(),
      })
      .strict(),
  },
  {
    name: "capture_app_start",
    description:
      "Start an app to capture, on a private virtual display (Linux) that never touches the owner's screen. gui: any desktop app from a shell command in cwd. electron: the Electron app in cwd (its node_modules must have electron). Returns a handle for capture_screenshot, capture_video and capture_check; the app stops when this work ends or its lease runs out.",
    input: z
      .object({
        kind: z.enum(["gui", "electron"]).optional(),
        command: z.string().max(4000).optional(),
        cwd: z.string().min(1).max(4000),
        entry: z.string().max(1000).optional().describe("electron: the main script; default the package's main."),
        args: z.array(z.string().max(1000)).max(50).optional(),
        env: z.record(z.string().max(4000)).optional(),
        title: z.string().max(200).optional().describe("Wait for a window with this in its title."),
        width: z.number().int().min(320).max(7680).optional(),
        height: z.number().int().min(240).max(4320).optional(),
        leaseMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .strict(),
  },
  { name: "capture_app_stop", description: "Stop an app started with capture_app_start, and its virtual display. Returns its last output.", input: z.object({ app: z.string().max(40) }).strict() },
  { name: "capture_apps", description: "The apps this work has started for capture, with their windows and whether they still run.", input: z.object({}).strict() },
  {
    name: "capture_check",
    description:
      "Checks to run before sending media, in the report's check shape. app: still running after aliveSec, a window open (with title), no crash in its output. image: the screenshot is not blank. text: the page (url, tab or electron app) shows every expected string.",
    input: z
      .object({
        kind: z.enum(["app", "image", "text"]),
        app: z.string().max(40).optional(),
        title: z.string().max(200).optional(),
        aliveSec: z.number().min(0).max(60).optional(),
        path: z.string().max(4000).optional().describe("image: a file in the evidence folder."),
        url: z.string().max(4000).optional(),
        tab: z.string().max(20).optional(),
        expected: z.array(z.string().min(1).max(500)).max(30).optional(),
        id: z.string().max(80).optional().describe("The acceptance criterion this check covers."),
        name: z.string().max(200).optional(),
      })
      .strict(),
  },
  { name: "capture_status", description: "What this computer can capture: the browser, video encoders, virtual displays, and for each target whether screenshots and video work here.", input: z.object({}).strict() },
] as const satisfies readonly ToolSpec[];

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
