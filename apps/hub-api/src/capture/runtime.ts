/**
 * The browser broker and the capture service in this computer's own runtime (docs/25 §10): the
 * desktop app's sidecar and the CLI's runner start them with the hub (index.ts); the hosted server
 * never does. The owner's privacy rules come from this computer: the values of their saved secrets
 * (lib/run-secrets.ts) and the sites they never want captured or want to preview first (`captureSites`
 * in remote.json, `ensemble capture sites`). Apps started for capture run in the OS sandbox
 * (capture/sandbox.ts). When the runtime stops, every tab, app, display and recording ends.
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import { loadSettings } from "../remote/store.js";
import { configureBrowser, runningBroker, shutdownBrowser } from "../browser/index.js";
import type { PrivacyRules } from "../browser/privacy.js";
import { captureCapabilities, configureCapture, runningCapture, shutdownCapture, startCapture } from "./index.js";
import { captureAppWrapper } from "./sandbox.js";

/** Saved secret values are read again at most this often: a scan runs every few seconds while a tab is watched. */
const SECRETS_MS = 5_000;

/** The owner's rules as this computer keeps them. */
export function privacyRules(prisma: FastifyInstance["prisma"], userId = env.ENSEMBLE_DEV_USER_ID): () => Promise<PrivacyRules> {
  let secrets: { at: number; values: Promise<string[]> } | null = null;
  return async () => {
    if (!secrets || Date.now() - secrets.at > SECRETS_MS) secrets = { at: Date.now(), values: savedSecretValues(prisma, userId).catch(() => []) };
    const sites = loadSettings().captureSites;
    return { secretValues: await secrets.values, neverCapture: sites.never, previewFirst: sites.preview };
  };
}

/**
 * Configures both services for this runtime and, unless it is a short-lived admin runtime (a CLI
 * command), cleans up after a crash and starts the janitors. Returns the stop for shutdown.
 */
export function startCaptureRuntime(app: Pick<FastifyInstance, "prisma" | "log">): () => Promise<void> {
  const log = (message: string) => app.log.info(message);
  configureBrowser({ privacy: privacyRules(app.prisma), log });
  configureCapture({ wrapCommand: captureAppWrapper(), log });
  if (process.env.ENSEMBLE_RUNTIME_MODE !== "admin") {
    void startCapture()
      .then(({ reaped }) => {
        if (reaped.length) app.log.info({ reaped: reaped.length }, "capture: ended what a stopped runtime left running");
      })
      .catch((error: unknown) => app.log.warn({ err: error }, "capture: could not clean up after the last runtime"));
  }
  return async () => {
    await shutdownCapture().catch((error: unknown) => app.log.warn({ err: error }, "capture: could not stop every app"));
    await shutdownBrowser().catch((error: unknown) => app.log.warn({ err: error }, "browser: could not close every tab"));
  };
}

/** Ends one operation's tabs, recordings, apps and displays, if this runtime has any; starts nothing. */
export async function releaseOperation(operation: string): Promise<void> {
  // A sign-in still waiting for the owner ends with its work (logins/requests.ts).
  await (await import("../logins/requests.js")).endLoginsFor(operation).catch(() => undefined);
  await runningCapture()?.release(operation).catch(() => undefined);
  await runningBroker()?.release(operation).catch(() => undefined);
}

/** What this computer can capture, as it reports it to the web (`capabilities.capture`). */
export type CaptureSummary = {
  /** A Chromium for Ensemble is installed (`ensemble capture setup` installs one). */
  browser: boolean;
  video: "mp4" | "webm" | null;
  targets: Record<string, { screenshot: boolean; video: boolean; reason?: string; tui?: boolean }>;
  /** `ensemble capture setup`, or one system command, would add something. */
  setup: boolean;
};

let lastSummary: CaptureSummary | null = null;

/** This computer's capture capabilities, summarised; the last known one when the check takes long. */
export async function captureSummary(timeoutMs = 5_000): Promise<CaptureSummary | null> {
  const check = captureCapabilities()
    .then((caps): CaptureSummary => {
      lastSummary = {
        browser: caps.browser.available,
        video: caps.video?.container ?? null,
        targets: Object.fromEntries(Object.entries(caps.targets).map(([name, value]) => [name, { screenshot: value.screenshot, video: value.video, ...(value.tui !== undefined ? { tui: value.tui } : {}), ...(value.reason ? { reason: value.reason.slice(0, 200) } : {}) }])),
        setup: caps.setup.ensembleInstalls.length > 0 || Boolean(caps.setup.systemCommand),
      };
      return lastSummary;
    })
    .catch(() => lastSummary);
  return Promise.race([check, new Promise<CaptureSummary | null>((resolve) => setTimeout(() => resolve(lastSummary), timeoutMs).unref())]);
}
