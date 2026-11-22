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
const display = z.union([z.string().max(40), z.number().int().min(0).max(1_000_000)]).optional().describe("A monitor, by its name (DP-2) or number from desktop_status. Default: the main one.");

export const SCREENS = ["agent", "owner"] as const;
/** What the owner is asked about before a node uses their own pointer and keyboard. */
export const OWNER_SCREEN_TARGET = "screen:owner";
const screen = z
  .enum(SCREENS)
  .optional()
  .describe("agent: your own private screen, which nobody sees unless they watch it. owner: your owner's real screen, only for an app or session already open there or when they ask to watch. Your own screen is the default for any work that does not need your owner's open windows, \"on my computer\" too. Without it, an app you open goes on agent; other calls stay where you last worked, else agent. A Mac or Windows PC has no agent screen: there it is always owner.");

const share = z.boolean().optional().describe("true: also send this picture to your owner in this chat, held for them to preview first. Use it whenever they want to see the screen.");

export const STEP_ACTIONS = ["click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "press", "set_text", "select", "toggle", "focus", "wait", "open"] as const;
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
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("scroll: which way. With an element instead, scroll brings it into view."),
    amount: z.number().int().min(1).max(30).optional().describe("scroll: how many notches (default 3)."),
    text: z.string().max(5_000).optional().describe("type or set_text: the text. A saved secret goes by its name, $NAME, and only into a password field."),
    keys: z.string().max(80).optional().describe("key: one key or a combination, such as Return, Escape, ctrl+s, alt+Tab, ctrl+shift+t (on a Mac cmd+s; on a Mac or Windows PC, with an element, the keys go to that element in the background)."),
    repeat: z.number().int().min(1).max(30).optional(),
    name: z.string().max(60).optional().describe("press, select or toggle: which of the element's actions, when it has several."),
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
        need(Boolean(step.direction) || Boolean(step.element), "scroll needs a direction, or an element to bring into view.");
        break;
      case "type":
        need(typeof step.text === "string" && step.text.length > 0, "type needs text.");
        break;
      case "key":
        need(Boolean(step.keys), "key needs keys.");
        break;
      case "press":
      case "select":
      case "toggle":
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
    readOnly: true,
    description:
      "What desktop control can do on your owner's computer now, for both screens: your private agent screen (a desktop of your own that nobody sees unless they watch it) and your owner's real screen (consent, the lock, who has control). Also accessibility and recording. Call it before first use and whenever a desktop tool fails. Answers in a few seconds.",
    input: z.object({}).strict(),
  },
  {
    name: "desktop_apps",
    readOnly: true,
    description: "The apps installed on your owner's computer (name and id) and the ones running, with their windows, on each screen. Use it to find an app's id for desktop_open. Answers in a few seconds.",
    input: z
      .object({
        query: z.string().max(100).optional().describe("Part of an app's name or id."),
        running: z.boolean().optional().describe("Only the running apps."),
        screen: z.enum(SCREENS).optional().describe("Only this screen's running apps. Default: your owner's, and the agent screen's when it runs."),
      })
      .strict(),
  },
  {
    name: "desktop_open",
    description:
      "Open an installed app by its id from desktop_apps and wait until its window can be read. By default it opens on your private agent screen, where you work without disturbing your owner; on their screen (screen owner) it takes the front, so your owner is asked once for this work. On a Mac or Windows PC it opens behind your owner's windows without asking: work in it through its element ids. Blocks up to about 25 seconds, more when the agent screen starts. A password manager, terminal, system settings or banking app asks your owner first, once per app in this work.",
    input: z
      .object({
        app: z.string().min(1).max(200).describe("The app's id or name."),
        screen,
        waitSec: z.number().int().min(1).max(20).optional().describe("How long to wait for its window (default 8)."),
      })
      .strict(),
  },
  {
    name: "desktop_observe",
    readOnly: true,
    description:
      "Look at a screen: a screenshot with its captureId, the app in front and its accessibility elements (ids e1, e2…). Aim desktop_act at those ids (exact, and the only way to act in the background on your owner's screen), or at x,y in this screenshot with its captureId. Look again after the screen changes: coordinates on an older screenshot are refused. Your owner sees none of it unless share is true, which sends this screenshot to them in this chat: the only way to show them a screen, so never say one is attached otherwise. Takes up to about 10 seconds; the first screenshot of your owner's screen may wait for them to allow screen control, and the first look at the agent screen starts it (about 5 seconds).",
    input: z
      .object({
        screen,
        display,
        app: z.string().max(200).optional().describe("Read this running app's elements instead of the one in front."),
        elements: z.boolean().optional().describe("Read the accessibility elements (default true)."),
        screenshot: z.boolean().optional().describe("false: read one app's elements without a picture. Needs no screen control, and works while your owner uses the computer."),
        maxElements: z.number().int().min(10).max(200).optional(),
        share,
      })
      .strict(),
  },
  {
    name: "desktop_act",
    description:
      "Do up to 20 steps, in order: click, double_click, right_click, move, drag, scroll, type, key, press, set_text, select, toggle, focus, wait, open. A step aims at an element id from your latest desktop_observe, or at x,y on the screenshot named by captureId; the steps run on that look's screen. On your owner's screen they run in the background unless foreground is true: only steps on an element id (press, click, type, set_text, select, toggle, scroll), through accessibility, never their pointer, keyboard or focus; any other step is refused as needing the screen, so use the agent screen, or foreground true, which asks your owner once for this work. It stops at the first step that fails or is refused and returns each step's verdict (confirmed, partial, no_effect, refused, not_run, unknown), whether it ran, the screen and mode, and a fresh look. Takes up to about 75 seconds. On refused, read why: Ensemble's own windows, secrets typed as text and password prompts are never done; hand those to your owner with desktop_handoff.",
    input: z
      .object({
        captureId: captureId.optional(),
        screen,
        foreground: z.boolean().optional().describe("Your owner's screen only: use their pointer and keyboard (asks them once for this work)."),
        steps: z.array(DesktopStep).min(1).max(20),
        observe: z.boolean().optional().describe("Look again after the steps (default true)."),
      })
      .strict(),
  },
  {
    name: "desktop_zoom",
    readOnly: true,
    description: "A closer, sharper look at part of a screenshot: its captureId and a box [x0, y0, x1, y1] in its pixels. Returns a new image with its own captureId, which clicks can aim at too; share true sends it to your owner as well. Answers in a few seconds.",
    input: z
      .object({
        captureId,
        box: z.tuple([coordinate, coordinate, coordinate, coordinate]).describe("[x0, y0, x1, y1] in the screenshot's pixels."),
        share,
      })
      .strict(),
  },
  {
    name: "desktop_record",
    description:
      "Record a screen as a video for your owner: start, then save (or discard). One recording at a time per screen; it stops by itself at maxSec (default 120, at most 600). A saved video is held for your owner to preview before it is shown or sent. start answers in seconds; save can take up to a minute.",
    input: z
      .object({
        action: z.enum(["start", "save", "discard"]),
        screen,
        display,
        maxSec: z.number().int().min(1).max(600).optional(),
        name: z.string().max(80).optional().describe("save: a short file name."),
      })
      .strict(),
  },
  {
    name: "desktop_handoff",
    description:
      "Hand your owner's screen to them where only they may act: the system dialog that allows screen control, a password prompt, a sign-in, anything you must not type. They get a notice on the computer, your input pauses, and the call waits up to waitSec (default 60, at most 240) for them. Control comes back after two minutes without their input, or with action release once they are done (refused while they are still using the computer).",
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
/** About what typing takes a character, with its checks every 8 (a Mac or Windows PC is the slower; Linux is quicker). */
const TYPING_MS_PER_CHAR = 45;

/** The time one type step may take: the longest text allowed (5,000 characters) finishes in it. */
export function typingMs(chars: number): number {
  return 5_000 + Math.max(0, chars) * TYPING_MS_PER_CHAR;
}

export function desktopTimeoutMs(name: string, input: Record<string, unknown>): number {
  switch (name) {
    case "desktop_open":
      return 75_000;
    case "desktop_observe":
      return 45_000;
    case "desktop_act": {
      const steps = Array.isArray(input.steps) ? (input.steps as unknown[]) : [];
      const typed = steps.reduce<number>((sum, step) => {
        const { action, text } = (step ?? {}) as { action?: unknown; text?: unknown };
        return sum + (action === "type" && typeof text === "string" ? text.length : 0);
      }, 0);
      return Math.min(270_000, 90_000 + typed * TYPING_MS_PER_CHAR);
    }
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
