"use client";

import { ApiError, api } from "@/lib/api";
import { MODULE_DENIED } from "@ensemble/shared-types/modules";

/** A quiet chip for a plot mention when the template leaves Plots off. */
export function mountPlotOff(host: HTMLElement, label: string): void {
  host.replaceChildren();
  host.className = "mention mention-off";
  host.setAttribute("aria-disabled", "true");
  host.title = "Plots are not part of your template. The plot is still in your account.";
  host.textContent = `@${label || "Plot"} · not part of your template`;
}

/** Read-only card: title, a small sparkline, and a link into the studio. */
export function mountPlotCard(host: HTMLElement, id: string, label: string): () => void {
  host.replaceChildren();
  host.className = "diagram-inline";
  const head = document.createElement("span");
  head.className = "diagram-inline-head";
  const title = document.createElement("span");
  title.className = "diagram-inline-title";
  title.textContent = label || "Plot";
  const edit = document.createElement("a");
  edit.className = "diagram-inline-edit";
  edit.href = `/plots/${id}`;
  edit.textContent = "Open";
  head.append(title, edit);
  const stage = document.createElement("span");
  stage.className = "diagram-inline-stage";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 72");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "72");
  stage.append(svg);
  host.append(head, stage);
  let stopped = false;
  void api.plot(id).then((result) => {
    if (stopped) return;
    title.textContent = result.plot.title || label || "Plot";
    const spark = result.spark.filter((value) => Number.isFinite(value));
    if (spark.length < 2) return;
    const min = Math.min(...spark);
    const max = Math.max(...spark);
    const span = max - min || 1;
    const points = spark
      .map((value, index) => {
        const x = (index / (spark.length - 1)) * 312 + 4;
        const y = 64 - ((value - min) / span) * 52;
        return `${x},${y}`;
      })
      .join(" ");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("points", points);
    svg.append(line);
  }).catch((error: unknown) => {
    if (stopped) return;
    if (error instanceof ApiError && error.status === 404 && error.message === MODULE_DENIED) mountPlotOff(host, label);
  });
  return () => {
    stopped = true;
  };
}
