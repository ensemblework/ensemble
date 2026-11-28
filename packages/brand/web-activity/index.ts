import { agentFrame, stepPose, type AgentShape, type MarkSize, type Pose } from './geometry';

export { markSizes, type AgentShape, type MarkSize } from './geometry';

export const AGENT_SHOW_DELAY_MS = 350;

type Tick = (dt: number) => void;
const playing = new Set<Tick>();
let frame = 0, last = 0;
function schedule() {
  if (!playing.size || document.hidden) { if (frame) cancelAnimationFrame(frame); frame = last = 0; return; }
  if (!frame) frame = requestAnimationFrame(advance);
}
function advance(now: number) {
  frame = 0;
  if (!document.hidden && (!last || now - last >= 1000 / 30 - 1)) {
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    for (const tick of playing) tick(dt);
  }
  schedule();
}
function play(tick: Tick, on: boolean) {
  if (on === playing.has(tick)) return;
  if (on) {
    if (!playing.size) document.addEventListener('visibilitychange', schedule);
    playing.add(tick);
  } else {
    playing.delete(tick);
    if (!playing.size) document.removeEventListener('visibilitychange', schedule);
  }
  schedule();
}

/** Frames mutate just the paths. React renders the actual status and never waits on a frame. */
export function mountAgentPlayer(host: HTMLSpanElement, size: MarkSize, settled: () => void) {
  const rest = host.querySelector<SVGElement>('[data-rest]')!, live = host.querySelector<SVGSVGElement>('[data-live]')!;
  const [b, a] = live.querySelectorAll('path');
  const pose: Pose = { q: 0, velocity: 0, phase: .16, kind: 'exchange' };
  let wanted: AgentShape | null = null, reduced = false, visible = typeof IntersectionObserver === 'undefined', destroyed = false;
  function showRest() { rest.style.opacity = '1'; live.style.opacity = '0'; }
  function tick(dt: number) {
    stepPose(pose, wanted, dt);
    if (pose.q === 0) {
      showRest();
      if (!wanted) { play(tick, false); settled(); }
      return;
    }
    const { a: first, b: second, width, second: opacity } = agentFrame(pose.kind, size, pose.q, pose.phase);
    a.setAttribute('d', first); b.setAttribute('d', second); b.style.opacity = String(opacity);
    live.setAttribute('stroke-width', String(width));
    const t = Math.min(1, pose.q / .055), fade = t * t * (3 - 2 * t);
    live.style.opacity = String(fade); rest.style.opacity = String(1 - fade);
  }
  function sync() {
    if (destroyed) return;
    if (reduced || (!wanted && (!visible || document.hidden || !pose.q))) {
      play(tick, false); pose.q = pose.velocity = 0; showRest(); if (!wanted) settled();
    } else play(tick, visible);
  }
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  observer?.observe(host);
  return {
    update(next: AgentShape | null, reduce: boolean) { wanted = next; reduced = reduce; sync(); },
    destroy() { destroyed = true; observer?.disconnect(); play(tick, false); },
  };
}
