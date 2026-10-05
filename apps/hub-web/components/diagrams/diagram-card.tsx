"use client";

import { renderDiagramSvg, type DiagramModel } from "@ensemble/block-diagrams";
import { useEffect, useRef } from "react";
import { ApiError, api } from "@/lib/api";
import { MODULE_DENIED } from "@ensemble/shared-types/modules";

function themeOf(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function when(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** Read-only card: themed SVG, light pan and zoom, and Edit into the canvas. */
/** A quiet chip for a diagram mention when the template leaves out diagrams. Not a link. */
export function mountDiagramOff(host: HTMLElement, label: string): void {
  host.replaceChildren();
  host.className = "mention mention-off";
  host.setAttribute("aria-disabled", "true");
  host.title = "Diagrams are not part of your template. The diagram is still in your account.";
  host.textContent = `@${label || "Diagram"} · not part of your template`;
}

export function mountDiagramCard(host: HTMLElement, id: string, label: string): () => void {
  host.replaceChildren();
  host.className = "diagram-inline";
  const head = document.createElement("span");
  head.className = "diagram-inline-head";
  const title = document.createElement("span");
  title.className = "diagram-inline-title";
  title.textContent = label || "Diagram";
  const time = document.createElement("span");
  time.className = "diagram-inline-time";
  const edit = document.createElement("a");
  edit.className = "diagram-inline-edit";
  edit.href = `/diagrams/${id}`;
  edit.textContent = "Edit";
  const compact = document.createElement("button");
  compact.type = "button";
  compact.className = "diagram-inline-compact";
  const stored = window.localStorage.getItem("ensemble.diagramCard.compact") === "1";
  const applyCompact = (on: boolean) => {
    host.classList.toggle("is-compact", on);
    compact.textContent = on ? "Show" : "Compact";
    compact.setAttribute("aria-pressed", on ? "true" : "false");
  };
  applyCompact(stored);
  compact.addEventListener("click", () => {
    const on = !host.classList.contains("is-compact");
    window.localStorage.setItem("ensemble.diagramCard.compact", on ? "1" : "0");
    applyCompact(on);
  });
  head.append(title, time, compact, edit);
  const stage = document.createElement("span");
  stage.className = "diagram-inline-stage";
  const inner = document.createElement("span");
  inner.className = "diagram-inline-svg";
  stage.append(inner);
  host.append(head, stage);

  let scale = 1;
  let ox = 0;
  let oy = 0;
  const apply = () => {
    inner.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    scale = Math.min(2.5, Math.max(0.45, scale * (event.deltaY > 0 ? 0.92 : 1.08)));
    apply();
  };
  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  const onDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement | null)?.closest("a")) return;
    drag = { x: event.clientX, y: event.clientY, ox, oy };
    stage.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    ox = drag.ox + event.clientX - drag.x;
    oy = drag.oy + event.clientY - drag.y;
    apply();
  };
  const onUp = () => {
    drag = null;
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);

  let cancelled = false;
  void api.diagram(id).then(({ diagram }) => {
    if (cancelled) return;
    title.textContent = diagram.title || label || "Diagram";
    time.textContent = when(diagram.updatedAt);
    const model = diagram.model as DiagramModel;
    const svg = renderDiagramSvg(model, { theme: themeOf() }).replace(/^<\?xml[^>]*>\s*/, "");
    inner.innerHTML = svg;
  }).catch((error: unknown) => {
    if (cancelled) return;
    // The module can be off before the shell says so. Show the quiet chip, not a broken card.
    if (error instanceof ApiError && error.status === 404 && error.message === MODULE_DENIED) {
      mountDiagramOff(host, label);
      return;
    }
    time.textContent = "Couldn’t load";
  });

  return () => {
    cancelled = true;
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onDown);
    stage.removeEventListener("pointermove", onMove);
    stage.removeEventListener("pointerup", onUp);
  };
}

export function DiagramCard({ id, label }: { id: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return mountDiagramCard(node, id, label);
  }, [id, label]);
  return <div ref={ref} />;
}
