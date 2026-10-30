/**
 * The browser tools as both callers expose them (ensemble-node design B10, §6.1): the node's
 * device tools, relayed to this computer, and a coding agent's run MCP server. Each tool is a name,
 * a description for the model and a zod input; `runBrowserTool` validates a call and runs it for
 * one operation. There is no evaluate and no raw CDP tool, on purpose.
 */
import { z } from "zod";
import { CaptureError } from "../capture/media.js";
import { BrowserError, type BrowserBroker, type LiveFrame } from "./broker.js";
import { askForLogin, checkForLogin, waitingNote } from "../logins/requests.js";
import { BROWSER_TOOLS, inputSchema, type ToolSpec } from "./tool-specs.js";

export { BROWSER_TOOLS, inputSchema, type ToolSpec };

export type ToolCallResult = { ok: true; summary: string; result: unknown } | { ok: false; error: { code: string; message: string } };

/** What a call needs besides its input: who is asking, and where files go. */
export type BrowserToolContext = {
  /** The durable operation: a job attempt for a coding agent, or a node tool operation. */
  operation: string;
  evidenceDir?: string;
  uploadRoots?: string[];
  onLiveFrame?: (frame: LiveFrame) => void;
  maxVideoMs?: number;
  /** The work has the internet off: only this computer's own addresses (`OperationOptions.loopbackOnly`). */
  loopbackOnly?: boolean;
};

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]["name"];

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
      ...(context.loopbackOnly ? { loopbackOnly: true } : {}),
    });
    // A page that wants the owner to sign in pauses its tab and asks them (logins/requests.ts); the result says so.
    const withLogin = async (done: { ok: true; summary: string; result: unknown }, tabId: string, input: { requested?: string; status?: number | null } = {}): Promise<ToolCallResult> => {
      const found = await checkForLogin(broker, context.operation, tabId, input);
      if (!found) return done;
      if (found.login) return { ok: true, summary: `${done.summary}\n${waitingNote(found.login)}`, result: { ...(done.result as Record<string, unknown>), login: found.login } };
      return { ok: true, summary: `${done.summary}\n${found.note}`, result: done.result };
    };
    switch (spec.name) {
      case "browser_open": {
        const opened = await op.open(a.url as string, { tab: a.tab as string | undefined, profile: a.profile as string | undefined, private: a.private as boolean | undefined, headed: a.headed as boolean | undefined, device: a.device as string | undefined, viewport: a.viewport as { width: number; height: number } | undefined });
        const summary = opened.error ? `Tab ${opened.tab} could not load the page: ${opened.error}` : `Opened ${opened.tab}: ${opened.title || opened.url}${opened.status ? ` (${opened.status})` : ""}.`;
        const done = { ok: true as const, summary: opened.note ? `${summary} ${opened.note}` : summary, result: opened };
        return opened.error ? done : withLogin(done, opened.tab, { requested: a.url as string, status: opened.status });
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
        return withLogin({ ok: true, summary: `Clicked ${a.ref as string}; the tab shows ${info.title || info.url}.`, result: info }, info.tab);
      }
      case "browser_type": {
        const info = await op.type(a.tab as string, a.ref as string, a.text as string, { submit: a.submit as boolean | undefined, slowly: a.slowly as boolean | undefined });
        const typed = { ok: true as const, summary: `Typed into ${a.ref as string}.`, result: info };
        return a.submit ? withLogin(typed, info.tab) : typed;
      }
      case "browser_press": {
        const info = await op.press(a.tab as string, a.key as string);
        return withLogin({ ok: true, summary: `Pressed ${a.key as string}.`, result: info }, info.tab);
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
      case "browser_login_needed": {
        const login = await askForLogin(broker, context.operation, a.tab as string, { origin: a.origin as string | undefined, signedIn: a.signedIn as { urlPattern?: string; selector?: string } | undefined, reason: a.reason as string | undefined });
        return { ok: true, summary: waitingNote(login), result: { login } };
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
