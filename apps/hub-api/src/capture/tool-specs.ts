/**
 * The capture tools' names, descriptions and inputs (ensemble-node design B19, E§8.5), for both
 * callers. Kept apart from the capture service, so the hosted server can describe them without
 * loading a browser library.
 */
import { z } from "zod";
import type { ToolSpec } from "../browser/tool-specs.js";

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

