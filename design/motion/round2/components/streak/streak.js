/* 03 · Streak knot: today's bead drops onto the week's thread, which dips and springs back. */
U2.define('streak', (s) => {
  const root = s.$('.sk'), svg = s.$('.sk-svg');
  const A = 20, B = 380, BASE = 70, N = 7, TODAY = 5, R = 7;
  const bx = (i) => 44 + i * 52;
  const thread = s.$('.sk-thread'), beadsG = s.$('.sk-beads'), days = s.$('.sk-days');
  const D = new U2.Spring(0, 'pluck');
  const xb = bx(TODAY);
  const yAt = (x) => BASE + 5 * Math.sin((Math.PI * (x - A)) / (B - A)) + D.x * (x < xb ? (x - A) / (xb - A) : (B - x) / (B - xb));
  const beads = [];
  'MTWTFSS'.split('').forEach((d, i) => {
    const c = U2.el('circle', { r: R, cx: bx(i), cy: BASE, class: 'sk-bead' + (i > TODAY ? ' future' : i === TODAY ? ' today' : '') }, beadsG);
    beads.push(c);
    if (i < TODAY) beads[i].k = U2.el('circle', { r: 10.5, cx: bx(i), cy: BASE, class: 'sk-past-knot' }, beadsG);
    U2.el('text', { x: bx(i), y: 104, class: 'sk-day' + (i === TODAY ? ' now' : '') }, days).textContent = d;
  });
  const knot = s.$('.sk-knot');
  let by = -30, vy = 0, landed = false, weight = 0;
  const draw = () => {
    const pts = []; for (let x = A; x <= B; x += 8) pts.push([x, yAt(x)]); pts.push([B, yAt(B)]);
    thread.setAttribute('d', U2.catmull(pts));
    beads.forEach((c, i) => {
      const x = bx(i), y = i === TODAY ? (landed ? yAt(x) - R + 2 : by) : yAt(x) - R + 2;
      c.setAttribute('cy', y); if (c.k) c.setAttribute('cy', y);
      if (i === TODAY) { knot.setAttribute('cx', x); knot.setAttribute('cy', y); }
    });
  };
  const spark = s.$('.sk-spark');
  for (let i = 0; i < 7; i++) { const a = (-Math.PI / 2) + (i - 3) * 0.42; U2.el('line', { x1: xb + Math.cos(a) * 14, y1: 0, x2: xb + Math.cos(a) * 40, y2: 0, 'data-a': a }, spark); }
  if (s.reduced) { landed = true; D.set(6); draw(); knot.style.opacity = 1; knot.setAttribute('r', 10.5); root.classList.add('rolled'); return; }
  draw();
  s.loop((dt) => {
    if (!landed) {
      if (by < -20) { draw(); return; }
      vy += 2200 * dt; by += vy * dt;
      const floor = yAt(xb) - R + 2;
      if (by >= floor) { landed = true; D.to(6).kick(vy * 0.42); onLand(); }
    }
    D.step(dt); draw();
  });
  let t0;
  const onLand = async () => {
    // sparks at the bead
    spark.querySelectorAll('line').forEach((l) => { const a = +l.dataset.a, y = yAt(xb) - R; l.setAttribute('y1', y + Math.sin(a) * 14); l.setAttribute('y2', y + Math.sin(a) * 40); });
    await s.wait(260);
    root.classList.add('sparked');
    knot.style.opacity = 1;
    knot.setAttribute('pathLength', 1);
    await s.tween(320, (p) => { knot.style.strokeDasharray = `${p} 1`; }, U2.ease.out);
    knot.style.strokeDasharray = '';
    s.spring(15, 10.5, 'bouncy', (r) => knot.setAttribute('r', r));
    root.classList.add('rolled');
  };
  beads[TODAY].style.opacity = 0;
  s.after(600, () => { by = -18; beads[TODAY].style.transition = 'opacity .18s'; beads[TODAY].style.opacity = 1; });
});
