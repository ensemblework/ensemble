/* 05 · Connect a source: thread shoots across, is plucked taut, knots, then items flow as beads. */
U2.define('connect', (s) => {
  const root = s.$('.cn'), path = s.$('.cn-thread'), flow = s.$('.cn-flow'), knot = s.$('.cn-knot');
  const s1 = s.$('.cn-s1'), s2 = s.$('.cn-s2'), btn = s.$('.cn-btn'), bl = s.$('.cn-bl');
  const gm = s.$('.cn-tile.gm'), un = s.$('.cn-tile.un');
  const geo = () => {
    const h = s.root.getBoundingClientRect(), a = gm.querySelector('svg').getBoundingClientRect(), b = un.querySelector('svg').getBoundingClientRect();
    return { x1: a.right - h.left + 4, x2: b.left - h.left - 4, y: a.top - h.top + a.height / 2 };
  };
  let G = geo();
  const label = (t) => { bl.textContent = t; bl.classList.remove('swap'); void bl.offsetWidth; bl.classList.add('swap'); };
  const ctrl = new U2.Spring(0, 'pluck');
  let head = G.x1, arc = 0;
  const qp = (t, cy) => { const mx = (G.x1 + G.x2) / 2; const x = (1 - t) * (1 - t) * G.x1 + 2 * (1 - t) * t * mx + t * t * G.x2; const y = (1 - t) * (1 - t) * G.y + 2 * (1 - t) * t * cy + t * t * G.y; return [x, y]; };
  const draw = () => {
    const mx = (G.x1 + head) / 2;
    path.setAttribute('d', `M${G.x1} ${G.y} Q${mx} ${G.y + ctrl.x + arc} ${head} ${G.y}`);
    const m = qp(0.5, G.y + ctrl.x); knot.setAttribute('cx', m[0]); knot.setAttribute('cy', m[1]);
  };
  const count = (n) => n.toLocaleString('en-US');
  const end = () => { head = G.x2; ctrl.set(0); draw(); root.classList.add('knot', 'done'); s1.textContent = '2,406 threads · 38 people'; s2.textContent = 'Gmail is connected. New mail syncs every few minutes.'; bl.textContent = 'Connected'; };
  if (s.reduced) { end(); return; }
  draw();
  s.loop((dt) => { ctrl.step(dt); draw(); });
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(400); ptr.show(); await ptr.to(btn);
    btn.classList.add('press'); await ptr.click(); btn.classList.remove('press');
    btn.classList.add('busy'); label('Connecting…'); s1.textContent = 'Opening Google…';
    ptr.to([s.root.clientWidth + 30, s.root.clientHeight - 20]).then(() => ptr.hide());
    await s.wait(500);
    G = geo();
    await s.tween(520, (p) => { head = U2.lerp(G.x1, G.x2, p); arc = -34 * Math.sin(Math.PI * p); }, U2.ease.outQuint);
    arc = 0; ctrl.set(-30); ctrl.to(0);
    gm.classList.add('pull'); un.classList.add('pull');
    await s.wait(280); root.classList.add('knot');
    s1.textContent = 'Reading your inbox…';
    // flow beads + counter
    const cols = ['#ea4335', '#fbbc04', '#34a853', '#4285f4', 'var(--v-hi2)'];
    let n = 0, spawned = 0, T = 0; const total = 2406, dur = 2.6;
    const beads = [];
    un.classList.add('glow');
    s.loop((dt) => {
      T += dt;
      if (T < dur && T * 11 > spawned) { beads.push({ t: 0, e: U2.el('circle', { fill: cols[spawned % cols.length] }, flow) }); spawned++; }
      beads.forEach((b) => { b.t += dt / 0.75; const [x, y] = qp(U2.ease.inOut(Math.min(1, b.t)), G.y + ctrl.x); b.e.setAttribute('cx', x); b.e.setAttribute('cy', y); b.e.style.opacity = b.t < 0.1 ? b.t * 10 : b.t > 0.88 ? (1 - b.t) / 0.12 : 1; });
      for (let i = beads.length - 1; i >= 0; i--) if (beads[i].t >= 1) { beads[i].e.remove(); beads.splice(i, 1); }
      n = Math.round(total * U2.ease.out(Math.min(1, T / dur)));
      s1.textContent = T < dur ? `Reading your inbox · ${count(n)}` : '2,406 threads · 38 people';
      if (T >= dur && !beads.length) {
        root.classList.add('done'); un.classList.remove('glow'); btn.classList.remove('busy'); label('Connected');
        s2.textContent = 'Gmail is connected. New mail syncs every few minutes.';
        return false;
      }
    });
  })();
});
