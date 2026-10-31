/**
 * The browser tools' names, descriptions and inputs (ensemble-node design B10): what both callers
 * offer, the node's device tools and a coding agent's run MCP server. Kept apart from the broker, so
 * the hosted server can describe the tools without loading a browser library.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ToolSpec = { name: string; description: string; input: z.ZodTypeAny };

const tab = z.string().regex(/^t\d{1,9}$/, "a tab id such as t1").describe("The tab, from browser_open or browser_tabs.");
const ref = z.string().min(1).max(40).describe("An element's [ref=…] from the latest browser_snapshot.");
const viewport = z.object({ width: z.number().int().min(100).max(4000), height: z.number().int().min(100).max(4000) }).strict();

export const BROWSER_TOOLS = [
  {
    name: "browser_open",
    description:
      "Open a web page (http or https) in a new tab of this computer's Ensemble browser, or in an existing tab with `tab`. The default profile keeps sign-ins between tasks; `private: true` opens a clean, separate context that can also emulate a device (Playwright device names such as \"iPhone 13\"). Returns the tab id.",
    input: z
      .object({
        url: z.string().min(1).max(4000),
        tab: tab.optional(),
        profile: z.string().max(48).optional().describe("A named browser profile; default \"default\"."),
        private: z.boolean().optional(),
        headed: z.boolean().optional().describe("Show the window on this computer's screen, when it has one."),
        device: z.string().max(80).optional(),
        viewport: viewport.optional(),
      })
      .strict(),
  },
  { name: "browser_tabs", description: "List this work's open tabs: id, URL, title, and whether one is recording or paused for a sign-in.", input: z.object({}).strict() },
  { name: "browser_close", description: "Close one of this work's tabs. A recording running in it is finished and saved first.", input: z.object({ tab }).strict() },
  {
    name: "browser_snapshot",
    description: "Read the page as an accessibility tree, with a [ref=…] for each element to use in browser_click and browser_type. Password and code fields never show their values. Long pages are cut at maxChars.",
    input: z.object({ tab, maxChars: z.number().int().min(1000).max(100_000).optional() }).strict(),
  },
  {
    name: "browser_click",
    description: "Click an element by its ref from the latest snapshot. Take a new snapshot after the page changes.",
    input: z.object({ tab, ref, button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional() }).strict(),
  },
  {
    name: "browser_type",
    description: "Type text into a field by its ref, replacing what is there. Never for passwords or secrets: Ensemble fills those itself. `submit` presses Enter after.",
    input: z.object({ tab, ref, text: z.string().max(20_000), submit: z.boolean().optional(), slowly: z.boolean().optional().describe("Type key by key, for fields that react to each key.") }).strict(),
  },
  { name: "browser_press", description: "Press a key or chord in the tab: Enter, Escape, Tab, ArrowDown, Control+A.", input: z.object({ tab, key: z.string().min(1).max(40) }).strict() },
  {
    name: "browser_wait",
    description: "Wait until a CSS selector (or ref) appears, a text is shown, or the URL matches a glob such as **/dashboard; with none of them, just wait timeoutMs.",
    input: z
      .object({
        tab,
        selector: z.string().max(500).optional(),
        text: z.string().max(500).optional(),
        url: z.string().max(2000).optional(),
        state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
      })
      .strict(),
  },
  {
    name: "browser_screenshot",
    description:
      "Save a screenshot of the tab to this work's evidence folder: the viewport by default; one element (a table, a chart) by its ref or a CSS selector; the full page only when asked for it. Optionally at another viewport size. Password and code fields are masked. A screenshot showing a saved secret or a key-like string comes back held: the owner previews it before it is sent.",
    input: z
      .object({
        tab,
        fullPage: z.boolean().optional().describe("The whole page, top to bottom: only when your owner asked for the full page."),
        element: z.string().max(500).optional().describe("Just this element (a table, a chart): its ref from browser_snapshot, or a CSS selector."),
        viewport: viewport.optional(),
        name: z.string().max(80).optional().describe("A short file name."),
        format: z.enum(["png", "jpeg"]).optional(),
      })
      .strict(),
  },
  {
    name: "browser_console",
    description: "The tab's console messages and uncaught page errors since it opened (the latest 300), with secrets hidden.",
    input: z.object({ tab, level: z.enum(["error", "warning", "all"]).optional(), clear: z.boolean().optional() }).strict(),
  },
  { name: "browser_network_errors", description: "Requests that failed or answered 400 or above, since the tab opened.", input: z.object({ tab, clear: z.boolean().optional() }).strict() },
  {
    name: "browser_record",
    description:
      "Start or stop recording the tab. `video` is a real-time video (MP4 or WebM, with a poster and preview); `trace` is a Playwright trace (in the shared profile it has screenshots only, no page source or network data). Stopping returns the file in the evidence folder.",
    input: z.object({ tab, kind: z.enum(["video", "trace"]), action: z.enum(["start", "stop"]), fps: z.number().int().min(5).max(30).optional(), name: z.string().max(80).optional() }).strict(),
  },
  {
    name: "browser_upload",
    description: "Put a file into a file field (or the file chooser a ref opens). Only files in this work's evidence folder or files the owner attached.",
    input: z.object({ tab, ref, file: z.string().min(1).max(4000).describe("The file's full path.") }).strict(),
  },
  {
    name: "browser_login_needed",
    description:
      "Hand one of this work's tabs to the owner when a page needs a person: their account (a sign-in form, a session that ended; purpose \"sign_in\"), or a human check (a captcha, \"Robot or human?\", \"Just a moment…\", a page that blocks automated browsing; purpose \"human_check\"). Never try to solve a human check yourself. The owner gets a card in the chat and does it from their phone or computer (Google sign-in, two-step codes and approvals work there), or uses the login saved on the computer, or types it on the web for this computer only; you never see or type a password or code. The tab pauses (no reading, screenshots or actions) until it is done, which Ensemble sees by itself; then you carry on. `signedIn` says how to tell a sign-in worked: a URL glob the tab reaches, or a CSS selector the page then shows (default: no sign-in form left on the site). Ensemble asks by itself when a page of another site clearly wants a sign-in in the shared profile; a private tab or this computer's own addresses only get a hint.",
    input: z
      .object({
        tab,
        origin: z.string().min(1).max(300).optional().describe("The site to sign in to, such as https://app.example.com; default: the tab's."),
        purpose: z.enum(["sign_in", "human_check"]).optional().describe("sign_in (default): the owner's account; human_check: a captcha or robot check a person must pass. A page Ensemble sees is a human check is handed over as one."),
        signedIn: z
          .object({ urlPattern: z.string().min(1).max(500).optional(), selector: z.string().min(1).max(500).optional() })
          .strict()
          .refine((value) => Boolean(value.urlPattern) !== Boolean(value.selector), "give a urlPattern or a selector")
          .optional(),
        reason: z.string().min(1).max(200).optional().describe("Why, in a few words for the owner's card."),
      })
      .strict(),
  },
  {
    name: "browser_login_check",
    description:
      "Check now whether the owner finished signing in (or passed the human check) on a tab that waits for them, such as when they say they did. Done: the tab is yours again (take a new snapshot). Not yet: it keeps waiting and says what the page still shows. Never ask for a password or code in the chat.",
    input: z.object({ tab }).strict(),
  },
  {
    name: "browser_download",
    description: "Save a download into the evidence folder: the one clicking `ref` starts, or else the latest one the tab started (waiting for one if needed).",
    input: z.object({ tab, ref: ref.optional(), timeoutMs: z.number().int().min(1000).max(300_000).optional() }).strict(),
  },
] as const satisfies readonly ToolSpec[];

/** JSON Schema for a tool's input, as MCP and model APIs take it. */
export function inputSchema(spec: ToolSpec): Record<string, unknown> {
  const schema = zodToJsonSchema(spec.input, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

