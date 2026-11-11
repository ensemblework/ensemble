import type { AgentState } from "./api";

export type ActivityTone = "offline" | "unknown" | "paused" | "working" | "starting" | "stopping" | "needs" | "queued" | "idle";

type State = Pick<AgentState, "paused" | "calls" | "running" | "waiting" | "queued">;

/** A missing or failed snapshot cannot establish that the account is idle. */
export function activityStatus({ data, connected, serverError = false, failed = false }: {
  data?: State;
  connected: boolean;
  serverError?: boolean;
  failed?: boolean;
}) {
  const stopping = data?.running.filter(job => job.status === "stopping").length ?? 0;
  const starting = data?.running.filter(job => job.status === "claimed").length ?? 0;
  const busy = (data?.calls.length ?? 0) + (data?.running.filter(job => job.status === "running").length ?? 0);
  const waiting = data?.waiting.length ?? 0;
  const queued = data?.queued.length ?? 0;
  const paused = data?.paused ?? false;
  const tone: ActivityTone = !connected ? "offline" : failed || !data ? "unknown" : paused ? "paused"
    : busy ? "working" : waiting ? "needs" : stopping ? "stopping" : starting ? "starting" : queued ? "queued" : "idle";
  const word = tone === "offline" ? (serverError ? "Server error" : "Offline")
    : tone === "unknown" ? (failed ? "Unavailable" : "Checking…")
    : tone === "paused" ? "Paused" : tone === "working" ? "Working" : tone === "starting" ? "Starting…" : tone === "stopping" ? "Stopping…"
    : tone === "needs" ? "Needs you" : tone === "queued" ? "Queued" : "Idle";
  const count = tone === "working" ? busy : tone === "needs" ? waiting : tone === "queued" ? queued : tone === "starting" ? starting : tone === "stopping" ? stopping : 0;
  const attention = connected && !failed && Boolean(data) && !paused && waiting > 0;
  const summary = tone === "offline" ? "Live activity is unavailable until the connection returns."
    : tone === "unknown" ? (failed ? "Activity could not be checked. Try again." : "Checking what the AI is doing.")
    : paused ? "Nothing calls a model until you resume."
    : [busy ? `${busy} running` : "", starting ? `${starting} starting` : "", stopping ? `${stopping} stopping` : "", waiting ? `${waiting} waiting for you` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ") || "No AI call is running or waiting.";
  const heading = tone === "offline" ? word : tone === "unknown" ? (failed ? "Activity unavailable" : "Checking activity")
    : paused ? "Paused" : busy ? "Running now" : waiting ? "Needs you" : stopping ? "Stopping" : starting ? "Starting" : queued ? "Queued" : "Nothing running";
  return { tone, word, count, label: count ? `${word} · ${count}` : word, attention, summary, heading, busy, starting, stopping, paused };
}
