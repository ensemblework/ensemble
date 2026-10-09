"use client";
/**
 * board.drag → @dnd-kit/core 6 + @dnd-kit/sortable 10 (what apps/hub-web/components/board uses today).
 * Copy to apps/hub-web/components/motion/board-drag/ next to board-drag.js (+ .d.ts), board-drag.css and board-drag.app.css.
 *
 * What it gives board.tsx / task-card.tsx:
 *   useBoardDragSensors()        Mouse 6 px · Touch long-press 380 ms / 9 px · Keyboard (sortableKeyboardCoordinates)
 *   useBoardMotion()             { theme, reduced, sortable: {transition, animateLayoutChanges}, dropAnimation, measuring,
 *                                  accessibility: {announcements, screenReaderInstructions} }
 *   <BoardDragOverlay>           replaces <DragOverlay>: velocity tilt + lift + shadow (Lift), Expressive bead tether, haptics
 *   useBoardMoveMotion(ref, …)   agent / remote moves (React re-render moved a card): crane · glide · dot, FLIP for the rest
 *
 * UNTESTED IN THE APP: written against the dnd-kit 6.3 / sortable 10 types, not compiled here.
 */
import {
  DragOverlay, KeyboardSensor, MeasuringStrategy, MouseSensor, TouchSensor, defaultDropAnimationSideEffects,
  useDndContext, useDndMonitor, useSensor, useSensors,
  type Announcements, type DropAnimation, type ScreenReaderInstructions, type UniqueIdentifier,
} from "@dnd-kit/core";
import { defaultAnimateLayoutChanges, sortableKeyboardCoordinates, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as BDNamespace from "./board-drag";
import type { Lift, MotionTheme } from "./board-drag";

type BoardDragModule = typeof import("./board-drag");

/** The file is UMD (`module.exports = factory()`). Webpack exposes that object as `default`. */
function loadBoardDrag(mod: BoardDragModule & { default?: BoardDragModule }): BoardDragModule {
  if (typeof mod.mount === "function") return mod;
  if (mod.default && typeof mod.default.mount === "function") return mod.default;
  throw new Error("board.drag did not load");
}
const BD = loadBoardDrag(BDNamespace as BoardDragModule & { default?: BoardDragModule });

/* ---------- prefs: <html data-motion-theme data-reduce-motion> (set by lib/prefs.ts applyAppearance) ---------- */
export function useMotionPrefs(): { theme: MotionTheme; reduced: boolean } {
  const read = () => {
    if (typeof document === "undefined") return { theme: "expressive" as MotionTheme, reduced: false };
    const h = document.documentElement;
    return { theme: BD.themeOf(h), reduced: BD.reducedOf(h) };
  };
  const [prefs, setPrefs] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setPrefs(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion-theme", "data-reduce-motion"] });
    return () => mo.disconnect();
  }, []);
  return prefs;
}

/* ---------- sensors ---------- */
export function useBoardDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: BD.MOUSE.distance } }),
    // long-press so column/page scrolling still works; dnd-kit prevents touchmove once active
    useSensor(TouchSensor, { activationConstraint: { delay: BD.TOUCH.delay, tolerance: BD.TOUCH.tolerance } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }),
  );
}

/* ---------- per-style settings for DndContext / useSortable / DragOverlay ---------- */
const columnLabel = (id: UniqueIdentifier | undefined) => (id == null ? "" : String(id).replace(/_/g, " "));
export function boardMotion(theme: MotionTheme, reduced: boolean, titleOf: (id: UniqueIdentifier) => string = String) {
  const S = BD.STYLES[theme];
  const flipT = BD.timing(S.flip, reduced), dropT = BD.timing(S.drop, reduced);
  // useSortable({ transition }): dnd-kit's own transform shifts = our FLIP curve; null under reduced motion = instant
  const transition = reduced ? null : { duration: flipT.duration, easing: flipT.easing };
  // During a drag, and for the short beat after it, dnd-kit shifts siblings.
  // A remote or agent move is not a sort — useBoardMoveMotion plays that, so don't also FLIP it here.
  const animateLayoutChanges: AnimateLayoutChanges = (args) => {
    if (reduced || (!args.isSorting && !args.wasDragging)) return false;
    return defaultAnimateLayoutChanges({ ...args, wasDragging: true });
  };
  const dropAnimation: DropAnimation | null = reduced
    ? { duration: BD.REDUCED_FADE, easing: "linear", keyframes: () => [{ opacity: 1 }, { opacity: 0 }],
        sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }) }
    : { duration: dropT.duration, easing: dropT.easing,
        keyframes: ({ transform }) => [{ transform: CSS.Transform.toString(transform.initial) }, { transform: CSS.Transform.toString(transform.final) }],
        sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } }, className: { active: "is-landing" } }) };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}. Arrow keys move it, Space drops it, Escape cancels.`,
    onDragOver: ({ active, over }) => (over ? `${titleOf(active.id)} is over ${columnLabel(over.data.current?.sortable?.containerId ?? over.id)}.` : `${titleOf(active.id)} is not over a column.`),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${titleOf(active.id)} in ${columnLabel(over.data.current?.sortable?.containerId ?? over.id)}.` : `Cancelled. ${titleOf(active.id)} is back where it was.`),
    onDragCancel: ({ active }) => `Cancelled. ${titleOf(active.id)} is back where it was.`,
  };
  const screenReaderInstructions: ScreenReaderInstructions = { draggable: "Press Space to pick up. Use the arrow keys to move, Space to drop, Escape to cancel." };
  return {
    S, sortable: { transition, animateLayoutChanges }, dropAnimation,
    measuring: { droppable: { strategy: MeasuringStrategy.Always } },
    accessibility: { announcements, screenReaderInstructions },
  };
}
export function useBoardMotion(titleOf?: (id: UniqueIdentifier) => string) {
  const { theme, reduced } = useMotionPrefs();
  return { theme, reduced, ...useMemo(() => boardMotion(theme, reduced, titleOf), [theme, reduced, titleOf]) };
}

/* ---------- overlay: tilt from velocity, lift, shadow, haptics, Expressive tether ---------- */
function LiftLayer({ children, theme, reduced }: { children: ReactNode; theme: MotionTheme; reduced: boolean }) {
  const tilt = useRef<HTMLDivElement>(null), shadow = useRef<HTMLDivElement>(null), lift = useRef<Lift | null>(null);
  const { active, activatorEvent } = useDndContext();
  const v = useRef({ x: 0, t: 0, vx: 0 });
  useLayoutEffect(() => {
    if (!tilt.current) return;
    // pivot on the grab point (dnd-kit's activator event vs the card's initial rect)
    const r = active?.rect.current.initial, e = activatorEvent as PointerEvent | TouchEvent | null;
    const p = e && "touches" in e ? e.touches[0] : (e as PointerEvent | null);
    if (r && p && "clientX" in p) tilt.current.style.transformOrigin = `${p.clientX - r.left}px ${p.clientY - r.top}px`;
    lift.current = new BD.Lift(tilt.current, shadow.current, BD.STYLES[theme], reduced);
    lift.current.pickup(); BD.haptic("lift", document.documentElement);
    return () => lift.current?.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDndMonitor({
    onDragMove: ({ delta }) => {
      const now = performance.now(), s = v.current, dt = (now - s.t) / 1000;
      if (s.t && dt > 0.001) s.vx += ((delta.x - s.x) / dt - s.vx) * Math.min(1, dt * 22);
      s.x = delta.x; s.t = now; lift.current?.vel(s.vx);
    },
    onDragEnd: ({ over }) => { void lift.current?.release(); BD.haptic(over ? "drop" : "cancel", document.documentElement); },
    onDragCancel: () => { void lift.current?.release(); BD.haptic("cancel", document.documentElement); },
  });
  return (
    <div ref={tilt} className="bdg-float-tilt">
      <div ref={shadow} className="bdg-float-shadow" />
      {children}
    </div>
  );
}

/** Expressive only: 12 violet beads from the landing gap ([data-bdg-ph]) to the overlay. transform/opacity only. */
function Tether() {
  const { dragOverlay } = useDndContext();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id = 0;
    const beads = [...(host.current?.children ?? [])] as HTMLElement[];
    const tick = () => {
      const ph = document.querySelector("[data-bdg-ph]"), ov = dragOverlay.nodeRef.current;
      if (ph && ov) {
        const a = ph.getBoundingClientRect(), b = ov.getBoundingClientRect();
        const ax = a.left + a.width / 2, ay = a.top + a.height / 2, bx = b.left + b.width / 2, by = b.top + b.height / 2;
        const dist = Math.hypot(bx - ax, by - ay), show = Math.max(0, Math.min(1, (dist - 24) / 60));
        const cx = (ax + bx) / 2, cy = (ay + by) / 2 + 22 + dist * 0.16;
        beads.forEach((el, i) => {
          const t = i / (beads.length - 1), u = 1 - t;
          el.style.transform = `translate3d(${u * u * ax + 2 * u * t * cx + t * t * bx - 2}px, ${u * u * ay + 2 * u * t * cy + t * t * by - 2}px, 0)`;
          el.style.opacity = String(show * (0.35 + 0.55 * Math.sin(Math.PI * t)));
        });
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [dragOverlay.nodeRef]);
  return <div ref={host} className="bdg-layer" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} className="bdg-bead" />)}</div>;
}

/** Drop-in for <DragOverlay>. Children = the card body (CardBody without its old rotate/scale classes). */
export function BoardDragOverlay({ children, width = 264 }: { children: ReactNode; width?: number }) {
  const { theme, reduced, dropAnimation, S } = useBoardMotion();
  return (
    <>
      {children && S.tether && !reduced ? <Tether /> : null}
      {/* Pointer: no CSS transition. dnd-kit writes the ghost's transform on every move, so a transition would add latency.
          Keyboard: ease that same ghost transform with the style's FLIP curve. The lift itself is rotate and scale on the inner layer, not transform on a tile. */}
      <DragOverlay
        dropAnimation={dropAnimation}
        zIndex={60}
        className="bdg-float"
        transition={(event) => {
          if (reduced || !event || !("key" in event)) return undefined;
          const flip = BD.timing(S.flip, false);
          return `transform ${flip.duration}ms ${flip.easing}`;
        }}
      >
        {children ? <div style={{ width }}><LiftLayer theme={theme} reduced={reduced}>{children}</LiftLayer></div> : null}
      </DragOverlay>
    </>
  );
}

/* ---------- agent / remote moves (no drag): crane · glide · dot + FLIP for the shifted cards ---------- */
/**
 * Call in <Board>. Cards need data-bdg-card + data-id, lists data-bdg-list, columns data-column.
 * After every commit it compares each card's position with the previous commit (relative to the board, so scrolling
 * doesn't count). A card that changed column without a user drag is played as an agent move (or "done" if it landed
 * in the done column); cards that only shifted are FLIPped. Call skipNext() in onDragEnd so the user's own drop is
 * left to dnd-kit.
 */
type Spot = { x: number; y: number; w: number; h: number; col: string };

/** Viewport position plus every ancestor's scroll, so scrolling does not look like a move. */
function contentBox(el: HTMLElement): { x: number; y: number; w: number; h: number; left: number; top: number } {
  const box = el.getBoundingClientRect();
  let x = box.left;
  let y = box.top;
  const seen = new Set<HTMLElement>();
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    seen.add(node);
    x += node.scrollLeft;
    y += node.scrollTop;
    node = node.parentElement;
  }
  const scroller = document.scrollingElement;
  if (scroller instanceof HTMLElement && !seen.has(scroller)) {
    x += scroller.scrollLeft;
    y += scroller.scrollTop;
  }
  return { x, y, w: box.width, h: box.height, left: box.left, top: box.top };
}

export function useBoardMoveMotion(boardRef: RefObject<HTMLElement | null>, dragging: boolean) {
  const { theme, reduced } = useMotionPrefs();
  const engine = useRef<import("./board-drag").BoardDrag | null>(null);
  const prev = useRef(new Map<string, Spot>());
  const skip = useRef(false);
  useEffect(() => {
    if (!boardRef.current) return;
    engine.current = BD.mount(boardRef.current, { input: false, card: "[data-bdg-card]", column: "[data-column]", list: "[data-bdg-list]" });
    return () => { engine.current?.destroy(); engine.current = null; };
  }, [boardRef]);
  useLayoutEffect(() => {
    const root = boardRef.current; if (!root) return;
    const cards = [...root.querySelectorAll<HTMLElement>("[data-bdg-card]")];
    const next = new Map<string, Spot>();
    const ids: string[] = [];
    for (const el of cards) {
      const id = el.dataset.id;
      if (!id) continue;
      ids.push(id);
      const spot = contentBox(el);
      next.set(id, { x: spot.x, y: spot.y, w: spot.w, h: spot.h, col: el.closest<HTMLElement>("[data-column]")?.dataset.column ?? "" });
    }
    const prevIds = prev.current;
    const sameCards = prevIds.size === ids.length && ids.every((id) => prevIds.has(id));
    for (const el of cards) {
      const id = el.dataset.id;
      if (!id) continue;
      const was = prevIds.get(id);
      const now = next.get(id);
      if (!was || !now || dragging || skip.current) continue;
      const box = el.getBoundingClientRect();
      // Where this card would sit, at the current scroll, if it had not moved in content space.
      const from = { left: box.left - (now.x - was.x), top: box.top - (now.y - was.y), width: was.w, height: was.h };
      const shifted = Math.abs(from.left - box.left) >= 0.5 || Math.abs(from.top - box.top) >= 0.5;
      if (was.col !== now.col) void engine.current?.play(el, from, now.col === "done" ? "done" : "agent");
      else if (sameCards && shifted) BD.flipFrom(el, from, theme, reduced);
    }
    prev.current = next; skip.current = false;
  });
  return { skipNext: () => { skip.current = true; } };
}
