/* 06 · Morning briefing */
U2.define('sunrise', (s) => {
  const root = s.$('.sr'), sun = s.$('.sr-sunwrap'), dawn = s.$('.sr-dawn'), stars = s.$('.sr-stars'), rays = s.$('.sr-rays');
  const R = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    R.push(U2.el('line', { x1: Math.cos(a) * 60, y1: Math.sin(a) * 60, x2: Math.cos(a) * (i % 2 ? 78 : 88), y2: Math.sin(a) * (i % 2 ? 78 : 88),
      stroke: i % 2 ? '#f3eee6' : '#b4a9ff', pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1 }, rays));
  }
  const X = 300, Y0 = 372, Y1 = 150, U = s.$('.sr-u');
  const set = (p, rp) => {
    const y = U2.lerp(Y0, Y1, p), sc = U2.lerp(0.35, 1, U2.ease.out(p));
    sun.setAttribute('transform', `translate(${X} ${y}) scale(${sc})`);
    dawn.style.opacity = U2.ease.inOutSine(U2.clamp(p * 1.15));
    stars.style.opacity = 1 - U2.clamp(p * 1.4);
    U.style.opacity = 0.5 + 0.5 * U2.clamp(p * 1.3);
    R.forEach((r, i) => r.setAttribute('stroke-dashoffset', 1 - U2.clamp(rp * 1.6 - i * 0.05)));
  };
  const cards = s.$$('.sr-card');
  if (s.reduced) { set(1, 1); root.classList.add('reduced', 'greet', 'list'); cards.forEach((c) => c.classList.add('open', 'pin')); return; }
  set(0, 0);
  (async () => {
    await s.wait(250);
    // rise: a slow ease with a soft spring settle at the top
    let t = 0;
    const rp = { v: 0 };
    s.loop((dt) => {
      t += dt;
      const p = U2.ease.inOutSine(U2.clamp(t / 2.4));
      const settle = t > 2.4 ? 0 : 0;
      rp.v = U2.clamp((t - 1.3) / 1.2);
      set(p + settle, U2.ease.out(rp.v));
      if (t > 2.6) return false;
    });
    await s.wait(1500); root.classList.add('greet');
    await s.wait(900); root.classList.add('list');
    for (const c of cards) { c.classList.add('pin'); await s.wait(120); c.classList.add('open'); await s.wait(230); }
  })();
});
