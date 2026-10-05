/* 00 · Brand loop: two twisting ribbons (agent violet, you paper) trace mark → figure-eight → linked rings → mark. */
U2.define('brandloop', (s) => {
  const cv = s.$('.bl2-c'), ctx = cv.getContext('2d'), cap = s.$('.bl2-shape'), steps = s.$$('.bl2-steps i');
  const N = 150;
  const css = getComputedStyle(s.root);
  const col = (v, f) => (css.getPropertyValue(v).trim() || f);
  const light = s.root.closest('[data-theme]')?.dataset.theme === 'light';
  const C = { af: col('--u-agent', '#7c6af7'), ab: light ? '#9d8fff' : '#b4a9ff', yf: light ? '#1c1915' : '#f3eee6', yb: light ? '#5a534c' : '#c9bfae', glow: light ? 'rgba(83,70,214,.25)' : 'rgba(124,106,247,.55)' };
  // shapes in the icon's 1024 grid, centre ≈ (512, 520)
  const U_O = U2.samplePath(U2.U_OUTER, N), U_I = U2.samplePath(U2.U_INNER, N);
  const lem = (off, ph = 0) => { const P = []; for (let i = 0; i < N; i++) { const t = -Math.PI / 2 + ((i / (N - 1) + ph) * Math.PI * 2); const d = 1 + Math.sin(t) ** 2; P.push([512 + (470 * Math.cos(t)) / d, 520 + (470 * Math.sin(t) * Math.cos(t)) / d]); }
    return offset(P, off); };
  const ring = (cx, r, ph = 0) => Array.from({ length: N }, (_, i) => { const a = -Math.PI / 2 - (i / (N - 1) + ph) * Math.PI * 2; return [cx + r * Math.cos(a), 520 + r * Math.sin(a)]; });
  function offset(P, d) { return P.map((p, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [p[0] - (dy / L) * d, p[1] + (dx / L) * d]; }); }
  // timeline (seconds): hold U, → ∞ (flow), → rings (spin), → mark
  const LOOP = 12;
  const shapesAt = (t) => {
    const e = U2.ease.inOut;
    const flow = U2.seg(t, 3.2, 5.0), spin = U2.seg(t, 6.6, 8.4);
    const LO = lem(-30, e(flow)), LI = lem(30, e(flow));
    const RO = ring(412, 210, e(spin)), RI = ring(612, 210, -e(spin));
    if (t < 1.6) return [U_O, U_I, 0];
    if (t < 3.2) { const k = e(U2.seg(t, 1.6, 3.2)); return [U2.lerpPts(U_O, LO, k), U2.lerpPts(U_I, LI, k), k < 0.5 ? 0 : 1]; }
    if (t < 5.0) return [LO, LI, 1];
    if (t < 6.6) { const k = e(U2.seg(t, 5.0, 6.6)); return [U2.lerpPts(LO, RO, k), U2.lerpPts(LI, RI, k), k < 0.5 ? 1 : 2]; }
    if (t < 8.4) return [RO, RI, 2];
    if (t < 10.2) { const k = e(U2.seg(t, 8.4, 10.2)); return [U2.lerpPts(RO, U_O, k), U2.lerpPts(RI, U_I, k), k < 0.5 ? 2 : 0]; }
    return [U_O, U_I, 0];
  };
  let W = 0, H = 0, dpr = 1;
  const fit = () => { const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; };
  fit();
  const ribbon = (P, width, front, back, tw, glow) => {
    const sc = (H * 0.78) / 1024, ox = W / 2 - 512 * sc, oy = H * 0.5 - 520 * sc;
    const Q = P.map(([x, y]) => [ox + x * sc, oy + y * sc]);
    const n = Q.length, L = [], R = [], face = [];
    for (let i = 0; i < n; i++) {
      const a = Q[Math.max(0, i - 1)], b = Q[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const c = Math.cos(tw(i / (n - 1)));
      const taper = Math.min(1, i / 6, (n - 1 - i) / 6) * 0.35 + 0.65;
      const w = (width * sc * (0.28 + 0.72 * Math.abs(c)) * taper) / 2;
      L.push([Q[i][0] - (dy / len) * w, Q[i][1] + (dx / len) * w]); R.push([Q[i][0] + (dy / len) * w, Q[i][1] - (dx / len) * w]); face.push(c >= 0);
    }
    if (glow) { ctx.save(); ctx.shadowColor = C.glow; ctx.shadowBlur = 36 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0)'; ctx.lineWidth = width * sc * 0.6; ctx.lineCap = 'round';
      ctx.beginPath(); Q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.strokeStyle = C.glow; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.restore(); }
    for (let i = 0; i < n - 1; i++) {
      const shade = face[i] ? front : back;
      ctx.fillStyle = shade; ctx.strokeStyle = shade; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(L[i][0], L[i][1]); ctx.lineTo(L[i + 1][0], L[i + 1][1]); ctx.lineTo(R[i + 1][0], R[i + 1][1]); ctx.lineTo(R[i][0], R[i][1]); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // round caps
    [[0, 1], [n - 1, n - 2]].forEach(([i]) => { ctx.fillStyle = face[i] ? front : back; const r = Math.hypot(L[i][0] - R[i][0], L[i][1] - R[i][1]) / 2; ctx.beginPath(); ctx.arc(Q[i][0], Q[i][1], r, 0, Math.PI * 2); ctx.fill(); });
  };
  let last = -1;
  const draw = (T) => {
    const t = T % LOOP;
    const [O, I, k] = shapesAt(t);
    if (k !== last) { last = k; cap.textContent = ['mark', 'figure-eight', 'linked rings'][k]; steps.forEach((e, j) => e.classList.toggle('on', j === k)); }
    // twist amount rises away from the mark so the resting icon is flat (reads exactly like the logo)
    const flat = t < 1.4 || t > 10.4 ? 0 : Math.min(1, U2.seg(t, 1.4, 2.6), 1 - U2.seg(t, 9.2, 10.4));
    const twO = (u) => flat * (u * 9 + T * 1.6), twI = (u) => flat * (u * 9 + T * 1.6 + 1.2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ribbon(O, 84, C.af, C.ab, twO, true);
    ribbon(I, 64, C.yf, C.yb, twI, false);
  };
  if (s.reduced) { draw(0); return; }
  let T = 0;
  s.loop((dt) => { T += dt; draw(T); });
});
