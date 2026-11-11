/**
 * Wheel scrolling between a page and a scrollable preview inside it, such as a PDF or Word
 * attachment on a page or task.
 *
 * - Scrolling that starts with the pointer over a preview scrolls the preview. At its top or
 *   bottom the rest goes to the page, as with any scroll box.
 * - Scrolling that started on the page keeps scrolling the page when a preview slides under the
 *   pointer. The preview takes the wheel only once the wheel has rested for `LATCH_MS`.
 */
export const HANDOFF_ATTR = "data-scroll-handoff";
export const LATCH_MS = 450;

let pageWheelAt = Number.NEGATIVE_INFINITY;
let listening: Window | null = null;

function clock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Remembers when the page itself last took a wheel event. One listener per window. */
function listen(view: Window, now: () => number): void {
  if (listening === view) return;
  listening = view;
  view.addEventListener(
    "wheel",
    (event) => {
      const target = event.target as Element | null;
      if (typeof target?.closest === "function" && target.closest(`[${HANDOFF_ATTR}]`)) return;
      pageWheelAt = now();
    },
    { capture: true, passive: true },
  );
}

/** The nearest ancestor that scrolls vertically, or the document. */
export function scrollParent(node: Element): HTMLElement | null {
  const view = node.ownerDocument.defaultView;
  let current = node.parentElement;
  while (current && view) {
    const overflow = view.getComputedStyle(current).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && current.scrollHeight > current.clientHeight + 1) return current;
    current = current.parentElement;
  }
  return (node.ownerDocument.scrollingElement as HTMLElement | null) ?? null;
}

function pixels(event: WheelEvent, page: HTMLElement): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.clientHeight : 1;
  return event.deltaY * unit;
}

/**
 * Hands a preview's wheel events to the page while the page is mid-scroll. `events` is where the
 * preview's wheel events arrive (the element itself, or an iframe's window); `host` is the
 * preview's element in the page. Returns a function that detaches it.
 */
export function attachScrollHandoff(events: EventTarget, host: HTMLElement, now: () => number = clock): () => void {
  const view = host.ownerDocument.defaultView;
  if (view) listen(view, now);
  host.setAttribute(HANDOFF_ATTR, "");
  const onWheel = (raw: Event) => {
    const event = raw as WheelEvent;
    // Pinch-zoom, and sideways scrolling (wide tables, sheets), stay with the preview.
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const at = now();
    if (at - pageWheelAt > LATCH_MS) return;
    const page = scrollParent(host);
    if (!page) return;
    event.preventDefault();
    page.scrollTop += pixels(event, page);
    pageWheelAt = at;
  };
  events.addEventListener("wheel", onWheel, { passive: false });
  return () => events.removeEventListener("wheel", onWheel);
}

/** For tests: forget the page's last wheel. */
export function resetScrollHandoff(): void {
  pageWheelAt = Number.NEGATIVE_INFINITY;
  listening = null;
}
