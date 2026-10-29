/**
 * The local runtime's capture service (docs/25 §10). One per runtime process, sharing the browser
 * broker. `startCapture` at start-up removes what a crashed runtime left behind; the first use does
 * it too, if start-up did not.
 */
import { browserBroker } from "../browser/index.js";
import { CaptureService, type CaptureServiceOptions } from "./service.js";

let shared: CaptureService | null = null;
let starting: Promise<unknown> | null = null;
let settings: Partial<Omit<CaptureServiceOptions, "broker">> = {};

/** Options for the shared service (command wrapper, log, lease length). Takes effect when it is next created. */
export function configureCapture(options: Partial<Omit<CaptureServiceOptions, "broker">>): void {
  settings = { ...settings, ...options };
}

function service(): CaptureService {
  shared ??= new CaptureService({ broker: browserBroker(), ...settings });
  return shared;
}

/** Reaps leftovers of a crashed runtime and starts the janitor. Safe to call more than once. */
export async function startCapture(): Promise<{ reaped: string[] }> {
  const pending = service().start();
  starting ??= pending;
  return pending;
}

/** The runtime's capture service, started. */
export async function captureService(): Promise<CaptureService> {
  const current = service();
  starting ??= current.start();
  await starting;
  return current;
}

export async function shutdownCapture(): Promise<void> {
  const current = shared;
  shared = null;
  starting = null;
  await current?.shutdown();
}

export { captureCapabilities, computeCapabilities, systemInstallCommand } from "./capabilities.js";
export type { Availability, CaptureCapabilities } from "./capabilities.js";
export { blankVerdict, checkImage, checkTextIn } from "./checks.js";
export { CaptureError, DEFAULT_MAX_DURATION_MS } from "./media.js";
export type { MediaFile, StillFile } from "./media.js";
export { CaptureService } from "./service.js";
export type { AppInfo, AppStartInput, CaptureRequest, ScreenshotTarget, VideoInput, VideoStep, WebTarget } from "./service.js";
export { CAPTURE_TOOLS, captureToolDefinitions, isCaptureTool, runCaptureTool } from "./tools.js";
export type { CaptureToolContext } from "./tools.js";
