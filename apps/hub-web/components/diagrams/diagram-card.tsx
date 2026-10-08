"use client";

import { renderDiagramSvg, type DiagramModel } from "@ensemble/block-diagrams";
import { useEffect, useRef } from "react";
import { ApiError, api } from "@/lib/api";
import { MODULE_DENIED } from "@ensemble/shared-types/modules";
import { clampEmbedHeight, createHeightHandle, storedEmbedHeight } from "../editor/embed-resize";

function themeOf(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function when(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** A quiet chip for a diagram mention when the template leaves out diagrams. Not a link. */
export function mountDiagramOff(host: HTMLElement, label: string): void {
  host.replaceChildren();
  host.className = "mention mention-off";
  host.setAttribute("aria-disabled", "true");
  host.title = "Diagrams are not part of your template. The diagram is still in your account.";
  host.textContent = `@${label || "Diagram"} · not part of your template`;
}

/** Themed SVG with pan, zoom and Fit. On an editable page the bottom edge sets the height. */
export type DiagramCardOptions = {
  /** Stored embed height. Null fits the diagram once it has loaded. */
  height?: number | null;
  /** Present only where the height may be changed (an editable page). */
  onResize?: (height: number) => void;
};

export type DiagramCardHandle = { destroy: () => void; setHeight: (height: number | null) => void };

const DIAGRAM_MIN_HEIGHT = 180;
const DIAGRAM_FIT_MAX = 560;

export function mountDiagramCard(host: HTMLElement, id: string, label: string, options: DiagramCardOptions = {}): DiagramCardHandle {
  host.replaceChildren();
  host.className = "diagram-inline";
  const head = document.createElement("span");
  head.className = "diagram-inline-head";
  const title = document.createElement("span");
  title.className = "diagram-inline-title";
  title.textContent = label || "Diagram";
  const time = document.createElement("span");
  time.className = "diagram-inline-time";
  const fit = document.createElement("button");
  fit.type = "button";
  fit.className = "diagram-inline-compact";
  fit.textContent = "Fit";
  fit.title = "Fit the whole diagram in view";
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
  head.append(title, time, fit, compact, edit);
  const stage = document.createElement("span");
  stage.className = "diagram-inline-stage";
  const inner = document.createElement("span");
  inner.className = "diagram-inline-svg";
  stage.append(inner);
  host.append(head, stage);

  let explicit = storedEmbedHeight(options.height, DIAGRAM_MIN_HEIGHT);
  let natural: { width: number; height: number } | null = null;
  const fitted = () => clampEmbedHeight(Math.min(DIAGRAM_FIT_MAX, (natural?.height ?? 216) + 24), DIAGRAM_MIN_HEIGHT);
  let height = explicit ?? 240;
  const applyHeight = (next: number) => {
    height = next;
    stage.style.height = `${next}px`;
  };
  applyHeight(height);

  let scale = 1;
  let ox = 0;
  let oy = 0;
  const apply = () => {
    inner.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
  };
  const fitView = () => {
    if (!natural) return;
    const width = stage.clientWidth || host.clientWidth || natural.width;
    scale = Math.min(1, (width - 24) / natural.width, (height - 24) / natural.height);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    ox = Math.max(12, (width - natural.width * scale) / 2);
    oy = Math.max(12, (height - natural.height * scale) / 2);
    apply();
  };
  fit.addEventListener("click", fitView);
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    scale = Math.min(2.5, Math.max(0.2, scale * (event.deltaY > 0 ? 0.92 : 1.08)));
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

  if (options.onResize) {
    const commit = options.onResize;
    host.append(
      createHeightHandle({
        label: `Resize ${label || "diagram"}`,
        min: DIAGRAM_MIN_HEIGHT,
        read: () => height,
        apply: (next) => {
          explicit = next;
          applyHeight(next);
        },
        commit: (next) => {
          fitView();
          commit(next);
        },
      }),
    );
  }

  let cancelled = false;
  void api.diagram(id).then(({ diagram }) => {
    if (cancelled) return;
    title.textContent = diagram.title || label || "Diagram";
    time.textContent = when(diagram.updatedAt);
    const model = diagram.model as DiagramModel;
    const svg = renderDiagramSvg(model, { theme: themeOf() }).replace(/^<\?xml[^>]*>\s*/, "");
    inner.innerHTML = svg;
    const node = inner.querySelector("svg");
    const box = node?.getBoundingClientRect();
    const width = Number(node?.getAttribute("width")) || box?.width || 0;
    const tall = Number(node?.getAttribute("height")) || box?.height || 0;
    natural = width > 0 && tall > 0 ? { width, height: tall } : null;
    if (explicit === null) applyHeight(fitted());
    fitView();
  }).catch((error: unknown) => {
    if (cancelled) return;
    // The module can be off before the shell says so. Show the quiet chip, not a broken card.
    if (error instanceof ApiError && error.status === 404 && error.message === MODULE_DENIED) {
      mountDiagramOff(host, label);
      return;
    }
    time.textContent = "Couldn’t load";
  });

  return {
    destroy: () => {
      cancelled = true;
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
    },
    setHeight: (next) => {
      explicit = storedEmbedHeight(next, DIAGRAM_MIN_HEIGHT);
      applyHeight(explicit ?? fitted());
      fitView();
    },
  };
}

export function DiagramCard({ id, label }: { id: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return mountDiagramCard(node, id, label).destroy;
  }, [id, label]);
  return <div ref={ref} />;
}
