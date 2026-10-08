/** Bottom-edge height handle shared by diagram and plot embeds. Width always follows the page. */

export const EMBED_MIN_HEIGHT = 160;
export const EMBED_MAX_HEIGHT = 1400;
const STEP = 24;

export function clampEmbedHeight(value: number, min = EMBED_MIN_HEIGHT): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(EMBED_MAX_HEIGHT, Math.max(min, value)));
}

/** A stored height is a number of CSS pixels. Anything else falls back to the embed's own default. */
export function storedEmbedHeight(value: unknown, min = EMBED_MIN_HEIGHT): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? clampEmbedHeight(number, min) : null;
}

export function createHeightHandle(options: {
  label: string;
  min?: number;
  read: () => number;
  apply: (height: number) => void;
  commit: (height: number) => void;
}): HTMLElement {
  const min = options.min ?? EMBED_MIN_HEIGHT;
  const handle = document.createElement("div");
  handle.className = "embed-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", options.label);
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(EMBED_MAX_HEIGHT));
  handle.tabIndex = 0;
  handle.title = "Drag to resize. Arrow keys adjust the height.";
  handle.contentEditable = "false";
  const grip = document.createElement("span");
  grip.className = "embed-resize-grip";
  handle.append(grip);
  const sync = (height: number) => handle.setAttribute("aria-valuenow", String(Math.round(height)));
  sync(options.read());
  const refresh = () => sync(options.read());
  handle.addEventListener("focus", refresh);
  handle.addEventListener("pointerenter", refresh);

  let start: { y: number; height: number; pointer: number } | null = null;
  const move = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointer) return;
    const next = clampEmbedHeight(start.height + event.clientY - start.y, min);
    options.apply(next);
    sync(next);
  };
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointer) return;
    start = null;
    handle.classList.remove("is-dragging");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    options.commit(options.read());
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    start = { y: event.clientY, height: options.read(), pointer: event.pointerId };
    handle.classList.add("is-dragging");
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("mousedown", (event) => event.preventDefault());
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampEmbedHeight(options.read() + (event.key === "ArrowDown" ? STEP : -STEP), min);
    options.apply(next);
    sync(next);
    options.commit(next);
  });
  return handle;
}
