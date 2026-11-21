/**
 * What desktop control tells the agent, the same for a node and a coding run: what is on the screen,
 * what each step did, why something was refused and what to do next.
 */
import type { ActResult, DesktopError, DesktopStatus, Observation, OpenResult, SavedRecording } from "./service.js";

/** The line an image travels by to an agent on its own subscription (images.ts adds the picture). */
export const imageMarker = (captureId: string) => `[desktop screenshot ${captureId}]`;
export const IMAGE_MARKER = /\[desktop screenshot (cap_[0-9a-f]{12})\]/g;

const quote = (text: string, max = 80) => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
const box = (value: [number, number, number, number] | undefined) => (value ? ` @${value[0]},${value[1]} ${value[2]}x${value[3]}` : "");

export function observationText(obs: Observation): string {
  const lines: string[] = [];
  const size = `${obs.image.width}×${obs.image.height}`;
  if (obs.zoomOf && obs.region) {
    const r = obs.region;
    lines.push(`Zoom ${obs.captureId} (part of ${obs.zoomOf}): screen ${obs.display.id} from ${Math.round(r.x)},${Math.round(r.y)}, ${Math.round(r.width)}×${Math.round(r.height)} screen pixels, as a ${size} image. Aim x,y in this image with captureId ${obs.captureId}.`);
    return lines.join("\n");
  }
  lines.push(
    `Screenshot ${obs.captureId}: screen ${obs.display.id} (${obs.display.width}×${obs.display.height}), a ${size} image (1 image pixel = ${obs.scale} screen pixels)${obs.settled === false ? ", taken while the screen was changing" : ""}. Aim x,y in this image with captureId ${obs.captureId}.`,
  );
  if (obs.focus) {
    const where = obs.focus.app ? `${obs.focus.app}${obs.focus.appId ? ` (${obs.focus.appId})` : ""}${obs.focus.window ? `, window ${quote(obs.focus.window)}` : ""}` : "nothing (the desktop)";
    const focused = obs.focus.focused ? ` The keyboard is in a ${obs.focus.focused.role}${obs.focus.focused.name ? ` ${quote(obs.focus.focused.name, 60)}` : ""}${typeof obs.focus.focused.text === "string" && obs.focus.focused.text ? ` holding ${quote(obs.focus.focused.text, 120)}` : ""}.` : "";
    lines.push(`In front: ${where}.${focused}${obs.focus.prompt ? ` A password prompt of the desktop is open (${quote(obs.focus.prompt)}).` : ""}`);
  }
  if (obs.tree) {
    lines.push(`Elements of ${obs.tree.app}, window ${quote(obs.tree.window)} (boxes are x,y width x height inside that window; aim press, set_text, focus and click at an id):`);
    for (const element of obs.tree.elements) {
      const value = element.value !== undefined && element.value !== "" ? ` = ${typeof element.value === "string" ? quote(element.value, 100) : element.value}` : "";
      const states = element.states.filter((state) => state !== "showing" && state !== "visible" && state !== "enabled" && state !== "sensitive");
      lines.push(`${element.id} ${element.role}${element.name ? ` ${quote(element.name)}` : ""}${value}${states.length ? ` [${states.join(", ")}]` : ""}${element.actions.length ? ` {${element.actions.join(", ")}}` : ""}${box(element.box)}`);
    }
    if (obs.tree.truncated) lines.push("(more elements are not listed)");
  }
  if (obs.displays.length > 1) lines.push(`Screens: ${obs.displays.map((display) => `${display.id} ${display.width}×${display.height}${display.primary ? " (main)" : ""}`).join(", ")}.`);
  lines.push(...obs.notes);
  return lines.join("\n");
}

export function actText(result: ActResult): string {
  const lines = result.steps.map((step) => `${step.index + 1}. ${step.action}: ${step.verdict.replace("_", " ")}${step.ran !== "no" ? (step.ran === "maybe" ? " (may have run)" : "") : step.verdict === "not_run" || step.verdict === "refused" ? " (did not run)" : ""}${step.detail ? `. ${step.detail}` : ""}`);
  lines.unshift(`${result.ran} of ${result.steps.length} steps ran.`);
  if (result.stopped) lines.push(`Stopped at step ${result.stopped.at + 1}: ${result.stopped.reason}`);
  if (result.needsOwner) lines.push(`${result.needsOwner.name} needs your owner's answer first.`);
  if (result.observation) lines.push("", observationText(result.observation));
  else if (result.observeError) lines.push(`No new look: ${result.observeError} Look with desktop_observe before aiming at coordinates again.`);
  else lines.push("Look with desktop_observe before aiming at coordinates again.");
  return lines.join("\n");
}

export function statusText(status: DesktopStatus): string {
  const lines = Object.entries(status.facts).map(([name, fact]) => `${name}: ${fact.state}${fact.detail ? `, ${fact.detail}` : ""}${fact.fix ? ` Fix: ${fact.fix}` : ""}`);
  lines.push(`Screen control: ${status.session.state}${status.session.displays.length ? ` (${status.session.displays.map((display) => `${display.id} ${display.width}×${display.height}${display.primary ? " main" : ""}`).join(", ")})` : ""}.`);
  lines.push(status.lease.holder === "owner" ? `Your owner has the computer (since ${status.lease.since.slice(11, 16)}): your input waits.` : "You may use the computer when it is your turn.");
  if (status.controller) lines.push(`Driving the desktop now: ${status.controller.label} (since ${status.controller.since.slice(11, 16)}).`);
  if (status.recording) lines.push(`A recording ${status.recording.ended ? `ended (${status.recording.ended}) and waits to be saved` : "is running"}.`);
  return lines.join("\n");
}

export function appsText(apps: { installed: Array<{ id: string; name: string }>; running: Array<{ name: string; id: string | null; windows: Array<{ title: string; active: boolean }> }> }): string {
  const lines: string[] = [];
  if (apps.running.length) {
    lines.push("Running:");
    for (const app of apps.running) lines.push(`- ${app.name}${app.id ? ` (${app.id})` : ""}: ${app.windows.map((window) => `${quote(window.title || "untitled", 60)}${window.active ? " in front" : ""}`).join(", ")}`);
  }
  if (apps.installed.length) {
    lines.push("Installed (open with desktop_open and the id):");
    for (const app of apps.installed) lines.push(`- ${app.name}: ${app.id}`);
  }
  return lines.length ? lines.join("\n") : "No apps found.";
}

export function openText(opened: OpenResult): string {
  const done = Object.entries(opened.stages).filter(([, ok]) => ok).map(([stage]) => stage);
  const state = opened.stages.window ? (opened.focused ? "is open and in front" : "is open but not in front (click its window, or look first)") : opened.stages.accepted ? "was started but shows no window yet (look again in a moment)" : "did not start";
  return `${opened.app.name} (${opened.app.id}) ${state}. Reached: ${done.join(", ") || "nothing"}. Look with desktop_observe before acting.`;
}

export function recordingText(file: SavedRecording): string {
  return `Saved the recording: ${(file.durationMs / 1000).toFixed(1)} s, ${file.width}×${file.height}, ${file.codec}, ${Math.max(1, Math.round(file.size / 1024))} KB${file.truncated ? ", stopped at its length limit" : ""}. It is held for your owner to preview before it is shown or sent.`;
}

/** A failed call, in words, with what to do about it. */
export function failureText(error: DesktopError): string {
  const ran = error.ran === "maybe" ? " It may have run partly: look before trying again." : error.ran === "yes" ? " It ran." : "";
  return `${error.message}${ran}`;
}
