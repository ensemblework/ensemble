/* Ensemble motion suite runtime (round 3).
   A slot is a named moment ("agent.thinking"). A theme is a set of implementations + tokens.
   UM.register(theme, slot, impl)  ·  UM.mount(el)  → reads data-motion-slot and the nearest data-motion-theme,
   resolves through the fallback chain (minimal-dot → minimal-quiet → expressive), runs impl(scene, el).
   Needs u2-core.js (scene scheduler, tween, pointer). */
(function () {
  const UM = (window.UM = window.UM || {});
  const reg = {};
  UM.FALLBACK = { 'minimal-dot': 'minimal-quiet', 'minimal-quiet': 'expressive' };
  UM.register = (theme, slot, fn) => ((reg[theme] = reg[theme] || {})[slot] = fn);
  UM.resolve = (theme, slot) => { for (let t = theme; t; t = UM.FALLBACK[t]) if (reg[t] && reg[t][slot]) return reg[t][slot]; return null; };
  UM.themeOf = (el) => (el.closest('[data-motion-theme]') || document.documentElement).dataset.motionTheme || 'expressive';
  UM.mount = (el, opts = {}) => {
    const fn = UM.resolve(UM.themeOf(el), el.dataset.motionSlot);
    const sc = U2.scene(el);
    if (fn) { try { fn(sc, el, opts); } catch (e) { console.error(el.dataset.motionSlot, e); } }
    return sc;
  };
  /* cubic-bezier(x1,y1,x2,y2) as a JS easing, so JS-driven motion uses the same curves as the CSS tokens. */
  UM.bezier = (x1, y1, x2, y2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => { if (x <= 0) return 0; if (x >= 1) return 1; let t = x; for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; } return Y(U2.clamp(t)); };
  };
  UM.calm = UM.bezier(.33, 0, .2, 1);   // --m-ease-move
  UM.enter = UM.bezier(.25, .1, .25, 1); // --m-ease-enter
  UM.drift = UM.bezier(.45, 0, .55, 1);  // --m-ease-loop
  UM.U_OUT = 'M316 300 V540 A196 196 0 0 0 708 540 V300';
  UM.U_IN = 'M426 300 V540 A86 86 0 0 0 598 540 V300';
  /* hairline mark markup; size in px */
  UM.U = (size = 28, cls = '') => `<svg class="qu ${cls}" width="${size}" height="${size * 1.1}" viewBox="296 280 432 476" aria-hidden="true"><path class="o" d="${UM.U_OUT}"/><path class="i" d="${UM.U_IN}"/></svg>`;
  /* draw a path in: ms, ease; reverse=true erases */
  UM.draw = (sc, path, ms, ease = UM.calm, reverse = false) => {
    path.setAttribute('pathLength', '1'); path.style.strokeDasharray = '1';
    return sc.tween(ms, (p) => (path.style.strokeDashoffset = reverse ? p : 1 - p), ease);
  };
  /* crossfade a text node (class m-swap) */
  UM.swap = async (sc, el, text) => {
    if (sc.reduced) { el.textContent = text; return; }
    el.classList.add('out'); await sc.wait(260);
    el.textContent = text; el.classList.remove('out'); el.classList.add('in0'); void el.offsetWidth; el.classList.remove('in0');
    await sc.wait(300);
  };
  UM.sleep = (sc, ms) => sc.wait(ms);
})();
/* run a scripted sequence on repeat (once under reduced motion, ending on its final pose) */
UM.cycle = async (sc, fn, gap = 1400) => { do { await fn(); if (sc.reduced || !sc.alive) return; await sc.wait(gap); } while (sc.alive); };
