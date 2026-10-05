/* Ensemble motion · round 2 core. Tiny helpers shared by every piece (no dependencies).
   - U2.reduced(): OS setting or the app's own [data-reduce-motion="true"].
   - U2.Spring: a real damped spring you can retarget mid-flight (same constants as springs.json).
   - U2.scene(root): a per-piece scheduler (rAF loops, timeouts, tweens) that is disposed on replay.
   - Path helpers: Catmull-Rom smoothing, point lerp, resampling. */
(function () {
  const U2 = (window.U2 = window.U2 || {});
  U2.reduced = () =>
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.reduceMotion === 'true';

  U2.SPRINGS = { gentle: [120, 20], soft: [170, 18], bouncy: [260, 14], snappy: [420, 30], pluck: [300, 7] };
  U2.ease = {
    out: (t) => 1 - Math.pow(1 - t, 3),
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    in: (t) => t * t * t,
  };
  U2.clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  U2.lerp = (a, b, t) => a + (b - a) * t;
  U2.seg = (t, a, b) => U2.clamp((t - a) / (b - a)); // local 0..1 progress of t inside [a,b]

  /* Spring: x follows target with physics. step(dt) returns true while moving. */
  class Spring {
    constructor(value = 0, preset = 'soft') {
      const [k, c] = Array.isArray(preset) ? preset : U2.SPRINGS[preset];
      this.k = k; this.c = c; this.x = value; this.v = 0; this.target = value;
    }
    set(v) { this.x = this.target = v; this.v = 0; return this; }
    to(t) { this.target = t; return this; }
    kick(v) { this.v += v; return this; }
    step(dt) {
      const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
      for (let i = 0; i < n; i++) {
        const a = -this.k * (this.x - this.target) - this.c * this.v;
        this.v += a * h; this.x += this.v * h;
      }
      return Math.abs(this.x - this.target) > 1e-4 || Math.abs(this.v) > 1e-3;
    }
  }
  U2.Spring = Spring;

  /* Scene: everything a piece schedules goes through here so Replay can cancel it cleanly. */
  U2.scene = function (root) {
    let alive = true, raf = 0;
    const loops = new Set(), timers = new Set();
    let last = performance.now();
    const tick = (now) => {
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!root.__u2hidden) loops.forEach((f) => { if (f(dt, now) === false) loops.delete(f); });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const s = {
      root,
      get alive() { return alive; },
      reduced: U2.reduced(),
      loop(f) { loops.add(f); return () => loops.delete(f); },
      after(ms, f) { const id = setTimeout(() => { timers.delete(id); if (alive) f(); }, s.reduced ? 0 : ms); timers.add(id); return id; },
      /* tween(ms, (p) => ..., ease) -> Promise. Reduced motion jumps to the end. */
      tween(ms, f, ease = U2.ease.out) {
        return new Promise((res) => {
          if (s.reduced || ms <= 0) { f(1); return res(); }
          let t = 0;
          s.loop((dt) => { t += dt * 1000; const p = Math.min(1, t / ms); f(ease(p)); if (p >= 1) { res(); return false; } });
        });
      },
      wait(ms) { return new Promise((r) => s.after(ms, r)); },
      /* spring-driven value: spring(from, to, preset, onUpdate) -> Promise when settled */
      spring(from, to, preset, f) {
        return new Promise((res) => {
          if (s.reduced) { f(to); return res(); }
          const sp = new Spring(from, preset).to(to);
          s.loop((dt) => { const moving = sp.step(dt); f(sp.x); if (!moving) { f(to); res(); return false; } });
        });
      },
      $(q) { return root.querySelector(q); },
      $$(q) { return [...root.querySelectorAll(q)]; },
      dispose() { alive = false; cancelAnimationFrame(raf); loops.clear(); timers.forEach(clearTimeout); timers.clear(); },
    };
    return s;
  };

  /* ── path helpers ── */
  U2.catmull = (P, closed = false, k = 1) => {
    if (P.length < 2) return '';
    const n = P.length, f = (v) => v.toFixed(2);
    let d = `M${f(P[0][0])} ${f(P[0][1])}`;
    const get = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * k, p1[1] + ((p2[1] - p0[1]) / 6) * k];
      const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * k, p2[1] - ((p3[1] - p1[1]) / 6) * k];
      d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
    }
    return closed ? d + 'Z' : d;
  };
  U2.lerpPts = (A, B, t) => A.map((a, i) => [a[0] + (B[i][0] - a[0]) * t, a[1] + (B[i][1] - a[1]) * t]);
  let probe;
  U2.samplePath = (d, n) => {
    if (!probe) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
      probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.appendChild(probe); document.body.appendChild(svg);
    }
    probe.setAttribute('d', d);
    const L = probe.getTotalLength();
    return Array.from({ length: n }, (_, i) => { const p = probe.getPointAtLength((L * i) / (n - 1)); return [p.x, p.y]; });
  };
  /* The icon's U, in the icon's own 1024 grid (outer r196 / inner r86, arc centre 512,540). */
  U2.U_OUTER = 'M316 300 V540 A196 196 0 0 0 708 540 V300';
  U2.U_INNER = 'M426 300 V540 A86 86 0 0 0 598 540 V300';
  U2.el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  /* Registry: gallery cards call U2.pieces[id](scene) on mount/replay. */
  U2.pieces = U2.pieces || {};
  U2.define = (id, fn) => (U2.pieces[id] = fn);
})();

/* Scripted pointer: moves on a spring, clicks with a ring. Coordinates relative to `host`. */
(function () {
  const U2 = window.U2;
  U2.pointer = function (s, host) {
    const p = document.createElement('div');
    p.className = 'u2-pointer';
    p.innerHTML = '<span class="ring"></span><svg viewBox="0 0 24 24"><path d="M4 3l14.5 8.2-6.3 1.4-3.3 5.9z" fill="#f3eee6" stroke="#141210" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    host.appendChild(p);
    const hr = () => host.getBoundingClientRect();
    const X = new U2.Spring(hr().width * 0.8, [140, 22]), Y = new U2.Spring(hr().height + 30, [140, 22]);
    s.loop((dt) => { X.step(dt); Y.step(dt); p.style.transform = `translate(${X.x - 4}px, ${Y.x - 3}px)`; });
    const api = {
      el: p,
      at(x, y) { X.set(x); Y.set(y); return api; },
      pos() { return [X.x, Y.x]; },
      show() { if (!s.reduced) p.classList.add('on'); return api; },
      hide() { p.classList.remove('on'); return api; },
      /* move to an element (centre, or fx/fy fraction) or [x,y]; resolves when it arrives */
      to(target, fx = 0.5, fy = 0.5) {
        let x, y;
        if (Array.isArray(target)) [x, y] = target;
        else { const r = target.getBoundingClientRect(), h = hr(); x = r.left - h.left + r.width * fx; y = r.top - h.top + r.height * fy; }
        X.to(x); Y.to(y);
        if (s.reduced) { X.set(x); Y.set(y); return Promise.resolve(); }
        return new Promise((res) => s.loop(() => { if (Math.hypot(X.x - x, Y.x - y) < 1.5) { res(); return false; } }));
      },
      async click() {
        p.classList.add('down'); await s.wait(110);
        p.classList.remove('click'); void p.offsetWidth; p.classList.add('click');
        p.classList.remove('down'); await s.wait(60);
      },
    };
    return api;
  };
})();

/* Tie-checkbox: a little knot is drawn, then pulled tight into a check (point morph). Shared by pieces. */
(function () {
  const U2 = window.U2;
  const KNOT = 'M4.5 10.5 L7.6 13.4 C9.4 15.2 12.4 13.8 11.4 11.4 C10.4 9.1 7.3 10.4 8.3 12.8 C9.1 14.7 10.7 14.3 11.7 12.8 L16 5.5';
  const CHECK = 'M4.5 10.5 L8.4 14.2 L16 5.5';
  let K, C;
  U2.tie = async function (s, path, on = true) {
    if (!K) { K = U2.samplePath(KNOT, 44); C = U2.samplePath(CHECK, 44); }
    if (!on) { path.style.strokeDasharray = ''; await s.tween(180, (p) => { path.style.opacity = 1 - p; }); path.setAttribute('d', ''); path.style.opacity = 1; return; }
    path.style.opacity = 1;
    path.setAttribute('d', U2.catmull(K, false, 0.9));
    path.setAttribute('pathLength', '1');
    path.style.strokeDasharray = '1'; path.style.strokeDashoffset = '1';
    await s.tween(260, (p) => (path.style.strokeDashoffset = 1 - p), U2.ease.out);
    path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; path.removeAttribute('pathLength');
    await s.spring(0, 1, 'soft', (t) => path.setAttribute('d', U2.catmull(U2.lerpPts(K, C, t), false, 0.9 - 0.9 * U2.clamp(t))));
    path.setAttribute('d', CHECK);
  };
  /* Burst of curled strands under simple physics. host must be position:relative. */
  const SHAPES = ['M2 12C6 4 12 4 12 10S18 18 22 10', 'M3 15A8 8 0 0 1 19 15', 'M5 17C4 7 17 6 14 12C12 17 7 13 12 6', 'M2 12Q7 6 12 12T22 12'];
  const COLS = ['var(--u-agent)', 'var(--v-hi)', 'var(--v-hi2)', 'var(--u-you)', 'var(--ok)', 'var(--warm)'];
  U2.burst = function (s, host, x, y, n = 26, opt = {}) {
    if (s.reduced) return;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:40;overflow:visible';
    host.appendChild(layer);
    const ps = [];
    for (let i = 0; i < n; i++) {
      const e = document.createElement('div');
      const sz = 12 + Math.random() * 9;
      e.style.cssText = `position:absolute;left:${x - sz / 2}px;top:${y - sz / 2}px;width:${sz}px;height:${sz}px;will-change:transform,opacity`;
      e.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" style="overflow:visible"><path d="${SHAPES[i % SHAPES.length]}" fill="none" stroke="${COLS[(i * 7) % COLS.length]}" stroke-width="${2.6 + Math.random()}" stroke-linecap="round"/></svg>`;
      layer.appendChild(e);
      const spread = opt.spread || [-165, -15];
      const a = ((spread[0] + Math.random() * (spread[1] - spread[0])) * Math.PI) / 180;
      const sp = (opt.speed || 420) * (0.55 + Math.random() * 0.75);
      ps.push({ e, x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * 360, vr: (Math.random() - 0.5) * 900,
        f: 6 + Math.random() * 8, ph: Math.random() * 6, life: 1.2 + Math.random() * 0.8, age: 0 });
    }
    s.loop((dt) => {
      let live = 0;
      for (const p of ps) {
        p.age += dt; if (p.age > p.life) { p.e.style.opacity = 0; continue; }
        live++;
        const drag = Math.exp(-2.4 * dt);
        p.vx *= drag; p.vy = p.vy * drag + 1150 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
        const flip = Math.cos(p.age * p.f + p.ph);
        const o = 1 - U2.seg(p.age, p.life - 0.45, p.life);
        const pop = U2.clamp(p.age / 0.08);
        p.e.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.r}deg) scale(${pop},${pop * (0.35 + 0.65 * Math.abs(flip))})`;
        p.e.style.opacity = o;
      }
      if (!live) { layer.remove(); return false; }
    });
  };
})();
