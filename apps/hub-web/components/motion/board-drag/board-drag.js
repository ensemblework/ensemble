/* board.drag · Ensemble motion slot (round 6). Vanilla JS, no dependencies. UMD → window.EnsembleBoardDrag / module.exports.
 *
 * The Board's drag and drop, where the three motion styles really differ. Builds on round 2's "09 Board handoff".
 *   States (root data-state): idle · hover · pressed · pickup · dragging · over · reorder · drop · invalid · cancel · agent · done · keyboard
 *   Style: nearest [data-motion-theme] (expressive | minimal-quiet | minimal-dot), read at every pickup.
 *   Reduced motion: [data-reduce-motion="true"] on an ancestor, or the OS setting → instant moves with a ≤150 ms crossfade.
 *
 * Rules this file keeps:
 *   - Only transform and opacity are animated. The dragged card is a fixed-position overlay (like dnd-kit's DragOverlay)
 *     moved with translate3d inside the pointer event itself: zero added latency, it is never eased toward the pointer.
 *     Only the inner tilt/scale/shadow layer is animated (springs on rAF).
 *   - Everything that shifts in a list is FLIPped (measure → move DOM → invert → play), and interrupted FLIPs start from
 *     where the card is on screen, so nothing jumps.
 *   - Touch: long-press (380 ms, cancelled by > 9 px of movement) so page/column scrolling still works. Cards are
 *     touch-action: pan-y until lifted; while lifted, touchmove is prevented. Auto-scroll near list/board edges.
 *   - Haptics: every lift / drop / cancel / invalid dispatches CustomEvent('ensemble:haptic', {detail:{kind}}) on window,
 *     calls window.__ensembleHaptic?.(kind), and falls back to navigator.vibrate (if present and not reduced motion).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnsembleBoardDrag = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const raf = (f) => requestAnimationFrame(f);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const CALM = 'cubic-bezier(.33,0,.2,1)';

  /* ---------- style settings (the single source; also exported to board-drag.motion.json) ---------- */
  const STYLES = {
    expressive: {
      tilt: { cap: 6, perPxS: 0.012, k: 320, c: 19 },          // ° per px/s of pointer velocity, hard cap 6°
      lift: { scale: 1.035, opacity: 1, k: 420, c: 24 },       // pickup spring (one small overshoot)
      shadow: 1, tether: true, placeholder: 'stitch',
      flip: { spring: [300, 26] }, drop: { spring: [260, 22] }, cancel: { spring: [240, 18] },
      glide: { spring: [150, 21] }, agent: 'crane', done: 'hop', owner: 'spin', countPop: true, sparks: true, land: true,
    },
    'minimal-quiet': {
      tilt: { cap: 1.5, perPxS: 0.003, k: 120, c: 22 },        // critically damped: no wobble
      lift: { scale: 1.01, opacity: 1, k: 200, c: 28.3 },
      shadow: 0.6, tether: false, placeholder: 'hairline',
      flip: { ms: 300, ease: CALM }, drop: { ms: 280, ease: CALM }, cancel: { ms: 360, ease: CALM },
      glide: { ms: 640, ease: CALM }, agent: 'glide', done: 'glide', owner: 'fade', countPop: false, sparks: false, land: false,
    },
    'minimal-dot': {
      tilt: { cap: 0, perPxS: 0, k: 120, c: 22 },              // no tilt at all
      lift: { scale: 1.01, opacity: 0.92, k: 200, c: 28.3 },
      shadow: 0.4, tether: false, placeholder: 'dot',
      flip: { ms: 280, ease: CALM }, drop: { ms: 260, ease: CALM }, cancel: { ms: 340, ease: CALM },
      glide: { ms: 720, ease: CALM }, agent: 'dot', done: 'dot', owner: 'fade', countPop: false, sparks: false, land: false,
    },
  };
  const TOUCH = { delay: 380, tolerance: 9 };   // long-press to lift; moving more than this first means "scroll"
  const MOUSE = { distance: 6 };                // same as the app's PointerSensor activationConstraint
  const AUTOSCROLL = { edge: 56, maxSpeed: 900 }; // px from an edge, px/s at the very edge
  const REDUCED_FADE = 150;

  /* ---------- springs ---------- */
  class Spring {
    constructor(x, k, c) { this.x = x; this.t = x; this.v = 0; this.k = k; this.c = c; }
    step(dt) { const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n; for (let i = 0; i < n; i++) { const a = this.k * (this.t - this.x) - this.c * this.v; this.v += a * h; this.x += this.v * h; } }
    snap(v) { this.x = this.t = v; this.v = 0; }
    get done() { return Math.abs(this.t - this.x) < 1e-3 && Math.abs(this.v) < 1e-2; }
  }
  const springCache = new Map();
  /** Unit step response of a spring as a CSS/WAAPI linear() easing + its settle duration. */
  const hasLinear = typeof CSS === 'undefined' || !CSS.supports || CSS.supports('transition-timing-function', 'linear(0, 1)');
  function springEasing(k, c) {
    const key = k + '/' + c; if (springCache.has(key)) return springCache.get(key);
    if (!hasLinear) {   // Safari < 17.2, Firefox < 112: a close cubic-bezier (overshoot only if the spring is underdamped)
      const z = c / (2 * Math.sqrt(k)), out = { easing: z < 0.8 ? 'cubic-bezier(.34,1.3,.64,1)' : 'cubic-bezier(.22,1,.36,1)', duration: Math.round(1000 * Math.min(1.2, 4.6 / (z * Math.sqrt(k)))) };
      springCache.set(key, out); return out;
    }
    let x = 0, v = 0, t = 0; const h = 1 / 600, pts = [];
    for (let i = 1; i <= 3000; i++) { const a = k * (1 - x) - c * v; v += a * h; x += v * h; t += h; if (i % 10 === 0) pts.push(+x.toFixed(4)); if (t > 0.1 && Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02) break; }
    pts.push(1);
    const out = { easing: 'linear(0, ' + pts.join(', ') + ')', duration: Math.round(t * 1000) };
    springCache.set(key, out); return out;
  }
  function timing(spec, reduced) {
    if (reduced) return { duration: 0, easing: 'linear' };
    return spec.spring ? springEasing(spec.spring[0], spec.spring[1]) : { duration: spec.ms, easing: spec.ease };
  }

  /* ---------- Lift: tilt + scale + shadow on the overlay's inner layer (shared with the dnd-kit adapter) ---------- */
  class Lift {
    constructor(tiltEl, shadowEl, S, reduced) {
      this.el = tiltEl; this.sh = shadowEl; this.S = S; this.R = reduced;
      const T = S.tilt, L = S.lift;
      this.r = new Spring(0, T.k, T.c); this.s = new Spring(1, L.k, L.c); this.a = new Spring(0, L.k, L.c); this.o = new Spring(1, L.k, L.c);
      this.vx = 0; this.velAt = 0; this.id = 0; this.prev = 0; this.released = false; this.waiters = []; this.maxTilt = 0;
      this.tick = this.tick.bind(this);
    }
    pickup() {
      const L = this.S.lift;
      this.s.t = L.scale; this.a.t = this.S.shadow; this.o.t = L.opacity; this.released = false;
      if (this.R) { this.s.snap(1); this.a.snap(this.S.shadow); this.o.snap(L.opacity); this.apply(); return; }
      this.run();
    }
    /** Feed horizontal velocity (px/s). The tilt follows it; when samples stop it decays back to upright. */
    vel(vx) { this.vx = vx; this.velAt = performance.now(); if (!this.R) this.run(); }
    release() {
      this.s.t = 1; this.a.t = 0; this.o.t = 1; this.vx = 0; this.released = true;
      if (this.R) { this.r.snap(0); this.s.snap(1); this.a.snap(0); this.o.snap(1); this.apply(); return Promise.resolve(); }
      this.run(); return new Promise((r) => this.waiters.push(r));
    }
    run() { if (!this.id) { this.prev = performance.now(); this.id = raf(this.tick); } }
    tick(now) {
      const dt = Math.min(0.05, Math.max(0, (now - this.prev) / 1000)); this.prev = now;
      if (now - this.velAt > 48) this.vx *= Math.exp(-dt * 14);
      const T = this.S.tilt; this.r.t = T.cap ? clamp(this.vx * T.perPxS, -T.cap, T.cap) : 0;
      this.r.step(dt); this.s.step(dt); this.a.step(dt); this.o.step(dt); this.apply();
      const still = this.r.done && this.s.done && this.a.done && this.o.done && Math.abs(this.vx) < 1;
      if (still && this.released) { this.id = 0; this.waiters.splice(0).forEach((f) => f()); return; }
      if (still) { this.id = 0; return; }
      this.id = raf(this.tick);
    }
    apply() {
      const cap = this.S.tilt.cap, r = cap ? clamp(this.r.x, -cap, cap) : 0;
      this.maxTilt = Math.max(this.maxTilt, Math.abs(r));
      // Individual properties, so this lift cannot replace a transform that centers something else.
      this.el.style.rotate = `${r.toFixed(3)}deg`;
      this.el.style.scale = this.s.x.toFixed(4);
      this.el.style.opacity = clamp(this.o.x, 0, 1).toFixed(3);
      if (this.sh) this.sh.style.opacity = clamp(this.a.x, 0, 1).toFixed(3);
    }
    stop() { cancelAnimationFrame(this.id); this.id = 0; this.waiters.splice(0).forEach((f) => f()); }
  }

  /* ---------- environment ---------- */
  const themeOf = (el) => { const t = el.closest('[data-motion-theme]'); const v = t && t.getAttribute('data-motion-theme'); return STYLES[v] ? v : 'expressive'; };
  const reducedOf = (el) => !!el.closest('[data-reduce-motion="true"]') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  function haptic(kind, el) {
    const reduced = el ? reducedOf(el) : false;
    try { window.dispatchEvent(new CustomEvent('ensemble:haptic', { detail: { kind, reduced } })); } catch (e) { /* old browsers */ }
    let handled = false;
    try { if (typeof window.__ensembleHaptic === 'function') { window.__ensembleHaptic(kind); handled = true; } } catch (e) { /* native bridge threw */ }
    if (!handled && !reduced && navigator.vibrate && hapticPatterns[kind]) { try { navigator.vibrate(hapticPatterns[kind]); } catch (e) { /* not allowed */ } }
  }
  const hapticPatterns = { lift: 8, drop: 12, cancel: [6, 40, 6], invalid: [6, 40, 6] };

  /* ---------- FLIP ---------- */
  /** Measure every child of the lists, run mutate(), then play each child from where it was on screen. */
  function flip(lists, mutate, { T, reduced, skip }) {
    const els = []; for (const l of lists) for (const c of l.children) els.push(c);
    const first = new Map(); for (const e of els) first.set(e, e.getBoundingClientRect());
    for (const e of els) if (e._bdgFlip) { e._bdgFlip.cancel(); e._bdgFlip = null; }
    mutate();
    for (const e of els) {
      const a = first.get(e), b = e.getBoundingClientRect(); e._bdgLast = b;
      if (skip && skip(e, a, b)) continue;
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (reduced) { e._bdgFlip = e.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: REDUCED_FADE }); continue; }
      const anim = e.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: T.duration, easing: T.easing });
      e._bdgFlip = anim; anim.onfinish = () => { if (e._bdgFlip === anim) e._bdgFlip = null; };
    }
  }

  /** Hide the source card while a float stands in for it.
   *  `data-bdg-fly` is not a React prop, so a re-render of the card does not strip it
   *  (React does own `data-bdg-ph`, which is the dnd-kit drag placeholder). */
  function setPh(el, on) {
    el.classList.toggle('is-ph', !!on);
    if (on) el.setAttribute('data-bdg-fly', '');
    else el.removeAttribute('data-bdg-fly');
  }

  /* ---------- the board ---------- */
  function mount(root, options) {
    const o = Object.assign({
      card: '.bdg-card', column: '.bdg-col', list: '.bdg-list', footer: '.bdg-foot', count: '.bdg-n',
      accepts: () => true,          // (cardEl, columnEl) → boolean
      onDrop: null,                 // (detail) → void | false | Promise (false / rejection = server said no → card returns)
      title: (card) => (card.querySelector('.bdg-t') || card).textContent.trim(),
      columnName: (col) => col.getAttribute('aria-label') || col.dataset.col,
      scroller: null,               // horizontal board scroller, for auto-scroll (defaults to root if it overflows)
      touch: TOUCH, mouse: MOUSE,
      input: true,                  // false: another library (dnd-kit) owns pointer/keyboard; use play() / agentMove() only
    }, options || {});
    root.setAttribute('data-motion-slot', 'board.drag');
    const layer = document.createElement('div'); layer.className = 'bdg-layer'; layer.setAttribute('aria-hidden', 'true'); root.appendChild(layer);
    let live = root.querySelector('.bdg-live');
    if (!live) { live = document.createElement('div'); live.className = 'bdg-live bdg-sr'; live.setAttribute('aria-live', 'assertive'); live.setAttribute('role', 'status'); root.appendChild(live); }
    let help = root.querySelector('#bdg-help');
    if (!help) { help = document.createElement('p'); help.id = 'bdg-help-' + Math.random().toString(36).slice(2, 7); help.className = 'bdg-sr'; help.textContent = 'Press Space to pick up. Use the arrow keys to move, Space to drop, Escape to cancel.'; root.appendChild(help); }

    const cols = () => [...root.querySelectorAll(o.column)];
    const listOf = (col) => col.querySelector(o.list);
    const colOf = (el) => el.closest(o.column);
    const cardsIn = (list) => [...list.children].filter((c) => c.matches(o.card));
    const indexIn = (list, card) => cardsIn(list).indexOf(card);
    const byId = (id) => root.querySelector(`${o.card}[data-id="${CSS.escape(id)}"]`);
    const prepare = () => cardsIn2().forEach((c) => {
      if (!c.hasAttribute('tabindex')) c.tabIndex = 0;
      c.setAttribute('role', 'button'); c.setAttribute('aria-roledescription', 'draggable card'); c.setAttribute('aria-describedby', help.id);
    });
    const cardsIn2 = () => cols().flatMap((c) => cardsIn(listOf(c)));
    // dnd-kit already sets role, tabindex and the described-by text. prepare() would clobber them.
    if (o.input) prepare();

    let state = 'idle', drag = null, pending = null, busy = false, suppressClick = false, loopId = 0;
    const setState = (s) => { if (state !== s) { state = s; root.setAttribute('data-state', s); root.dispatchEvent(new CustomEvent('board:state', { detail: { state: s } })); } };
    setState('idle');
    const announce = (msg) => { live.textContent = ''; live.textContent = msg; root.dispatchEvent(new CustomEvent('board:announce', { detail: { message: msg } })); };
    const posText = (list, card) => { const n = cardsIn(list).length; return `position ${indexIn(list, card) + 1} of ${n} in ${o.columnName(colOf(list))}`; };
    const counts = (pop) => cols().forEach((col) => {
      const n = col.querySelector(o.count); if (!n) return; const v = String(cardsIn(listOf(col)).length);
      if (n.textContent !== v) { n.textContent = v; if (pop && drag && drag.S.countPop && !drag.R) n.animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], springEasing(260, 14)); }
    });
    const setOver = (col, kind) => { for (const c of cols()) { if (c === col) c.setAttribute('data-over', kind); else c.removeAttribute('data-over'); } };

    /* --- overlay --- */
    function makeFloat(card, rect, origin, S, R) {
      const float = document.createElement('div'); float.className = 'bdg-float';
      float.style.width = rect.width + 'px'; float.style.height = rect.height + 'px';
      float.innerHTML = '<div class="bdg-float-tilt"><div class="bdg-float-shadow"></div></div>';
      const tilt = float.firstChild, clone = card.cloneNode(true);
      clone.classList.add('is-float'); clone.classList.remove('is-ph'); clone.removeAttribute('data-bdg-fly'); clone.removeAttribute('data-bdg-ph'); clone.removeAttribute('tabindex'); clone.removeAttribute('id'); clone.removeAttribute('data-press');
      tilt.appendChild(clone); tilt.style.transformOrigin = `${origin[0]}px ${origin[1]}px`;
      float.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
      layer.appendChild(float);
      const lift = new Lift(tilt, tilt.firstChild, S, R);
      return { float, tilt, clone, lift };
    }
    const placeIn = (list, card, idx) => { const items = cardsIn(list).filter((c) => c !== card); list.insertBefore(card, items[idx] || list.querySelector(o.footer) || null); };

    function measure() {
      const d = drag; if (!d) return;
      d.cols = cols().map((el) => {
        const list = listOf(el), lr = list.getBoundingClientRect(), cs = getComputedStyle(list);
        return { el, list, r: el.getBoundingClientRect(), lr, padTop: parseFloat(cs.paddingTop) || 0, gap: parseFloat(cs.rowGap) || 0 };
      });
      d.heights = new Map(cardsIn2().map((c) => [c, c.offsetHeight]));
    }
    function targetIndex(col, cy) {
      const d = drag;
      if (col.list === d.list) {
        // same list: compare with where the neighbours really are (placeholder included) → a card only swaps
        // once its centre passes a neighbour's centre, so it never flickers back and forth
        let i = 0; const top = col.lr.top - col.list.scrollTop + col.list.clientTop;
        for (const el of cardsIn(col.list)) { if (el === d.card) continue; if (top + el.offsetTop + el.offsetHeight / 2 < cy) i++; }
        return i;
      }
      let y = col.lr.top + col.padTop - col.list.scrollTop, i = 0;
      for (const el of cardsIn(col.list)) { if (el === d.card) continue; const h = d.heights.get(el) || el.offsetHeight; if (cy < y + h / 2) return i; y += h + col.gap; i++; }
      return i;
    }
    function reorder(list, idx, quiet) {
      const d = drag; const changed = list !== d.list;
      flip(new Set([d.list, list]), () => placeIn(list, d.card, idx), {
        T: timing(d.S.flip, d.R), reduced: d.R,
        skip: (e) => { if (e === d.card && changed) { phIn(e); return true; } return false; },
      });
      d.list = list; d.index = indexIn(list, d.card); counts(true);
      if (!quiet && d.mode === 'keyboard') announce(`${d.title}, ${posText(list, d.card)}.`);
      else if (!quiet && changed && d.mode === 'pointer') announce(`${d.title} is over ${o.columnName(colOf(list))}, ${posText(list, d.card)}.`);
    }
    function phIn(el, reduced) {
      if (reduced === undefined ? drag && drag.R : reduced) return;
      try { el.animate([{ opacity: 0, transform: 'scaleY(.6)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: CALM, pseudoElement: '::before' }); } catch (e) { /* no pseudo support */ }
    }

    /* --- begin / end --- */
    /** The card's layout box: no FLIP, hover lift or press scale in it. */
    function restRect(card) {
      if (card._bdgFlip) { card._bdgFlip.cancel(); card._bdgFlip = null; }
      card.removeAttribute('data-press');
      const t = card.style.transition, f = card.style.transform; card.style.transition = 'none'; card.style.transform = 'none';
      const r = card.getBoundingClientRect(); card.style.transform = f; void card.offsetWidth; card.style.transition = t;
      return r;
    }
    function begin(card, cfg) {
      const S = STYLES[themeOf(root)], R = reducedOf(root);
      const rect = cfg.rect || restRect(card);
      const f = makeFloat(card, rect, cfg.origin || [cfg.grabX, cfg.grabY], S, R);
      setPh(card, true); phIn(card, R);
      const list = card.parentElement;
      drag = Object.assign({ S, R, card, title: o.title(card), w: rect.width, h: rect.height, x: rect.left, y: rect.top, vx: 0, lastT: 0,
        originList: list, originIndex: indexIn(list, card), list, index: indexIn(list, card), intent: 'drop', px: 0, py: 0 }, f, cfg);
      root.setAttribute('data-dragging', cfg.mode); document.documentElement.classList.toggle('bdg-grabbing', cfg.mode === 'pointer');
      measure(); drag.lift.pickup();
      if (S.tether && !R && cfg.mode !== 'agent') makeTether();
      startLoop();
      return drag;
    }
    function end() {
      const d = drag; if (!d) return;
      d.float.remove(); d.lift.stop(); if (d.beads) d.beads.forEach((b) => b.remove());
      setPh(d.card, false); d.card.classList.remove('is-landing');
      setOver(null); root.removeAttribute('data-dragging'); document.documentElement.classList.remove('bdg-grabbing');
      drag = null; stopLoop(); setState('idle');
    }
    const layoutRect = (el) => { if (el._bdgFlip) { el._bdgFlip.cancel(); el._bdgFlip = null; } return el.getBoundingClientRect(); };
    /** Fly the overlay onto the placeholder, release the lift, swap. */
    async function settle(T, kind) {
      const d = drag; d.settling = true;
      const r = layoutRect(d.card); d.card.classList.add('is-landing');
      if (d.flyAnim) d.flyAnim.cancel();
      const cur = d.float.getBoundingClientRect();
      const from = `translate3d(${cur.left}px, ${cur.top}px, 0)`, to = `translate3d(${r.left}px, ${r.top}px, 0)`;
      if (d.R) {
        d.float.style.transform = to; d.lift.release();
        setPh(d.card, false); d.card.classList.remove('is-landing'); d.card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE });
        await d.float.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REDUCED_FADE, fill: 'forwards' }).finished;
      } else {
        if (kind === 'invalid' && d.S.land) d.clone.animate([{ transform: 'none' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
        const a = d.float.animate([{ transform: from }, { transform: to }], { duration: T.duration, easing: T.easing, fill: 'forwards' });
        await Promise.all([a.finished, d.lift.release()]);
        d.float.style.transform = to;
      }
      const card = d.card; end();
      if (!d.R && d.S.land && kind === 'drop') card.animate([{ transform: 'scale(1.012, .975)' }, { transform: 'none' }], springEasing(380, 16));
      return card;
    }

    function ownerMorph(card, owner, S, R) {
      const own = card.querySelector('.bdg-own'); if (!own || own.dataset.owner === owner) return;
      own.dataset.owner = owner; own.textContent = owner === 'you' ? (own.dataset.initial || 'S') : '';
      own.setAttribute('aria-label', owner === 'ag' ? 'Owner: Ensemble' : owner === 'ok' ? 'Done' : 'Owner: you');
      card.classList.toggle('is-done', owner === 'ok');
      if (R) own.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE });
      else if (S.owner === 'spin') own.animate([{ transform: 'scale(.2) rotate(-180deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], springEasing(260, 14));
      else own.animate([{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: CALM });
    }
    const ownerFor = (card, col) => col.dataset.owner || null;

    /* --- the per-frame loop: tether, auto-scroll --- */
    function startLoop() { if (loopId) return; let prev = performance.now(); const f = (now) => { const dt = Math.min(0.05, (now - prev) / 1000); prev = now; if (!drag) { loopId = 0; return; } frame(dt); loopId = raf(f); }; loopId = raf(f); }
    function stopLoop() { cancelAnimationFrame(loopId); loopId = 0; }
    function makeTether() { const d = drag; d.beads = []; for (let i = 0; i < 12; i++) { const b = document.createElement('i'); b.className = 'bdg-bead'; layer.insertBefore(b, d.float); d.beads.push(b); } }
    function frame(dt) {
      const d = drag;
      if (d.beads) {
        const a = d.card.getBoundingClientRect(), fr = d.mode === 'pointer' && !d.settling ? { left: d.x, top: d.y } : d.float.getBoundingClientRect();
        const ax = a.left + a.width / 2, ay = a.top + a.height / 2, bx = fr.left + d.w / 2, by = fr.top + d.h / 2;
        const dist = Math.hypot(bx - ax, by - ay), show = d.settling ? 0 : clamp((dist - 24) / 60, 0, 1);
        const cx = (ax + bx) / 2, cy = (ay + by) / 2 + 22 + dist * 0.16;
        d.beads.forEach((b, i) => {
          const t = i / (d.beads.length - 1), u = 1 - t;
          const x = u * u * ax + 2 * u * t * cx + t * t * bx, y = u * u * ay + 2 * u * t * cy + t * t * by;
          b.style.transform = `translate3d(${(x - 2).toFixed(1)}px, ${(y - 2).toFixed(1)}px, 0)`;
          b.style.opacity = (show * (0.35 + 0.55 * Math.sin(Math.PI * t))).toFixed(3);
        });
      }
      if (d.mode === 'pointer' && !d.settling) autoScroll(dt);
    }
    function autoScroll(dt) {
      const d = drag, E = AUTOSCROLL.edge, V = AUTOSCROLL.maxSpeed; let moved = false;
      const push = (el, axis, lo, hi, p) => {
        const max = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth; if (max <= 0) return;
        let s = 0; if (p < lo + E) s = -((lo + E - p) / E); else if (p > hi - E) s = (p - (hi - E)) / E;
        s = clamp(s, -1, 1); if (!s) return;
        const before = axis === 'y' ? el.scrollTop : el.scrollLeft, delta = s * s * Math.sign(s) * V * dt;
        if (axis === 'y') el.scrollTop = clamp(before + delta, 0, max); else el.scrollLeft = clamp(before + delta, 0, max);
        if ((axis === 'y' ? el.scrollTop : el.scrollLeft) !== before) moved = true;
      };
      const col = d.cols && d.cols.find((c) => d.px >= c.r.left && d.px <= c.r.right);
      if (col && d.py >= col.lr.top - E && d.py <= col.lr.bottom + E) push(col.list, 'y', col.lr.top, col.lr.bottom, d.py);
      const sc = o.scroller || root; const sr = sc.getBoundingClientRect(); push(sc, 'x', sr.left, sr.right, d.px);
      if (moved) { measure(); hitTest(d.px, d.py); }
    }

    /* --- pointer --- */
    function hitTest(px, py) {
      const d = drag; let col = null;
      for (const c of d.cols) if (px >= c.r.left && px <= c.r.right && py >= c.r.top && py <= c.r.bottom) col = c;
      const intent = !col ? 'cancel' : o.accepts(d.card, col.el) ? 'drop' : 'deny';
      if (intent !== d.intent) { d.intent = intent; d.float.setAttribute('data-intent', intent); if (intent === 'deny') announce(`${o.columnName(col.el)} doesn't take ${d.title}.`); }
      if (!col) { setOver(null); setState('dragging'); return; }
      if (intent === 'deny') { setOver(col.el, 'deny'); if (d.list !== d.originList || d.index !== d.originIndex) reorder(d.originList, d.originIndex, true); setState('invalid'); return; }
      setOver(col.el, 'yes');
      const idx = targetIndex(col, d.y + d.h / 2);
      if (col.list !== d.list || idx !== d.index) reorder(col.list, idx);
      setState(col.list !== d.originList ? 'over' : d.index !== d.originIndex ? 'reorder' : 'dragging');
    }
    function moveTo(px, py, t) {
      const d = drag, x = px - d.grabX, y = py - d.grabY;
      if (d.lastT) { const dt = (t - d.lastT) / 1000; if (dt > 0.001) d.vx = lerp(d.vx, (x - d.x) / dt, clamp(dt * 22, 0, 1)); }
      d.lastT = t; d.x = x; d.y = y; d.px = px; d.py = py;
      d.float.style.transform = `translate3d(${x}px, ${y}px, 0)`;   // the card stays exactly under the pointer
      d.lift.vel(d.vx);
      hitTest(px, py);
    }
    const onDown = (e) => {
      if (drag || busy || pending) return;
      const card = e.target.closest && e.target.closest(o.card); if (!card || !root.contains(card) || card.closest('.bdg-layer')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
      pending = { card, id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, last: e, timer: 0 };
      card.setAttribute('data-press', ''); setState('pressed');
      if (e.pointerType === 'touch' || e.pointerType === 'pen') pending.timer = setTimeout(() => { if (pending && pending.card === card) activate(pending.last); }, o.touch.delay);
      else { try { card.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } }
    };
    const abortPending = () => { if (!pending) return; clearTimeout(pending.timer); pending.card.removeAttribute('data-press'); pending = null; setState('idle'); };
    function activate(e) {
      const p = pending; pending = null; clearTimeout(p.timer);
      const r = restRect(p.card);
      begin(p.card, { mode: 'pointer', pointerId: p.id, pointerType: p.type, grabX: p.x0 - r.left, grabY: p.y0 - r.top, rect: r });
      setState('pickup'); haptic('lift', root);
      announce(`Picked up ${drag.title}, ${posText(drag.list, drag.card)}.`);
      moveTo(e.clientX, e.clientY, e.timeStamp);
    }
    const onMove = (e) => {
      if (pending && e.pointerId === pending.id) {
        pending.last = e; const dist = Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0);
        if (pending.type === 'mouse') { if (dist >= o.mouse.distance) activate(e); }
        else if (dist > o.touch.tolerance) abortPending();   // the finger is scrolling: let it
        return;
      }
      if (drag && drag.mode === 'pointer' && e.pointerId === drag.pointerId && !drag.settling) moveTo(e.clientX, e.clientY, e.timeStamp);
      else if (!drag && !pending && e.pointerType === 'mouse') { const over = e.target.closest && e.target.closest(o.card); setState(over && root.contains(over) ? 'hover' : 'idle'); }
    };
    const onUp = (e) => {
      if (pending && e.pointerId === pending.id) { abortPending(); return; }
      if (drag && drag.mode === 'pointer' && e.pointerId === drag.pointerId && !drag.settling) { suppressClick = true; setTimeout(() => (suppressClick = false), 0); finish(); }
    };
    const onCancel = (e) => {
      if (pending && e.pointerId === pending.id) { abortPending(); return; }
      if (drag && drag.mode === 'pointer' && e.pointerId === drag.pointerId && !drag.settling) cancel('cancel');
    };
    const onTouchMove = (e) => { if (drag && drag.mode === 'pointer') e.preventDefault(); };   // lifted: the finger moves the card, not the page
    const onContext = (e) => { if (pending || drag) e.preventDefault(); };
    const onClick = (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; } };
    const onScroll = () => { if (drag) { measure(); if (drag.mode === 'pointer' && !drag.settling) hitTest(drag.px, drag.py); } };

    /* --- drop / cancel --- */
    async function finish() {
      const d = drag; if (!d || d.settling) return;
      if (d.intent !== 'drop') return cancel(d.intent === 'deny' ? 'invalid' : 'cancel');
      const from = colOf(d.originList), to = colOf(d.list), idx = indexIn(d.list, d.card), items = cardsIn(d.list);
      const detail = { id: d.card.dataset.id, from: from.dataset.col, to: to.dataset.col, index: idx, beforeId: items[idx - 1] ? items[idx - 1].dataset.id : null, afterId: items[idx + 1] ? items[idx + 1].dataset.id : null, changed: d.list !== d.originList || idx !== d.originIndex, via: d.mode };
      setState('drop'); haptic('drop', root);
      const S = d.S, R = d.R, title = d.title, owner = ownerFor(d.card, to);
      const result = o.onDrop ? o.onDrop(detail) : true;
      const card = await settle(timing(S.drop, R), 'drop');
      if (owner && detail.changed) ownerMorph(card, owner, S, R);
      announce(detail.changed ? `Dropped ${title}, ${posText(card.parentElement, card)}.` : `Dropped ${title} where it was.`);
      root.dispatchEvent(new CustomEvent('board:drop', { detail }));
      if (d.mode === 'keyboard') card.focus({ preventScroll: true });
      Promise.resolve(result).then((ok) => { if (ok === false) revert(card, d.originList, d.originIndex, title); }, () => revert(card, d.originList, d.originIndex, title));
    }
    async function cancel(kind) {
      const d = drag; if (!d || d.settling) return;
      setState(kind === 'invalid' ? 'invalid' : 'cancel'); haptic(kind === 'invalid' ? 'invalid' : 'cancel', root);
      if (d.list !== d.originList || d.index !== d.originIndex) reorder(d.originList, d.originIndex, true);
      const title = d.title, mode = d.mode;
      const card = await settle(timing(d.S.cancel, d.R), 'invalid');
      announce(`${kind === 'invalid' ? 'Not allowed there.' : 'Cancelled.'} ${title} is back at ${posText(card.parentElement, card)}.`);
      root.dispatchEvent(new CustomEvent('board:cancel', { detail: { id: card.dataset.id, kind } }));
      if (mode === 'keyboard') card.focus({ preventScroll: true });
    }
    /** The server rejected a drop: send the card home the way an agent move would (no drag in progress). */
    async function revert(card, list, index, title) {
      const col = colOf(list);
      await enqueue(() => moveCard(card, col, index, { kind: 'revert' }));
      announce(`Couldn't move ${title}. It's back at ${posText(list, card)}.`);
    }

    /* --- keyboard --- */
    const onKey = (e) => {
      const card = e.target.closest && e.target.closest(o.card);
      if (!drag) {
        if (card && root.contains(card) && !busy && (e.key === ' ' || e.key === 'Spacebar')) {
          e.preventDefault(); const r = restRect(card);
          begin(card, { mode: 'keyboard', grabX: r.width / 2, grabY: r.height / 2, rect: r }); setState('keyboard'); haptic('lift', root);
          announce(`Picked up ${drag.title}, ${posText(drag.list, drag.card)}. Arrow keys move it, Space drops it, Escape cancels.`);
        }
        return;
      }
      if (drag.mode === 'pointer') { if (e.key === 'Escape') { e.preventDefault(); cancel('cancel'); } return; }
      if (drag.mode !== 'keyboard' || drag.settling) return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); kbMove(0, k === 'ArrowUp' ? -1 : 1); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); kbMove(k === 'ArrowLeft' ? -1 : 1, 0); }
      else if (k === ' ' || k === 'Spacebar' || k === 'Enter') { e.preventDefault(); finish(); }
      else if (k === 'Escape') { e.preventDefault(); cancel('cancel'); }
      else if (k === 'Tab') e.preventDefault();
    };
    function kbMove(dc, di) {
      const d = drag, all = cols(), ci = all.indexOf(colOf(d.list));
      let list = d.list, idx = d.index;
      if (dc) {
        let nc = ci + dc; while (nc >= 0 && nc < all.length && !o.accepts(d.card, all[nc])) nc += dc;
        if (nc < 0 || nc >= all.length) { announce(`${d.title} can't go further ${dc < 0 ? 'left' : 'right'}.`); return; }
        list = listOf(all[nc]); idx = Math.min(d.index, cardsIn(list).length);
      } else {
        const n = cardsIn(list).length - 1; idx = d.index + di;
        if (idx < 0 || idx > n) { announce(`${d.title} is already ${idx < 0 ? 'at the top' : 'at the bottom'} of ${o.columnName(colOf(list))}.`); return; }
      }
      reorder(list, idx); setOver(colOf(list), 'yes');
      setState(list !== d.originList ? 'over' : 'reorder');
      const r = d.card._bdgLast || d.card.getBoundingClientRect(), cur = d.float.getBoundingClientRect();
      if (d.flyAnim) d.flyAnim.cancel();
      const T = timing(d.S.flip, d.R);
      d.lift.vel(((r.left - cur.left) / Math.max(0.12, T.duration / 1000)) * 0.6);
      d.flyAnim = d.float.animate([{ transform: `translate3d(${cur.left}px, ${cur.top}px, 0)` }, { transform: `translate3d(${r.left}px, ${r.top}px, 0)` }], { duration: T.duration, easing: T.easing, fill: 'forwards' });
      d.x = r.left; d.y = r.top;
      setTimeout(() => { if (drag === d) setState('keyboard'); }, T.duration);
    }

    /* --- agent and system moves --- */
    /** Move a card to a column without a user drag. kind: 'agent' (the agent picks it up) · 'done' (finished, hops to Done) · 'revert'. */
    let queue = Promise.resolve();
    const whenIdle = () => new Promise((res) => { const f = () => (drag || busy ? setTimeout(f, 50) : res()); f(); });
    /** Agent and system moves wait their turn: never while you're holding a card, never two at once. */
    function enqueue(job) { const run = queue.then(whenIdle).then(job); queue = run.catch(() => {}); return run; }
    async function moveCard(card, toCol, index, opts) {
      opts = opts || {}; const kind = opts.kind || 'agent';
      if (drag || busy) return false; busy = true;
      const S = STYLES[themeOf(root)], R = reducedOf(root), toList = listOf(toCol), fromList = card.parentElement;
      const title = o.title(card), owner = opts.owner || ownerFor(card, toCol);
      setState(kind === 'done' ? 'done' : 'agent');
      const T = timing(S.flip, R);
      if (R) {
        if (!opts.from) {
          await card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REDUCED_FADE, fill: 'forwards' }).finished;
          flip(new Set([fromList, toList]), () => placeIn(toList, card, index), { T, reduced: true, skip: (e) => e === card });
        }
        if (owner) ownerMorph(card, owner, S, true);
        card.getAnimations().forEach((a) => a.cancel());
        card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE });
        counts(false); busy = false; setState('idle');
        announceMove(kind, title, card); return true;
      }
      const domMoved = !!opts.from, r0 = opts.from || restRect(card), style = kind === 'done' ? S.done : kind === 'revert' ? 'glide' : S.agent;
      const origin = style === 'crane' ? [r0.width / 2, 0] : [r0.width / 2, r0.height / 2];
      let f = null;
      const hold = () => { f = makeFloat(card, r0, origin, S, R); if (style === 'glide' && kind !== 'revert') f.clone.classList.add('is-agent'); setPh(card, true); };
      if (domMoved) hold();   // React already moved it: show it where it was, hide the new spot, then play the move
      const fx = style === 'crane' ? await craneDown(r0) : style === 'dot' ? dotOn(r0) : null;
      if (fx && fx.hook) await wait(140);
      if (!f) hold();
      f.lift.pickup();
      await wait(style === 'crane' ? 200 : 140);
      if (!domMoved) flip(new Set([fromList, toList]), () => placeIn(toList, card, index), { T, reduced: false, skip: (e) => e === card });
      const r1 = layoutRect(card); counts(false);
      if (S.countPop) toCol.querySelectorAll(o.count).forEach((n) => n.animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], springEasing(260, 14)));
      if (style === 'crane' || style === 'hop') await flySpring(f, r0, r1, S, style === 'hop', fx);
      else if (style === 'dot') await dotGlide(f, r0, r1, S, fx);
      else await f.float.animate([{ transform: `translate3d(${r0.left}px, ${r0.top}px, 0)` }, { transform: `translate3d(${r1.left}px, ${r1.top}px, 0)` }], Object.assign(timing(S.glide, false), { fill: 'forwards' })).finished;
      f.float.style.transform = `translate3d(${r1.left}px, ${r1.top}px, 0)`;
      await f.lift.release();
      f.float.remove(); f.lift.stop(); setPh(card, false);
      if (S.land) card.animate([{ transform: 'scale(1.012, .975)' }, { transform: 'none' }], springEasing(380, 16));
      if (owner) ownerMorph(card, owner, S, false);
      if (fx && fx.done) fx.done(r1);
      if (kind === 'done' && S.sparks) sparks(card);
      busy = false; setState('idle'); announceMove(kind, title, card);
      return true;
    }
    const announceMove = (kind, title, card) => {
      if (kind === 'revert') return;
      announce(kind === 'done' ? `Ensemble finished ${title}. Moved to ${o.columnName(colOf(card))}.` : `Ensemble moved ${title} to ${posText(card.parentElement, card)}.`);
    };
    async function craneDown(r0) {
      const rope = document.createElement('i'), hook = document.createElement('i'); rope.className = 'bdg-rope'; hook.className = 'bdg-hook';
      layer.append(rope, hook);
      const x = r0.left + r0.width / 2, y = r0.top, L = rope.offsetHeight || 1600;
      const at = (bx, by, ang) => { rope.style.transform = `translate3d(${bx - 1}px, ${by - L}px, 0) rotate(${ang || 0}deg)`; hook.style.transform = `translate3d(${bx - 5}px, ${by - 5}px, 0)`; };
      await rope.animate([{ transform: `translate3d(${x - 1}px, ${-L - 20}px, 0)` }, { transform: `translate3d(${x - 1}px, ${y - L}px, 0)` }], { duration: 460, easing: 'cubic-bezier(.22,1,.36,1)' }).finished;
      at(x, y); hook.animate([{ transform: `translate3d(${x - 5}px, ${y - 5}px, 0) scale(0)` }, { transform: `translate3d(${x - 5}px, ${y - 5}px, 0) scale(1)` }], springEasing(420, 14));
      return { hook: true, at, rope, hookEl: hook, L,
        done: async (r1) => { const bx = r1.left + r1.width / 2, by = r1.top; hook.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
          await rope.animate([{ transform: `translate3d(${bx - 1}px, ${by - L}px, 0)` }, { transform: `translate3d(${bx - 1}px, ${-L - 30}px, 0)` }], { duration: 420, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished;
          rope.remove(); hook.remove(); } };
    }
    function flySpring(f, r0, r1, S, hop, fx) {
      return new Promise((resolve) => {
        const [gk, gc] = S.glide.spring || [150, 21], X = new Spring(r0.left, gk, gc), Y = new Spring(r0.top, gk, gc), A = new Spring(r0.left, gk * 0.47, gc * 0.62);
        X.t = r1.left; Y.t = r1.top; A.t = r1.left;
        const dist = Math.hypot(r1.left - r0.left, r1.top - r0.top), H = hop ? 36 + dist * 0.12 : 0, t0 = performance.now();
        let prev = t0;
        const step = (now) => {
          const dt = Math.min(0.05, (now - prev) / 1000); prev = now; X.step(dt); Y.step(dt); A.step(dt);
          const p = clamp(Math.hypot(X.x - r0.left, Y.x - r0.top) / Math.max(1, dist), 0, 1);
          const y = Y.x - H * 4 * p * (1 - p);
          f.float.style.transform = `translate3d(${X.x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`; f.lift.vel(X.v);
          if (fx && fx.at) { const bx = X.x + r0.width / 2, ax = A.x + r0.width / 2; fx.at(bx, y, clamp(Math.atan2(ax - bx, fx.L * 0.4) * -57.3, -12, 12)); }
          if (Math.abs(X.x - X.t) < 0.4 && Math.abs(Y.x - Y.t) < 0.4 && Math.abs(X.v) < 20 && Math.abs(Y.v) < 20 || now - t0 > 2000) { f.float.style.transform = `translate3d(${r1.left}px, ${r1.top}px, 0)`; resolve(); return; }
          raf(step);
        };
        raf(step);
      });
    }
    function dotOn(r0) {
      const dot = document.createElement('i'); dot.className = 'bdg-adot'; layer.appendChild(dot);
      const x = r0.left - 4, y = r0.top + r0.height / 2 - 4;
      dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      dot.animate([{ transform: `translate3d(${x}px, ${y}px, 0) scale(0)`, opacity: 0 }, { transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 1 }], { duration: 200, easing: CALM });
      return { dot, done: (r1) => { const x1 = r1.left - 4, y1 = r1.top + r1.height / 2 - 4; dot.animate([{ transform: `translate3d(${x1}px, ${y1}px, 0)`, opacity: 1 }, { transform: `translate3d(${x1}px, ${y1}px, 0) scale(.3)`, opacity: 0 }], { duration: 260, easing: CALM, fill: 'forwards' }).finished.then(() => dot.remove()); } };
    }
    async function dotGlide(f, r0, r1, S, fx) {
      const T = timing(S.glide, false), x0 = r0.left - 4, y0 = r0.top + r0.height / 2 - 4, x1 = r1.left - 4, y1 = r1.top + r1.height / 2 - 4;
      const a = fx.dot.animate([{ transform: `translate3d(${x0}px, ${y0}px, 0)` }, { transform: `translate3d(${x1}px, ${y1}px, 0)` }], { duration: T.duration, easing: T.easing, fill: 'forwards' });
      const b = f.float.animate([{ transform: `translate3d(${r0.left}px, ${r0.top}px, 0)` }, { transform: `translate3d(${r1.left}px, ${r1.top}px, 0)` }], { duration: T.duration, easing: T.easing, delay: 90, fill: 'forwards' });
      await Promise.all([a.finished, b.finished]);
    }
    function sparks(card) {
      const own = card.querySelector('.bdg-own') || card, r = own.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (let i = 0; i < 8; i++) {
        const s = document.createElement('i'); s.className = 'bdg-spark'; layer.appendChild(s);
        const a = (i / 8) * Math.PI * 2 + 0.3, d = 16 + (i % 3) * 5;
        s.animate([{ transform: `translate3d(${cx - 2}px, ${cy - 2}px, 0) scale(1)`, opacity: 1 }, { transform: `translate3d(${cx - 2 + Math.cos(a) * d}px, ${cy - 2 + Math.sin(a) * d}px, 0) scale(.2)`, opacity: 0 }], { duration: 560, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' }).finished.then(() => s.remove());
      }
    }

    /* --- wiring --- */
    const onLeave = () => { if (state === 'hover') setState('idle'); };
    if (o.input) {
      root.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('keydown', onKey);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
      root.addEventListener('contextmenu', onContext);
      root.addEventListener('click', onClick, true);
      root.addEventListener('pointerleave', onLeave);
    }

    return {
      get state() { return state; },
      get dragging() { return drag ? { id: drag.card.dataset.id, mode: drag.mode, maxTilt: drag.lift.maxTilt, x: drag.x, y: drag.y } : null; },
      /** Agent picks up a card and moves it (column key from data-col). */
      agentMove: (id, col, index = 0) => enqueue(() => { const c = byId(id), k = root.querySelector(`${o.column}[data-col="${col}"]`); return c && k ? moveCard(c, k, index, { kind: 'agent' }) : false; }),
      /** Card finished: hop (Expressive) / glide (Quiet) / dot (Dot) to the top of that column. */
      complete: (id, col = 'done') => enqueue(() => { const c = byId(id), k = root.querySelector(`${o.column}[data-col="${col}"]`); return c && k ? moveCard(c, k, 0, { kind: 'done', owner: 'ok' }) : false; }),
      /** The DOM (React) already moved this card; play the move from where it was. kind: 'agent' | 'done'. */
      play: (el, fromRect, kind = 'agent') => enqueue(() => moveCard(el, colOf(el), indexIn(el.parentElement, el), { kind, from: fromRect, owner: kind === 'done' ? 'ok' : undefined })),
      cancel: () => cancel('cancel'),
      refresh: prepare,
      destroy() {
        if (drag) end(); abortPending(); layer.remove();
        root.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel); window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('keydown', onKey);
        window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll);
        root.removeEventListener('contextmenu', onContext); root.removeEventListener('click', onClick, true); root.removeEventListener('pointerleave', onLeave);
      },
    };
  }

  /** FLIP one element from a remembered rect to where it is now (for list shifts a framework already committed). */
  function flipFrom(el, firstRect, theme, reduced) {
    const S = STYLES[theme] || STYLES.expressive, b = el.getBoundingClientRect(), dx = firstRect.left - b.left, dy = firstRect.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
    if (reduced) return el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: REDUCED_FADE });
    const T = timing(S.flip, false);
    return el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: T.duration, easing: T.easing });
  }

  /** Export the settings as plain data (board-drag.motion.json is generated from this). */
  function exportSettings() {
    const out = {};
    for (const [id, S] of Object.entries(STYLES)) {
      out[id] = JSON.parse(JSON.stringify(S));
      for (const k of ['flip', 'drop', 'cancel', 'glide']) { const t = timing(S[k], false); out[id][k] = Object.assign({}, S[k], { duration_ms: t.duration, easing: t.easing }); }
    }
    return out;
  }

  return { mount, flipFrom, Lift, Spring, STYLES, TOUCH, MOUSE, AUTOSCROLL, REDUCED_FADE, springEasing, timing, flip, haptic, hapticPatterns, themeOf, reducedOf, exportSettings };
});
