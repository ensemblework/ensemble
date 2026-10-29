/**
 * The local runtime's browser broker (docs/25 §10). One broker per runtime process, created on
 * first use; `configureBrowser` sets the owner's privacy rules and logging before that.
 */
import { BrowserBroker, type BrokerOptions } from "./broker.js";

let shared: BrowserBroker | null = null;
let settings: BrokerOptions = {};

/** Options for the shared broker (privacy rules, log). Takes effect when it is next created. */
export function configureBrowser(options: BrokerOptions): void {
  settings = { ...settings, ...options };
}

/** The runtime's broker. */
export function browserBroker(): BrowserBroker {
  shared ??= new BrowserBroker(settings);
  return shared;
}

/** Closes every tab and browser; the next call to `browserBroker` starts afresh. */
export async function shutdownBrowser(): Promise<void> {
  const broker = shared;
  shared = null;
  await broker?.shutdown();
}

export { BrowserBroker, BrowserError, BrowserOperation, checkUrl, hasDisplay } from "./broker.js";
export type { BrokerOptions, ConsoleEntry, LiveFrame, NetworkEntry, OpenOptions, OperationOptions, TabInfo } from "./broker.js";
export { findChromium, playwrightRevisions } from "./chromium.js";
export { browserDeniedPaths, browserProfileDir, browserRoot, captureStateDir, ensembleDataHome, playwrightBrowsersDir } from "./paths.js";
export { matchesSite, SENSITIVE_SELECTOR, siteRule } from "./privacy.js";
export type { PrivacyRules } from "./privacy.js";
export { BROWSER_TOOLS, browserToolDefinitions, isBrowserTool, runBrowserTool } from "./tools.js";
export type { BrowserToolContext, ToolCallResult } from "./tools.js";
