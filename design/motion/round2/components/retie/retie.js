/* 14 · Re-tie & reconnect: frayed ends reach for each other and knot; the Mark's middle dot pops back when online. */
U2.define('retie', (s) => {
  const root = s.$('.rt'), pl = s.$('.rt-th.l'), pr = s.$('.rt-th.r'), fib = s.$('.rt-fib'), knot = s.$('.rt-knot'), btn = s.$('.rt-btn');
  const net = s.$('.rt-net'), pill = s.$('.rt-pill span');
  const Y = 35, M = 150;
  const L = new U2.Spring(118, 'soft'), R = new U2.Spring(182, 'soft'), F = new U2.Spring(1, 'soft'), SAG = new U2.Spring(5, 'pluck');
  let joined = false;
  const fibers = [];
  for (const side of [-1, 1]) for (const a of [-0.55, 0, 0.5]) fibers.push({ side, a, el: U2.el('line', {}, fib) });
  const yAt = (x) => Y + SAG.x * Math.sin((Math.PI * (x - 12)) / 276);
  const draw = () => {
    if (joined) { pl.setAttribute('d', `M12 ${Y} Q${M} ${Y + SAG.x * 2} 288 ${Y}`); pr.setAttribute('d', ''); fib.style.opacity = 0; knot.setAttribute('cy', Y + SAG.x); return; }
    pl.setAttribute('d', `M12 ${Y} Q${(12 + L.x) / 2} ${yAt((12 + L.x) / 2) + SAG.x * 0.3} ${L.x} ${yAt(L.x) + 6 * F.x}`);
    pr.setAttribute('d', `M${R.x} ${yAt(R.x) + 6 * F.x} Q${(R.x + 288) / 2} ${yAt((R.x + 288) / 2) + SAG.x * 0.3} 288 ${Y}`);
    fibers.forEach((f) => {
      const x = f.side < 0 ? L.x : R.x, y = yAt(x) + 6 * F.x, dir = f.side < 0 ? 1 : -1, len = 9 * F.x + 1;
      const ang = f.a * F.x + (f.side < 0 ? 0.35 : -0.35) * F.x;
      f.el.setAttribute('x1', x); f.el.setAttribute('y1', y); f.el.setAttribute('x2', x + dir * Math.cos(ang) * len); f.el.setAttribute('y2', y + Math.sin(ang) * len * 1.2);
    });
  };
  const label = (t) => { pill.textContent = t; pill.classList.remove('swap'); void pill.offsetWidth; pill.classList.add('swap'); };
  if (s.reduced) { joined = true; SAG.set(1); draw(); knot.style.opacity = 1; knot.setAttribute('r', 4.5); root.classList.add('fixed'); btn.querySelector('span').textContent = 'Synced'; net.classList.add('on'); pill.textContent = 'Online'; return; }
  s.loop((dt) => { L.step(dt); R.step(dt); F.step(dt); SAG.step(dt); draw(); });
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(500); ptr.show(); await ptr.to(btn);
    btn.classList.add('press'); await ptr.click(); btn.classList.remove('press');
    btn.querySelector('span').textContent = 'Re-tying…';
    ptr.to([s.root.clientWidth * 0.3, s.root.clientHeight + 30]).then(() => ptr.hide());
    root.classList.add('tying');
    F.to(0); L.to(M + 7); R.to(M - 7);
    await s.wait(620);
    // knot: a loop is drawn at the overlap, then pulled tight
    knot.setAttribute('pathLength', 1); knot.style.opacity = 1;
    await s.tween(300, (p) => (knot.style.strokeDasharray = `${p} 1`), U2.ease.out);
    knot.style.strokeDasharray = '';
    joined = true; SAG.set(3); SAG.to(1.2).kick(-60);
    await s.spring(9, 4.5, 'bouncy', (r) => knot.setAttribute('r', r));
    root.classList.remove('tying'); root.classList.add('fixed');
    btn.querySelector('span').textContent = 'Synced';
    // offline → online on the right
    await s.wait(500);
    for (const n of [2, 1]) { label(`Offline · retrying in ${n}s`); await s.wait(550); }
    net.classList.add('re'); label('Reconnecting…');
    await s.wait(1000);
    net.classList.remove('re'); net.classList.add('on'); label('Online');
  })();
});
