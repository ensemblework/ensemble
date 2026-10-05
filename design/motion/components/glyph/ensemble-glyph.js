/* Ensemble Glyph engine (~120 lines, no deps).
   Two strands of N points; any shape morphs into any other, so state changes
   (working -> wait -> pause -> success/error) are always continuous.
   Keyframes: window.ENSEMBLE_GLYPH_KF (keyframes.json). */
(function () {
  const KF = window.ENSEMBLE_GLYPH_KF;
  const reduced = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.reduceMotion === "true";
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // matches --ease-weave closely
  const lerpS = (a, b, t) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
  const lerp = (A, B, t) => [lerpS(A[0], B[0], t), lerpS(A[1], B[1], t)]; // a shape = [agent strand, your strand]
  function d(P) {
    let s = `M${P[0][0].toFixed(2)} ${P[0][1].toFixed(2)}`;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      s += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ` +
           `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ` +
           `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    return s;
  }
  // Braid phase: slide each strand's points along the mark so the crossings travel (the weave "moves").
  function weave(shape, phase) {
    const [a, b] = shape, n = a.length, amp = Math.sin(phase) * 0.9;
    const shift = (S, k) => S.map((p, i) => {
      const q = S[Math.min(n - 1, Math.max(0, i + 1))], r = S[Math.max(0, i - 1)];
      return [p[0] + (q[0] - r[0]) * k, p[1] + (q[1] - r[1]) * k];
    });
    return [shift(a, amp), shift(b, -amp)];
  }
  // The working loop: [shape, moveMs, holdMs, holdFx]
  const LOOP = [
    ["u", 450, 380],
    ["braid", 700, 1100, "weave"],
    ["rings", 700, 420],
    ["spark", 700, 700, "spin"],
    ["merge", 650, 520, "pulse"],
    ["u", 700, 380],
  ];
  // per-shape stroke scale [agent, you]: the spark is drawn finer, like a flare
  const WIDTH = { spark: [0.55, 0.62], braid: [0.8, 0.85] };
  const wOf = (name) => WIDTH[name] || [1, 1];
  const STATE_SHAPE = { idle: "u", wait: "u", pause: "pause", success: "check", error: "fray" };

  class Glyph {
    constructor(el, opts = {}) {
      this.el = el; this.size = opts.size || 48;
      const small = this.size <= 20, sw = small ? 1.3 : 1;
      el.classList.add("u-glyph");
      el.style.width = el.style.height = this.size + "px";
      el.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true"><g class="ug-g" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path class="ug-agent" stroke-width="${5 * sw}"/><path class="ug-you" stroke-width="${3.8 * sw}"/></g></svg>`;
      this.g = el.querySelector(".ug-g");
      [this.pa, this.pb] = el.querySelectorAll("path");
      this.cur = KF.u.map((s) => s.map((p) => p.slice()));
      this.sw = 5 * sw; this.sy = 3.8 * sw; this.curW = [1, 1];
      this.render(this.cur, 0, 1);
      this.set(opts.state || "working");
    }
    render(shape, rot, scale, youOpacity, w) {
      this.cur = shape;
      if (w) { this.curW = w; this.pa.setAttribute("stroke-width", (this.sw * w[0]).toFixed(2)); this.pb.setAttribute("stroke-width", (this.sy * w[1]).toFixed(2)); }
      this.pa.setAttribute("d", d(shape[0]));
      this.pb.setAttribute("d", d(shape[1]));
      this.g.setAttribute("transform", `rotate(${rot || 0} 24 24) translate(24 24) scale(${scale || 1}) translate(-24 -24)`);
      this.pb.style.opacity = youOpacity == null ? "" : youOpacity;
    }
    set(state) {
      this.state = state;
      this.el.className = "u-glyph is-" + state;
      this.el.setAttribute("role", "img");
      this.el.setAttribute("aria-label", { working: "Ensemble is working", wait: "Waiting for you", pause: "Paused", success: "Done", error: "Stopped", idle: "Ensemble" }[state] || "Ensemble");
      cancelAnimationFrame(this.raf);
      const from = this.cur;
      if (state === "working") {
        if (reduced()) return this.render(KF.u, 0, 1);
        return this.loop(from);
      }
      const target = KF[STATE_SHAPE[state]];
      if (reduced()) return this.render(target, 0, 1);
      this.tween(from, target, state === "success" ? 520 : 600, (t) => {
        // success: the ring (your strand) blooms outward then fades, like a knot pulled tight
        if (state === "success") return [1, 0.6 + 0.4 * t, 1 - t * 0.85];
        return [1, 1, null];
      });
    }
    tween(from, to, ms, fx, done) {
      const t0 = performance.now(); this.curW0 = this.curW;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = ease(t);
        const [, scale, op] = fx ? fx(e) : [1, 1, null];
        const w0 = this.curW0 || [1, 1];
        this.render(lerp(from, to, e), 0, scale, op, [w0[0] + (1 - w0[0]) * e, w0[1] + (1 - w0[1]) * e]);
        if (t < 1) this.raf = requestAnimationFrame(step); else done && done();
      };
      this.raf = requestAnimationFrame(step);
    }
    loop(from) {
      // first ease from wherever we are into the mark, then run the loop forever
      let i = 0, prev = from, prevW = this.curW, phaseStart = performance.now(), stage = "move";
      const step = (now) => {
        const [name, move, hold, fx] = LOOP[i];
        const target = KF[name];
        const el = now - phaseStart;
        const mv = move;
        if (stage === "move") {
          const t = mv ? Math.min(1, el / mv) : 1;
          const e = ease(t), w0 = prevW, w1 = wOf(name);
          this.render(lerp(prev, target, e), 0, 1, null, [w0[0] + (w1[0] - w0[0]) * e, w0[1] + (w1[1] - w0[1]) * e]);
          if (t >= 1) { stage = "hold"; phaseStart = now; }
        } else {
          const h = hold ? Math.min(1, el / hold) : 1;
          let shape = target, rot = 0, scale = 1;
          if (fx === "weave") shape = weave(target, ease(h) * Math.PI * 2);
          if (fx === "spin") rot = ease(h) * 90;             // 4-fold star: 90deg looks seamless
          if (fx === "pulse") scale = 1 + Math.sin(h * Math.PI) * 0.28;
          this.render(shape, rot, scale);
          if (h >= 1) {
            prev = target; prevW = wOf(name); i = (i + 1) % LOOP.length; stage = "move"; phaseStart = now;
            if (i === 0) i = 1; // index 0 only eases in from the previous state
          }
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
  }
  window.EnsembleGlyph = {
    mount: (el, opts) => (el.__glyph = new Glyph(el, opts)),
    auto(root = document) {
      root.querySelectorAll("[data-u-glyph]").forEach((el) => {
        if (!el.__glyph) el.__glyph = new Glyph(el, { size: +el.dataset.size || 48, state: el.dataset.uGlyph || "working" });
      });
    },
  };
})();
