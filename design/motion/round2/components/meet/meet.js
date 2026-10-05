/* 04 · First meeting: two dots spiral in, meet at the bottom of the mark, and grow up the arms together. */
U2.define('meet', (s) => {
  const root = s.$('.mt');
  const arms = s.$$('.mt-arm'), dv = s.$('.mt-dot.v'), dp = s.$('.mt-dot.p'), lv = s.$('.mt-lbl.v'), lp = s.$('.mt-lbl.p');
  const trails = s.$('.mt-trails');
  arms.forEach((a) => { a.setAttribute('pathLength', 1); a.style.strokeDasharray = '1 1'; a.style.strokeDashoffset = 1; });
  const finish = () => {
    arms.forEach((a, i) => { a.style.strokeDashoffset = 0; a.style.strokeWidth = i < 2 ? 84 : 64; });
    [dv, dp, lv, lp].forEach((e) => (e.style.opacity = 0));
    root.classList.add('tile', 'shift', 'word');
  };
  if (s.reduced) { root.classList.add('reduced'); finish(); return; }
  const C = [512, 681], T = 2.9;
  const mk = (col) => Array.from({ length: 12 }, (_, i) => U2.el('path', { stroke: `color-mix(in srgb, ${col} ${Math.round((1 - i / 12) * 62)}%, var(--bg))` }, trails));
  const tv = mk('var(--u-agent)'), tp = mk('var(--u-you)');
  const hv = [], hp = [];
  let t = 0, phase = 0;
  const pos = (q, off) => {
    const th = Math.PI - (Math.PI / 2 + 2 * Math.PI) * q + off;
    const r = 55 + 1150 * Math.pow(1 - q, 2.4);
    return [C[0] + r * Math.cos(th), C[1] + r * Math.sin(th)];
  };
  const drawTrail = (segs, H, w) => {
    const n = segs.length, per = Math.max(2, Math.floor(H.length / n));
    segs.forEach((p, i) => {
      const a = H.slice(Math.max(0, H.length - (i + 1) * per - 1), H.length - i * per);
      p.setAttribute('d', a.length > 1 ? U2.catmull(a) : '');
      p.style.strokeWidth = w * (1 - i / n * 0.8);
    });
  };
  s.loop((dt) => {
    t += dt;
    if (phase === 0) {
      const q = U2.ease.inOutSine(Math.min(1, t / T));
      const a = pos(q, 0), b = pos(q, Math.PI);
      hv.push(a); hp.push(b); if (hv.length > 60) { hv.shift(); hp.shift(); }
      dv.setAttribute('cx', a[0]); dv.setAttribute('cy', a[1]); dp.setAttribute('cx', b[0]); dp.setAttribute('cy', b[1]);
      const lo = 1 - U2.seg(q, 0.55, 0.8);
      lv.setAttribute('x', a[0]); lv.setAttribute('y', a[1] - 48); lp.setAttribute('x', b[0]); lp.setAttribute('y', b[1] - 44);
      lv.style.opacity = lp.style.opacity = lo * U2.seg(q, 0.02, 0.12);
      drawTrail(tv, hv, 26); drawTrail(tp, hp, 22);
      if (t >= T) { phase = 1; t = 0; root.classList.add('met'); }
    } else if (phase === 1) {
      // trails retract, strands grow up both arms from the meeting point
      hv.shift(); hp.shift(); hv.shift(); hp.shift(); drawTrail(tv, hv, 26); drawTrail(tp, hp, 22);
      const p = U2.ease.inOut(U2.clamp(t / 1.25));
      arms.forEach((a, i) => { a.style.strokeDashoffset = 1 - p; a.style.strokeWidth = U2.lerp(i < 2 ? 26 : 22, i < 2 ? 84 : 64, U2.ease.out(p)); });
      dv.style.opacity = dp.style.opacity = 1 - U2.seg(t, 0, 0.35);
      if (t >= 1.25) { phase = 2; root.classList.add('tile'); s.after(650, () => root.classList.add('shift')); s.after(950, () => root.classList.add('word')); return false; }
    }
  });
});
