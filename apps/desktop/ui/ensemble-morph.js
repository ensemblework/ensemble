/* brand.morph: the Two-voices mark morphing mark -> infinity (-> linked rings) -> mark. SVG, no dependencies, UMD.
 * It starts and ends on the hinted Two-voices mark, so the resting frame IS the logo.
 *
 *   <span class="u-morph" data-motion-slot="brand.morph" data-state="idle" data-size="20"></span>
 *   const m = EnsembleMorph.mount(el)          // or EnsembleMorph.autoMount() for every [data-motion-slot="brand.morph"]
 *   m.once()      -> Promise   mark -> inf -> mark, 1.5 s, gentle ramp in/out (logo click while the route loads)
 *   m.loop({delay: 180})       loop while something is really loading / the agent is really working
 *   m.settle()    -> Promise   ease back to the mark from wherever it is, then stop (call when loading ends)
 *   m.idle()                   jump to the still mark immediately
 *   data-state="idle|once|loop|settle" on the element drives the same calls; the element writes back
 *   data-state="idle" and fires "ensemble:morph-idle" when it is resting on the mark again.
 * One morph for every style (round 5b): Expressive, Quiet and Dot all draw the Expressive ribbon morph at the same even pace.
 * Reduced motion (OS setting or [data-reduce-motion="true"]): always the still mark; once()/settle() resolve at once,
 * loop() shows the still mark (the status text carries the meaning).
 */
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M; else root.EnsembleMorph = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // hinted params from round5-brand/logo/hinting.json (same method as the round-4 tray): W, H, ow, g, iw per pixel box
  const HINT = { 16: { W: 12, H: 13, ow: 2, g: 1, iw: 2 }, 20: { W: 16, H: 17, ow: 3, g: 1, iw: 2 }, 24: { W: 18, H: 20, ow: 3, g: 1, iw: 3 }, 32: { W: 24, H: 26, ow: 4, g: 2, iw: 3 } };
  const n = 64;
  const ease = {
    io: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    ios: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
    out: (x) => 1 - Math.pow(1 - x, 3),
    back: (x) => { const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
    lin: (x) => x,
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpPts = (A, B, k) => A.map((p, i) => [lerp(p[0], B[i][0], k), lerp(p[1], B[i][1], k)]);

  /* geometry for a box of N px. Small sizes use the hand-hinted integers so the still frame is pixel-exact. */
  function geom(N) {
    let h = HINT[N];
    if (!h) { const s = N / 608; h = { W: 476 * s, H: 520 * s, ow: 84 * s, g: 36 * s, iw: 64 * s }; }
    const round = N >= 32, cx = N / 2;
    const top = HINT[N] ? Math.floor((N - h.H) / 2) : (N - h.H) / 2;
    const bottom = top + h.H, r1 = h.W / 2, cy = bottom - r1;
    const capo = round ? h.ow / 2 : 0, y0 = top + capo;
    const ro = r1 - h.ow / 2, ri = r1 - h.ow - h.g - h.iw / 2;          // centreline radii
    return { N, cx, cy, y0, ro, ri, ow: h.ow, iw: h.iw, cap: round ? 'round' : 'butt' };
  }
  function uLine(G, r) {           // centreline: left arm down, half circle, right arm up; sampled by arc length
    const arm = G.cy - G.y0, arc = Math.PI * r, L = 2 * arm + arc, P = [];
    for (let j = 0; j < n; j++) {
      const d = (j / (n - 1)) * L;
      if (d <= arm) P.push([G.cx - r, G.y0 + d]);
      else if (d <= arm + arc) { const a = Math.PI - (d - arm) / r; P.push([G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)]); }
      else P.push([G.cx + r, G.cy - (d - arm - arc)]);
    }
    return P;
  }
  function uPath(G, r) { return `M${G.cx - r} ${G.y0}V${G.cy}A${r} ${r} 0 0 0 ${G.cx + r} ${G.cy}V${G.y0}`; }
  // lemniscate of Bernoulli, s in [0,1) once round; s = 0 is the crossing
  function lem(G, s) {
    const a = 0.41 * G.N, t = -Math.PI / 2 + s * Math.PI * 2, d = 1 + Math.sin(t) ** 2;
    return [G.cx + (a * Math.cos(t)) / d, G.N / 2 + (a * Math.sin(t) * Math.cos(t)) / d];
  }
  const LEN = 0.42;              // each voice covers 42 % of the loop; they sit half a lap apart
  function lemSeg(G, from) { const P = []; for (let j = 0; j < n; j++) P.push(lem(G, from + (LEN * j) / (n - 1))); return P; }
  function ring(G, side, ph) {
    const r = 0.24 * G.N, cx = G.cx + side * 0.15 * G.N, cy = G.N / 2, P = [];
    for (let j = 0; j < n; j++) { const a = -Math.PI / 2 + side * (j / (n - 1) + ph) * Math.PI * 2; P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return P;
  }

  /* Timing (seconds). Round 5b: ONE morph for every style (the Expressive ribbon morph), evenly paced.
     loop: mark -> inf (one lap of flow) -> mark at every size (the linked rings were dropped so the speed is the same everywhere). Progress is re-parameterised by arc length
     (mean distance travelled by all strand points), so the path speed is constant; the only easing is a short velocity
     ramp at the very start (ramp) and the final settle. once: the same path without the rings, ramped in and out. */
  const BASE = { once: 1.5, loop: 2.7, loopLarge: 2.7, settle: 0.38, ramp: 0.35, onceRamp: 0.3, settleEase: 'out' };   // cruise ~1.08 icon-widths/s everywhere
  const T = { expressive: BASE, 'minimal-quiet': BASE, 'minimal-dot': BASE };
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);

  function rest(G, style) {
    return { o: uLine(G, G.ro), i: uLine(G, G.ri), wo: G.ow, wi: G.iw, ghost: 1, dots: null, rest: true, style };
  }
  /* path(mode, u, G): the raw shape at path parameter u in [0,1] (pieces are linear in u, re-timed below) */
  const ONCE_FLOW = 0.33;           // once = mark -> inf -> about a quarter lap -> mark, so its cruise speed matches the loop
  const thinOf = (G) => Math.max(1.5, G.ow * 0.8);
  function rawShape(mode, u, G) {
    if (mode === 'loopLarge') mode = 'loop';   // rings dropped in 5b: same path, same speed at every size
    const UO = G._UO || (G._UO = uLine(G, G.ro)), UI = G._UI || (G._UI = uLine(G, G.ri)), tw = thinOf(G);
    const W = (k) => ({ wo: lerp(G.ow, tw, k), wi: lerp(G.iw, Math.min(G.iw, tw * 0.8), k) });
    const P = mode === 'loopLarge' ? [0.12, 0.40, 0.52, 0.80, 1] : mode === 'once' ? [0.25, 0.75, 1] : [0.18, 0.82, 1];
    const lemPair = (ph) => [lemSeg(G, ph), lemSeg(G, ph + 0.5)];
    if (u <= P[0]) { const k = u / P[0], [a, b] = lemPair(0.1 * k); return { o: lerpPts(UO, a, k), i: lerpPts(UI, b, k), ...W(k) }; }
    const flowEnd = mode === 'once' ? ONCE_FLOW : 1.1;
    if (u <= P[1]) { const k = (u - P[0]) / (P[1] - P[0]), [a, b] = lemPair(lerp(0.1, flowEnd, k)); return { o: a, i: b, ...W(1) }; }
    if (mode !== 'loopLarge') { const k = (u - P[1]) / (1 - P[1]), [a, b] = lemPair(flowEnd + 0.1 * k); return { o: lerpPts(a, UO, k), i: lerpPts(b, UI, k), ...W(1 - k) }; }
    if (u <= P[2]) { const k = (u - P[1]) / (P[2] - P[1]), [a, b] = lemPair(flowEnd); return { o: lerpPts(a, ring(G, -1, 0), k), i: lerpPts(b, ring(G, 1, 0), k), ...W(1) }; }
    if (u <= P[3]) { const k = (u - P[2]) / (P[3] - P[2]); return { o: ring(G, -1, k), i: ring(G, 1, k), ...W(1) }; }
    const k = (u - P[3]) / (1 - P[3]); return { o: lerpPts(ring(G, -1, 1), UO, k), i: lerpPts(ring(G, 1, 1), UI, k), ...W(1 - k) };
  }
  /* arc-length table: cumulative mean point displacement along u, so equal time = equal distance */
  function table(mode, G) {
    if (mode === 'loopLarge') mode = 'loop';
    G._tab = G._tab || {};
    if (G._tab[mode]) return G._tab[mode];
    const M = 2400, us = [], cum = [0]; let prev = rawShape(mode, 0, G);
    for (let j = 0; j <= M; j++) us.push(j / M);
    for (let j = 1; j <= M; j++) {
      const s = rawShape(mode, us[j], G); let d = 0;
      for (let q = 0; q < n; q++) d += Math.hypot(s.o[q][0] - prev.o[q][0], s.o[q][1] - prev.o[q][1]) + Math.hypot(s.i[q][0] - prev.i[q][0], s.i[q][1] - prev.i[q][1]);
      cum.push(cum[j - 1] + d / (2 * n)); prev = s;
    }
    const total = cum[M];
    return (G._tab[mode] = { us, cum: cum.map((c) => c / total), total });
  }
  function uAt(tab, s) {               // invert the cumulative table (binary search + linear)
    s = clamp(s, 0, 1); let lo = 0, hi = tab.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab.cum[m] < s) lo = m; else hi = m; }
    const span = tab.cum[hi] - tab.cum[lo] || 1; return lerp(tab.us[lo], tab.us[hi], (s - tab.cum[lo]) / span);
  }
  /* distance fraction travelled after t seconds with a linear velocity ramp of r seconds at the start (and end, for once) */
  function progress(mode, t, D, r) {
    if (mode === 'once') {           // trapezoid: ramp in, cruise, ramp out; total area = 1
      const v = 1 / (D - r); t = clamp(t, 0, D);
      if (t < r) return (v * t * t) / (2 * r);
      if (t > D - r) { const x = D - t; return 1 - (v * x * x) / (2 * r); }
      return v * (t - r / 2);
    }
    const v = 1 / D;                 // loop: ramp in once, then constant forever
    return t < r ? (v * t * t) / (2 * r) : v * (t - r / 2);
  }
  /* frame(style, mode, t, G): style is accepted for API compatibility; every style draws the same morph */
  function frame(style, mode, t, G) {
    const tl = T[style] || BASE, D = tl[mode] || tl.loop, s = progress(mode, t, D, mode === 'once' ? tl.onceRamp : tl.ramp);
    const u = mode === 'once' ? uAt(table(mode, G), s) : uAt(table(mode, G), s - Math.floor(s));
    const f = rawShape(mode, u, G);
    return { o: f.o, i: f.i, wo: f.wo, wi: f.wi, ghost: 1, dots: null };
  }
  /* time of one full loop after the ramp-in: the loop repeats every D seconds once t >= ramp */
  const loopStart = (tl) => tl.ramp / 2;
  function mix(A, B, k) {          // settle: per-point lerp of two frames
    return { o: lerpPts(A.o, B.o, k), i: lerpPts(A.i, B.i, k), wo: lerp(A.wo, B.wo, k), wi: lerp(A.wi, B.wi, k), ghost: 1, dots: null };
  }
  const d = (P, frac = 1) => { const m = Math.max(2, Math.round(P.length * frac)); return 'M' + P.slice(0, m).map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L'); };

  /* static still mark (SSR / no-JS / reduced motion). Hinted at 16/20/24/32. */
  function staticSVG(N, opts = {}) {
    const G = geom(N), label = opts.label ? ` role="img" aria-label="${opts.label}"` : ' aria-hidden="true"';
    return `<svg class="u-morph-svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}" fill="none" stroke-linecap="${G.cap}"${label}>` +
      `<path class="u-mo" stroke-width="${G.ow}" d="${uPath(G, G.ro)}"/><path class="u-mi" stroke-width="${G.iw}" d="${uPath(G, G.ri)}"/>` +
      `<circle class="u-md" r="0" opacity="0"/><circle class="u-md u-md2" r="0" opacity="0"/></svg>`;
  }
  const reducedNow = (el) => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) || !!(el.closest && el.closest('[data-reduce-motion="true"]'));
  const styleOf = (el) => el.dataset.style || (el.closest('[data-motion-theme]') || { dataset: {} }).dataset.motionTheme || 'expressive';

  function mount(el, opts = {}) {
    if (el.__morph) return el.__morph;
    const N = +(opts.size || el.dataset.size || 20);
    if (!el.querySelector('svg.u-morph-svg')) el.innerHTML = staticSVG(N, { label: el.dataset.label });
    const svg = el.querySelector('svg'), po = svg.querySelector('.u-mo'), pi = svg.querySelector('.u-mi'), [d1, d2] = svg.querySelectorAll('.u-md');
    const G = geom(N);
    let raf = 0, mode = 'idle', t0 = 0, cur = rest(G), settleFrom = null, settleT0 = 0, done = null, delayTimer = 0;
    let written = el.dataset.state || 'idle';
    const setState = (s) => { written = s; if (el.dataset.state !== s) el.dataset.state = s; };   // our own writes never re-trigger apply()
    const paint = (f) => {
      if (f.rest) { po.setAttribute('d', uPath(G, G.ro)); pi.setAttribute('d', uPath(G, G.ri)); po.setAttribute('stroke-width', G.ow); pi.setAttribute('stroke-width', G.iw);
        po.style.opacity = pi.style.opacity = ''; d1.setAttribute('opacity', 0); d2.setAttribute('opacity', 0); return; }
      po.setAttribute('d', d(f.o)); pi.setAttribute('d', d(f.i));
      po.setAttribute('stroke-width', f.wo.toFixed(2)); pi.setAttribute('stroke-width', f.wi.toFixed(2));
      po.style.opacity = pi.style.opacity = String(f.ghost);
      [d1, d2].forEach((c, j) => { const q = f.dots && f.dots[j]; if (!q) { c.setAttribute('opacity', 0); return; } c.setAttribute('cx', q.x.toFixed(2)); c.setAttribute('cy', q.y.toFixed(2)); c.setAttribute('r', q.r.toFixed(2)); c.setAttribute('opacity', q.a.toFixed(2)); });
    };
    const finish = () => { el.removeAttribute('data-running'); cancelAnimationFrame(raf); raf = 0; mode = 'idle'; cur = rest(G); paint(cur); setState('idle'); el.dispatchEvent(new CustomEvent('ensemble:morph-idle', { bubbles: true })); const r = done; done = null; r && r(); };
    const tick = (now) => {
      const st = styleOf(el), tl = T[st] || T.expressive;
      if (mode === 'settle') {
        const k = clamp((now - settleT0) / (tl.settle * 1000), 0, 1), e = ease[tl.settleEase](k);
        cur = mix(settleFrom, rest(G), e); paint(cur);
        if (k >= 1) return finish();
      } else {
        const loopMode = mode === 'once' ? 'once' : N > 32 ? 'loopLarge' : 'loop';
        const D = tl[loopMode] || tl.loop, t = (now - t0) / 1000;
        if (mode === 'once' && t >= D) return finish();
        cur = frame(st, loopMode, t, G); paint(cur);
      }
      raf = requestAnimationFrame(tick);
    };
    const run = (m) => { el.setAttribute('data-running', ''); mode = m; t0 = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    const api = {
      get state() { return mode; },
      once() { clearTimeout(delayTimer); if (reducedNow(el)) { finish(); return Promise.resolve(); } setState('once'); run('once'); return new Promise((r) => (done = r)); },
      loop(o = {}) {
        clearTimeout(delayTimer); setState('loop');
        if (reducedNow(el)) { mode = 'loop'; cur = rest(G); paint(cur); return api; }
        const delay = o.delay != null ? o.delay : +(el.dataset.delay || 0);
        if (delay > 0 && mode === 'idle') { mode = 'pending'; delayTimer = setTimeout(() => mode === 'pending' && run('loop'), delay); } else if (mode !== 'loop') run('loop');
        return api;
      },
      settle() {
        clearTimeout(delayTimer);
        if (mode === 'idle' || mode === 'pending' || reducedNow(el) || !raf) { finish(); return Promise.resolve(); }
        if (mode === 'settle') return new Promise((r) => { const p = done; done = () => { p && p(); r(); }; });
        setState('settle'); settleFrom = cur; settleT0 = performance.now(); mode = 'settle';
        return new Promise((r) => { const p = done; done = () => { p && p(); r(); }; });
      },
      idle() { clearTimeout(delayTimer); finish(); },
      destroy() { clearTimeout(delayTimer); cancelAnimationFrame(raf); mo && mo.disconnect(); delete el.__morph; },
      frame: (m, t) => frame(styleOf(el), m, t, G),
      seek(m, t) { cancelAnimationFrame(raf); raf = 0; mode = 'idle'; el.setAttribute('data-running', ''); cur = t <= 0 ? rest(G) : frame(styleOf(el), m, t, G); paint(cur); },  // tests / stills
      seekSettle(m, t, k) { const tl = T[styleOf(el)] || T.expressive; cancelAnimationFrame(raf); raf = 0; mode = 'idle'; el.setAttribute('data-running', ''); cur = mix(frame(styleOf(el), m, t, G), rest(G), ease[tl.settleEase](clamp(k, 0, 1))); paint(cur); },
    };
    const apply = (records) => { const s = el.dataset.state || 'idle'; if (records && s === written) return; written = s; if (s === 'once') api.once(); else if (s === 'loop') api.loop(); else if (s === 'settle') api.settle(); else if (s === 'idle' && mode !== 'idle') api.idle(); };
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(apply) : null;
    mo && mo.observe(el, { attributes: true, attributeFilter: ['data-state'] });
    el.__morph = api; apply();
    return api;
  }
  function autoMount(scope) { return [...(scope || document).querySelectorAll('[data-motion-slot="brand.morph"]')].map((el) => mount(el)); }

  /* native export: sampled frames in unit coordinates (0..1 of the box). One morph for every style. */
  function exportKeyframes(fps = 30, sizes = [20, 96]) {
    const out = { about: 'brand.morph keyframes (round 5b: one evenly paced morph for every style). Points are strand centrelines in unit box coordinates (multiply by the icon size); wo/wi are stroke widths in px at that size. "loop*" is ONE steady period at constant path speed that starts and ends on the mark: play it on repeat. On the very first loop, apply the start ramp (velocity rises linearly from 0 over timing.ramp s, i.e. play the first ramp seconds at half the average rate) or simply start it after the 180 ms delay. "once" already contains its gentle ramp in and out. Settle: per-point lerp from the current frame to the mark (frame 0) over timing.settle s with easeOutCubic. Draw strands as round-joined polylines, butt caps below 32 px.',
      fps, timing: BASE, styles: 'expressive, minimal-quiet and minimal-dot all use these frames', delay_ms: 180, sizes: {} };
    for (const N of sizes) {
      const G = geom(N), lm = N > 32 ? 'loopLarge' : 'loop', q = (P) => P.filter((_, k) => k % 2 === 0 || k === P.length - 1).map((p) => [+(p[0] / N).toFixed(4), +(p[1] / N).toFixed(4)]);
      const pack = (f, t) => ({ t: +t.toFixed(3), o: q(f.o), i: q(f.i), wo: +f.wo.toFixed(2), wi: +f.wi.toFixed(2) });
      const once = [], loop = [], Do = BASE.once, Dl = BASE[lm];
      for (let j = 0; j <= Math.round(Do * fps); j++) once.push(pack(frame('expressive', 'once', Math.min(Do, j / fps), G), j / fps));
      const tab = table(lm, G);
      for (let j = 0; j <= Math.round(Dl * fps); j++) { const s = Math.min(1, j / (Dl * fps)), f = rawShape(lm, s >= 1 ? 1 : uAt(tab, s), G); loop.push(pack(f, j / fps)); }
      out.sizes[N] = { cap: G.cap, rest: pack(rest(G), 0), once: { duration: Do, frames: once }, [lm]: { duration: Dl, frames: loop } };
    }
    out.hinted = HINT;
    return out;
  }
  return { mount, autoMount, staticSVG, frame, geom, exportKeyframes, TIMING: T, BASE };
});
