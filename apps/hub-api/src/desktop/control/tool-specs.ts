/**
 * The desktop control tools' names, descriptions and inputs (docs/25 §11), for the hosted server (a
 * node's device tools), this computer (which validates them again) and a coding run's MCP server.
 * Kept apart from the service so the server can describe them without loading it.
 */
import { z } from "zod";
import type { ToolSpec } from "../../browser/tool-specs.js";

const captureId = z.string().regex(/^cap_[0-9a-f]{12}$/, "a captureId such as cap_0123456789ab").describe("The screenshot the coordinates are in, from desktop_observe or desktop_zoom.");
const element = z.string().regex(/^e\d{1,4}$/, "an element id such as e12").describe("An element id from your latest desktop_observe.");
const coordinate = z.number().min(-100).max(20_000);
const display = z.union([z.string().max(40), z.number().int().min(0).max(1_000_000)]).optional().describe("A screen, by its name (DP-2) or number from desktop_status. Default: the main screen.");

export const STEP_ACTIONS = ["click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "press", "set_text", "focus", "wait", "open"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const DesktopStep = z
  .object({
    action: z.enum(STEP_ACTIONS),
    element: element.optional(),
    x: coordinate.optional().describe("Pixels from the left of the screenshot named by captureId."),
    y: coordinate.optional().describe("Pixels from the top of that screenshot."),
    captureId: captureId.optional(),
    from: z.tuple([coordinate, coordinate]).optional().describe("drag: [x, y] where it starts."),
    to: z.tuple([coordinate, coordinate]).optional().describe("drag: [x, y] where it ends."),
    button: z.enum(["left", "right", "middle"]).optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().int().min(1).max(30).optional().describe("scroll: how many notches (default 3)."),
    text: z.string().max(5_000).optional().describe("type or set_text: the text. A saved secret goes by its name, $NAME, and only into a password field."),
    keys: z.string().max(80).optional().describe("key: one key or a combination, such as Return, Escape, ctrl+s, alt+Tab, ctrl+shift+t."),
    repeat: z.number().int().min(1).max(30).optional(),
    name: z.string().max(60).optional().describe("press: which of the element's actions, when it has several."),
    ms: z.number().int().min(0).max(10_000).optional().describe("wait: milliseconds."),
    app: z.string().max(200).optional().describe("open: the app's id from desktop_apps."),
  })
  .strict()
  .superRefine((step, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    const point = step.x !== undefined && step.y !== undefined;
    switch (step.action) {
      case "click":
      case "double_click":
      case "right_click":
        need(point || Boolean(step.element), `${step.action} needs x and y (with a captureId) or an element.`);
        break;
      case "move":
        need(point, "move needs x and y.");
        break;
      case "drag":
        need(Boolean(step.from && step.to), "drag needs from and to.");
        break;
      case "scroll":
        need(Boolean(step.direction), "scroll needs a direction.");
        break;
      case "type":
        need(typeof step.text === "string" && step.text.length > 0, "type needs text.");
        break;
      case "key":
        need(Boolean(step.keys), "key needs keys.");
        break;
      case "press":
      case "focus":
        need(Boolean(step.element), `${step.action} needs an element.`);
        break;
      case "set_text":
        need(Boolean(step.element) && typeof step.text === "string", "set_text needs an element and text.");
        break;
      case "wait":
        need(step.ms !== undefined, "wait needs ms.");
        break;
      case "open":
        need(Boolean(step.app), "open needs an app.");
        break;
    }
  });
export type DesktopStep = z.infer<typeof DesktopStep>;

export const DESKTOP_TOOLS = [
  {
    name: "desktop_status",
    description:
      "What desktop control can do on your owner's computer now: screen control and consent, accessibility, recording, the screen lock, who has control. Call it before first use and whenever a desktop tool fails. Answers in a few seconds.",
    input: z.object({}).strict(),
  },
  {
    name: "desktop_apps",
    description: "The apps installed on your owner's computer (name and id) and the ones running with their windows. Use it to find an app's id for desktop_open. Answers in a few seconds.",
    input: z
      .object({
        query: z.string().max(100).optional().describe("Part of an app's name or id."),
        running: z.boolean().optional().describe("Only the running apps."),
      })
      .strict(),
  },
  {
    name: "desktop_open",
    description:
      "Open an installed app by its id from desktop_apps (or bring it to the front when it runs) and wait until its window can be read. Blocks up to about 25 seconds. A password manager, terminal, system settings or banking app asks your owner first, once per app in this work.",
    input: z
      .object({
        app: z.string().min(1).max(200).describe("The app's id or name."),
        waitSec: z.number().int().min(1).max(20).optional().describe("How long to wait for its window (default 8)."),
      })
      .strict(),
  },
  {
    name: "desktop_observe",
    description:
      "Look at the screen of your owner's computer: a screenshot with its captureId, the app in front and its accessibility elements (ids e1, e2…). Aim desktop_act at those ids (exact), or at x,y in this screenshot with its captureId. Look again after the screen changes: coordinates on an older screenshot are refused. Takes up to about 10 seconds; the first use may wait for your owner to allow screen control at the computer.",
    input: z
      .object({
        display,
        app: z.string().max(200).optional().describe("Read this running app's elements instead of the one in front."),
        elements: z.boolean().optional().describe("Read the accessibility elements (default true)."),
        maxElements: z.number().int().min(10).max(200).optional(),
      })
      .strict(),
  },
  {
    name: "desktop_act",
    description:
      "Do up to 20 steps on the screen, in order: click, double_click, right_click, move, drag, scroll, type, key, press, set_text, focus, wait, open. A step aims at an element id from your latest desktop_observe, or at x,y on the screenshot named by captureId (for the whole batch, or per step). It stops at the first step that fails or is refused and returns each step's verdict (confirmed, partial, no_effect, refused, not_run, unknown), whether it ran, and a fresh observation. Takes up to about 75 seconds. On refused, read why: Ensemble's own windows, secrets typed as text and password prompts are never done; hand those to your owner with desktop_handoff.",
    input: z
      .object({
        captureId: captureId.optional(),
        steps: z.array(DesktopStep).min(1).max(20),
        observe: z.boolean().optional().describe("Look again after the steps (default true)."),
      })
      .strict(),
  },
  {
    name: "desktop_zoom",
    description: "A closer, sharper look at part of a screenshot: its captureId and a box [x0, y0, x1, y1] in its pixels. Returns a new image with its own captureId, which clicks can aim at too. Answers in a few seconds.",
    input: z
      .object({
        captureId,
        box: z.tuple([coordinate, coordinate, coordinate, coordinate]).describe("[x0, y0, x1, y1] in the screenshot's pixels."),
      })
      .strict(),
  },
  {
    name: "desktop_record",
    description:
      "Record the screen as a video for your owner: start, then save (or discard). One recording at a time; it stops by itself at maxSec (default 120, at most 600). A saved video is held for your owner to preview before it is shown or sent. start answers in seconds; save can take up to a minute.",
    input: z
      .object({
        action: z.enum(["start", "save", "discard"]),
        display,
        maxSec: z.number().int().min(1).max(600).optional(),
        name: z.string().max(80).optional().describe("save: a short file name."),
      })
      .strict(),
  },
  {
    name: "desktop_handoff",
    description:
      "Hand control to your owner where only they may act: the system dialog that allows screen control, a password prompt, a sign-in, anything you must not type. They get a notice on the computer, your input pauses, and the call waits up to waitSec (default 60, at most 240) for them. Control comes back after two minutes without their input, or with action release once they are done (refused while they are still using the computer).",
    input: z
      .object({
        action: z.enum(["ask", "release", "status"]).optional().describe("Default ask."),
        reason: z.enum(["consent", "password", "sign_in", "other"]).optional(),
        message: z.string().max(300).optional().describe("ask: one line for your owner, what to do."),
        waitSec: z.number().int().min(0).max(240).optional(),
      })
      .strict(),
  },
] as const satisfies readonly ToolSpec[];

export type DesktopToolName = (typeof DESKTOP_TOOLS)[number]["name"];

export function isDesktopTool(name: string): name is DesktopToolName {
  return DESKTOP_TOOLS.some((spec) => spec.name === name);
}

/** How long the server waits for a desktop call's answer: what the call may take, plus the way there and back. */
export function desktopTimeoutMs(name: string, input: Record<string, unknown>): number {
  switch (name) {
    case "desktop_open":
      return 60_000;
    case "desktop_observe":
      return 45_000;
    case "desktop_act":
      return 90_000;
    case "desktop_record":
      return input.action === "save" ? 120_000 : 40_000;
    case "desktop_handoff": {
      const wait = typeof input.waitSec === "number" ? input.waitSec : 60;
      return input.action === "release" || input.action === "status" ? 30_000 : Math.min(240, Math.max(0, wait)) * 1000 + 30_000;
    }
    default:
      return 30_000;
  }
}

/** What the computer may spend of that: the rest is the way there and back. */
export const DESKTOP_TRANSPORT_MS = 12_000;
