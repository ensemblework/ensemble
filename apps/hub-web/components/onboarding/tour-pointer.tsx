"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useRef } from "react";
import { CHAPTER_TRANSITION, type SceneClock } from "./tour-playback";
import { CURSOR_PATHS, createHandoff, cursorPose, type Box, type Point, type Targets } from "./tour-cursor";

/** Where the arrow's tip sits inside its 24 px box. */
const TIP = { x: 5, y: 3 };

/** Position in canvas pixels, ignoring transforms, so a scene that is still sliding in measures where it will rest. */
function offsetWithin(node: HTMLElement, root: HTMLElement): Point | null {
  let x = 0;
  let y = 0;
  let el: HTMLElement | null = node;
  while (el && el !== root) {
    x += el.offsetLeft;
    y += el.offsetTop;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return null;
    if (parent !== root) { x += parent.clientLeft; y += parent.clientTop; }
    el = parent;
  }
  return el === root ? { x, y } : null;
}

type Measure = { scene: Box; targets: Targets; drag: HTMLElement | null };
function measureScene(canvas: HTMLElement, step: string, previous: Measure | null): Measure | null {
  const scene = canvas.querySelector<HTMLElement>(`.film-layer:not([data-phase="out"]) > .film-scene[data-scene="${step}"]`);
  const origin = scene && offsetWithin(scene, canvas);
  if (!scene || !origin || !scene.offsetWidth) return null;
  const scale = canvas.getBoundingClientRect().width / canvas.offsetWidth || 1;
  const frame = canvas.getBoundingClientRect();
  // A target that has left the scene (a closed menu) keeps its last place, so a stop never falls back mid-move.
  // A new layout (the compact canvas) starts afresh.
  const same = previous && previous.scene.width === scene.offsetWidth && previous.scene.height === scene.offsetHeight;
  const targets: Targets = same ? { ...previous.targets } : {};
  // Targets in the app's chrome (the assistant launcher) count too; the scene that is leaving does not.
  canvas.querySelectorAll<Element>("[data-film-target]").forEach((node) => {
    if (node.closest('.film-layer[data-phase="out"]')) return;
    const name = node.getAttribute("data-film-target")!;
    if (node instanceof HTMLElement) {
      const at = offsetWithin(node, canvas);
      if (at && (node.offsetWidth || node.offsetHeight)) targets[name] = { ...at, width: node.offsetWidth, height: node.offsetHeight };
      return;
    }
    // SVG has no offsets; its box is read from the screen and brought back to canvas pixels.
    const rect = node.getBoundingClientRect();
    if (rect.width || rect.height) targets[name] = { x: (rect.left - frame.left) / scale, y: (rect.top - frame.top) / scale, width: rect.width / scale, height: rect.height / scale };
  });
  return { scene: { ...origin, width: scene.offsetWidth, height: scene.offsetHeight }, targets, drag: scene.querySelector<HTMLElement>("[data-film-drag]") };
}

const moved = (a: Measure, b: Measure) => a.scene.x !== b.scene.x || a.scene.y !== b.scene.y || a.scene.width !== b.scene.width || a.scene.height !== b.scene.height
  || Object.keys(b.targets).some((key) => { const was = a.targets[key]; const now = b.targets[key]!; return !was || Math.abs(was.x - now.x) > .25 || Math.abs(was.y - now.y) > .25 || Math.abs(was.width - now.width) > .25 || Math.abs(was.height - now.height) > .25; });

/**
 * One pointer for the whole film. It lives above the scenes, so a chapter change, Back, a restart
 * or a resize moves it from where it is drawn instead of replacing it. It reads the scene's clock
 * every frame and only writes transforms and opacity; layout is read at the start of a frame.
 */
export function FilmPointer({ step, clock }: { step: string; clock: SceneClock }) {
  const pointer = useRef<HTMLSpanElement>(null);
  const ripple = useRef<HTMLSpanElement>(null);
  const live = useRef({ step, clock });
  live.current = { step, clock };
  useEffect(() => {
    const node = pointer.current!;
    const ring = ripple.current!;
    const arrow = node.firstElementChild as HTMLElement;
    const canvas = node.parentElement!;
    const handoff = createHandoff();
    let dirty = true;
    let frame = 0;
    let shown: Point | null = null;
    let opacity = 0;
    let last = { step: "", ms: 0, time: 0, measure: null as Measure | null, written: "", ring: "", arrow: "", drag: "" };
    const mark = () => { dirty = true; };
    const mutations = new MutationObserver(mark);
    mutations.observe(canvas, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(mark);
    resize.observe(canvas);
    const fonts = document.fonts;
    fonts?.addEventListener?.("loadingdone", mark);
    fonts?.ready?.then(mark).catch(() => {});

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const { step, clock } = live.current;
      const path = CURSOR_PATHS[step];
      const ms = clock.read(now);
      // Reads first: layout is measured before anything is written this frame.
      const chapter = step !== last.step;
      let measure = chapter ? null : last.measure;
      if (path && (dirty || chapter || !measure)) {
        const next = measureScene(canvas, step, chapter ? null : measure);
        if (next) {
          if (measure && !chapter && moved(measure, next)) {
            const before = handoff.apply(now, cursorPose(path, ms, measure.targets, measure.scene));
            handoff.rebase(now, before, cursorPose(path, ms, next.targets, next.scene), 320);
          }
          measure = next;
          dirty = false;
        }
      }
      if (chapter && (!path || measure)) {
        if (path && measure) {
          const pose = cursorPose(path, ms, measure.targets, measure.scene);
          // Glide in from where the pointer is drawn; appear in place if it was hidden.
          if (shown && opacity > .05) handoff.rebase(now, shown, pose, CHAPTER_TRANSITION);
          else { handoff.rebase(now, pose, pose, 1); opacity = 0; }
        }
        last = { ...last, step, ms, measure, drag: "" };
      } else if (path && measure && (ms < last.ms - 1 || ms > last.ms + 250)) {
        // A restart or seek: ease back to the new moment from where the pointer is.
        const before = handoff.apply(now, cursorPose(path, last.ms, measure.targets, measure.scene));
        handoff.rebase(now, before, cursorPose(path, ms, measure.targets, measure.scene), 480);
      }
      const dt = Math.min(64, last.time ? now - last.time : 16);
      opacity += ((path && measure ? 1 : 0) - opacity) * (1 - Math.exp(-dt / 70));
      if (Math.abs(opacity - Math.round(opacity)) < .01) opacity = Math.round(opacity);
      let ringCss = "opacity:0";
      if (path && measure) {
        const pose = cursorPose(path, ms, measure.targets, measure.scene);
        shown = handoff.apply(now, pose);
        const press = `scale(${(1 - pose.press * .14).toFixed(3)})`;
        if (press !== last.arrow) { arrow.style.transform = press; last.arrow = press; }
        if (pose.ripple) {
          const grow = 1 - Math.pow(2, -8 * pose.ripple.t);
          ringCss = `opacity:${(.5 * (1 - pose.ripple.t) * opacity).toFixed(3)};transform:translate3d(${pose.ripple.x.toFixed(2)}px,${pose.ripple.y.toFixed(2)}px,0) translate(-50%,-50%) scale(${(.35 + .75 * grow).toFixed(3)})`;
        }
        const drag = pose.drag;
        const carried = drag ? `transform:translate3d(${drag.offset.x.toFixed(2)}px,${drag.offset.y.toFixed(2)}px,0) rotate(${(drag.tilt * drag.lift).toFixed(2)}deg) scale(${(1 + .02 * drag.lift).toFixed(3)});--lift:${drag.lift.toFixed(3)}` : "";
        if (measure.drag && carried !== last.drag) { measure.drag.style.cssText = carried; last.drag = carried; }
      }
      // A scene without a pointer (the intro and the ending) fades it out where it is.
      const css = shown ? `opacity:${opacity.toFixed(3)};transform:translate3d(${(shown.x - TIP.x).toFixed(2)}px,${(shown.y - TIP.y).toFixed(2)}px,0)` : "opacity:0";
      if (css !== last.written) { node.style.cssText = css; last.written = css; }
      if (ringCss !== last.ring) { ring.style.cssText = ringCss; last.ring = ringCss; }
      last = { ...last, ms, time: now, measure };
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      fonts?.removeEventListener?.("loadingdone", mark);
    };
  }, []);
  return <>
    <span ref={ripple} className="film-ripple" aria-hidden />
    <span ref={pointer} className="film-pointer" aria-hidden style={{ opacity: 0 }}>
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3v15.2l3.9-3.7 2.6 6.1 2.9-1.2-2.6-6h5.5z" /></svg>
    </span>
  </>;
}
