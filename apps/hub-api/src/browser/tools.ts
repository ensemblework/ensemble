/**
 * The browser tools as both callers expose them (ensemble-node design B10, §6.1): the node's
 * device tools, relayed to this computer, and a coding agent's run MCP server. Each tool is a name,
 * a description for the model and a zod input; `runBrowserTool` validates a call and runs it for
 * one operation. There is no evaluate and no raw CDP tool, on purpose.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CaptureError } from "../capture/media.js";
import { BrowserError, type BrowserBroker, type LiveFrame } from "./broker.js";

export type ToolSpec = { name: string; description: string; input: z.ZodTypeAny };
export type ToolCallResult = { ok: true; summary: string; result: unknown } | { ok: false; error: { code: string; message: string } };

/** What a call needs besides its input: who is asking, and where files go. */
export type BrowserToolContext = {
  /** The durable operation: a job attempt for a coding agent, or a node tool operation. */
  operation: string;
  evidenceDir?: string;
  uploadRoots?: string[];
  onLiveFrame?: (frame: LiveFrame) => void;
  maxVideoMs?: number;
};

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
  { name: "browser_close", description: "Close a tab.", input: z.object({ tab }).strict() },
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
      "Save a screenshot of the tab to this work's evidence folder: the viewport, the full page, or one element (a ref or CSS selector), optionally at another viewport size. Password and code fields are masked. A screenshot showing a saved secret or a key-like string comes back held: the owner previews it before it is sent.",
    input: z
      .object({
        tab,
        fullPage: z.boolean().optional(),
        element: z.string().max(500).optional(),
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
    name: "browser_download",
    description: "Save a download into the evidence folder: the one clicking `ref` starts, or else the latest one the tab started (waiting for one if needed).",
    input: z.object({ tab, ref: ref.optional(), timeoutMs: z.number().int().min(1000).max(300_000).optional() }).strict(),
  },
] as const satisfies readonly ToolSpec[];

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]["name"];

/** JSON Schema for a tool's input, as MCP and model APIs take it. */
export function inputSchema(spec: ToolSpec): Record<string, unknown> {
  const schema = zodToJsonSchema(spec.input, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** The browser tools as MCP-style definitions: name, description and JSON Schema input. */
export function browserToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return BROWSER_TOOLS.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: inputSchema(spec) }));
}

export function isBrowserTool(name: string): name is BrowserToolName {
  return BROWSER_TOOLS.some((spec) => spec.name === name);
}

/** A failure as the tool result an agent reads. */
export function toolError(error: unknown): ToolCallResult {
  if (error instanceof BrowserError || error instanceof CaptureError) return { ok: false, error: { code: error.code, message: error.message } };
  if (error instanceof z.ZodError) return { ok: false, error: { code: "bad_input", message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") } };
  return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message.split("\n")[0]! : String(error) } };
}

/** Validates and runs one browser tool call for an operation. Never throws. */
export async function runBrowserTool(broker: BrowserBroker, name: string, input: unknown, context: BrowserToolContext): Promise<ToolCallResult> {
  const spec = BROWSER_TOOLS.find((item) => item.name === name);
  if (!spec) return { ok: false, error: { code: "bad_input", message: `Unknown browser tool ${name}.` } };
  try {
    const a = spec.input.parse(input ?? {}) as Record<string, unknown>;
    const op = broker.operation(context.operation, {
      ...(context.evidenceDir ? { evidenceDir: context.evidenceDir } : {}),
      ...(context.uploadRoots ? { uploadRoots: context.uploadRoots } : {}),
      ...(context.onLiveFrame ? { onLiveFrame: context.onLiveFrame } : {}),
      ...(context.maxVideoMs ? { maxVideoMs: context.maxVideoMs } : {}),
    });
    switch (spec.name) {
      case "browser_open": {
        const opened = await op.open(a.url as string, { tab: a.tab as string | undefined, profile: a.profile as string | undefined, private: a.private as boolean | undefined, headed: a.headed as boolean | undefined, device: a.device as string | undefined, viewport: a.viewport as { width: number; height: number } | undefined });
        const summary = opened.error ? `Tab ${opened.tab} could not load the page: ${opened.error}` : `Opened ${opened.tab}: ${opened.title || opened.url}${opened.status ? ` (${opened.status})` : ""}.`;
        return { ok: true, summary: opened.note ? `${summary} ${opened.note}` : summary, result: opened };
      }
      case "browser_tabs": {
        const tabs = await op.tabs();
        return { ok: true, summary: tabs.length ? tabs.map((item) => `${item.tab}: ${item.title || item.url}${item.sensitive ? " (paused for sign-in)" : ""}`).join("\n") : "No tabs open.", result: { tabs } };
      }
      case "browser_close": {
        const closed = await op.close(a.tab as string);
        return { ok: true, summary: `Closed ${closed.closed}.`, result: closed };
      }
      case "browser_snapshot": {
        const snapshot = await op.snapshot(a.tab as string, { maxChars: a.maxChars as number | undefined });
        return { ok: true, summary: `${snapshot.title || snapshot.url}\n${snapshot.snapshot}`, result: snapshot };
      }
      case "browser_click": {
        const info = await op.click(a.tab as string, a.ref as string, { button: a.button as "left" | undefined, double: a.double as boolean | undefined });
        return { ok: true, summary: `Clicked ${a.ref as string}; the tab shows ${info.title || info.url}.`, result: info };
      }
      case "browser_type": {
        const info = await op.type(a.tab as string, a.ref as string, a.text as string, { submit: a.submit as boolean | undefined, slowly: a.slowly as boolean | undefined });
        return { ok: true, summary: `Typed into ${a.ref as string}.`, result: info };
      }
      case "browser_press": {
        const info = await op.press(a.tab as string, a.key as string);
        return { ok: true, summary: `Pressed ${a.key as string}.`, result: info };
      }
      case "browser_wait": {
        const waited = await op.wait(a.tab as string, { selector: a.selector as string | undefined, text: a.text as string | undefined, url: a.url as string | undefined, state: a.state as "visible" | undefined, timeoutMs: a.timeoutMs as number | undefined });
        return { ok: true, summary: `Done after ${waited.waitedMs} ms.`, result: waited };
      }
      case "browser_screenshot": {
        const file = await op.screenshot(a.tab as string, { fullPage: a.fullPage as boolean | undefined, element: a.element as string | undefined, viewport: a.viewport as { width: number; height: number } | undefined, name: a.name as string | undefined, format: a.format as "png" | undefined });
        return { ok: true, summary: `Saved ${file.path} (${file.width}×${file.height}).${file.held ? ` Held for the owner to preview: ${file.reason}` : ""}`, result: file };
      }
      case "browser_console": {
        const log = await op.console(a.tab as string, { level: a.level as "all" | undefined, clear: a.clear as boolean | undefined });
        return { ok: true, summary: log.messages.length ? log.messages.map((entry) => `[${entry.type}] ${entry.text}`).join("\n") : "No console messages.", result: log };
      }
      case "browser_network_errors": {
        const log = op.networkErrors(a.tab as string, { clear: a.clear as boolean | undefined });
        return { ok: true, summary: log.errors.length ? log.errors.map((entry) => `${entry.method} ${entry.url} → ${entry.status ?? entry.failure}`).join("\n") : "No failed requests.", result: log };
      }
      case "browser_record": {
        const recorded = await op.record(a.tab as string, { kind: a.kind as "video", action: a.action as "start", fps: a.fps as number | undefined, name: a.name as string | undefined });
        const file = recorded.file;
        return { ok: true, summary: file ? `Saved ${file.path}${file.durationMs ? ` (${(file.durationMs / 1000).toFixed(1)} s)` : ""}.${file.held ? ` Held for the owner to preview: ${file.reason}` : ""}` : `Recording ${a.kind as string} of ${recorded.tab}.`, result: recorded };
      }
      case "browser_upload": {
        const sent = await op.upload(a.tab as string, a.ref as string, a.file as string);
        return { ok: true, summary: `Sent ${sent.file} (${sent.size} bytes).`, result: sent };
      }
      case "browser_download": {
        const saved = await op.download(a.tab as string, { ref: a.ref as string | undefined, timeoutMs: a.timeoutMs as number | undefined });
        return { ok: true, summary: `Saved ${saved.name} to ${saved.path} (${saved.size} bytes).`, result: saved };
      }
    }
    return { ok: false, error: { code: "bad_input", message: `Unknown browser tool ${name}.` } };
  } catch (error) {
    return toolError(error);
  }
}
