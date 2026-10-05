/* 09 · Board handoff: a thread carries your card to the agent; cards tilt with speed; drags leave a tethered ghost. */
U2.define('board', (s) => {
  const host = s.root, layer = s.$('.bd-layer'), rope = s.$('.bd-rope'), hook = s.$('.bd-hook'), tether = s.$('.bd-tether'), menu = s.$('.bd-menu');
  const colsEl = s.$$('.bd-col'), H = 62, GAP = 10;
  const cols = { you: ['sum', 'rev', 'copy'], ag: ['flaky'], done: ['stand'] };
  const DATA = {
    sum: ['Summarize Priya\'s thread', 'Gmail · 6 messages', 'you'], rev: ['Review PR #42', 'GitHub · hub-api', 'you'], copy: ['Write privacy page copy', 'Docs · due Fri', 'you'],
    flaky: ['Fix flaky retention test', 'Run · step 3 of 5', 'ag'], stand: ['Send standup notes', 'Slack · #eng', 'ok'],
  };
  const geo = () => {
    const h = host.getBoundingClientRect();
    return colsEl.map((c) => { const r = c.getBoundingClientRect(); return { x: r.left - h.left + 10, y: r.top - h.top + 44, w: r.width - 20 }; });
  };
  let G = geo();
  const C = {};
  const mkCard = (id) => {
    const [t, m, own] = DATA[id];
    const el = document.createElement('div'); el.className = 'bd-card';
    el.innerHTML = `<div class="in"><div class="bd-t">${t}</div><i class="own ${own}">${own === 'you' ? 'S' : ''}</i><div class="bd-m"><span>${m}</span><span class="bd-prog"><i></i></span></div></div>`;
    el.style.width = G[0].w + 'px'; el.style.height = H + 'px';
    layer.appendChild(el);
    return { id, el, X: new U2.Spring(0, [170, 20]), Y: new U2.Spring(0, [170, 20]), R: new U2.Spring(0, [200, 16]), follow: null };
  };
  const slot = (col, i) => { const g = G[['you', 'ag', 'done'].indexOf(col)]; return [g.x, g.y + i * (H + GAP)]; };
  const layout = (jump) => {
    for (const col in cols) cols[col].forEach((id, i) => { const c = C[id]; if (c.follow) return; const [x, y] = slot(col, i); if (jump) { c.X.set(x); c.Y.set(y); } else { c.X.to(x); c.Y.to(y); } });
    s.$$('.bd-n').forEach((n, i) => { const v = cols[['you', 'ag', 'done'][i]].length; if (+n.textContent !== v) { n.textContent = v; n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop'); } });
  };
  Object.keys(DATA).forEach((id) => (C[id] = mkCard(id)));
  layout(true);
  const move = (id, to, idx = 0) => { for (const k in cols) cols[k] = cols[k].filter((x) => x !== id); cols[to].splice(idx, 0, id); layout(); };
  let crane = null; // {ax: Spring, y, card}
  let teth = null;  // {slot:[x,y], card}
  const render = (dt) => {
    for (const id in C) {
      const c = C[id];
      if (c.follow) { c.X.to(c.follow()[0]); c.Y.to(c.follow()[1]); }
      c.X.step(dt); c.Y.step(dt);
      c.R.to(U2.clamp(c.X.v * 0.009, -5, 5)); c.R.step(dt);
      c.el.style.transform = `translate(${c.X.x}px,${c.Y.x}px) rotate(${c.R.x}deg)`;
    }
    if (crane) {
      const c = crane.card, cx = c.X.x + G[0].w / 2;
      crane.ax.to(cx); crane.ax.step(dt);
      const ey = crane.attached ? c.Y.x + 1 : crane.y;
      const ex = crane.attached ? cx : crane.ex;
      const sag = U2.clamp((ex - crane.ax.x) * 0.25, -60, 60);
      rope.setAttribute('d', `M${crane.ax.x} -6 Q${(crane.ax.x + ex) / 2 - sag} ${ey * 0.55} ${ex} ${ey}`);
      hook.setAttribute('cx', ex); hook.setAttribute('cy', ey);
    }
    if (teth) {
      const c = teth.card, [sx, sy] = teth.slot, gx = c.X.x + G[0].w / 2, gy = c.Y.x + H / 2;
      const k = teth.k ?? 1, tx = U2.lerp(sx, gx, 1 - k) , ty = U2.lerp(sy, gy, 1 - k);
      tether.setAttribute('d', `M${tx} ${ty} Q${(tx + gx) / 2} ${Math.max(ty, gy) + 34 * k} ${gx} ${gy}`);
      tether.style.strokeDashoffset = -performance.now() / 40;
    }
  };
  if (s.reduced) {
    move('sum', 'ag', 0); move('flaky', 'done', 0); move('rev', 'ag', 1);
    C.sum.el.querySelector('.own').className = 'own ag'; C.sum.el.querySelector('.own').textContent = '';
    C.rev.el.querySelector('.own').className = 'own ag'; C.rev.el.querySelector('.own').textContent = '';
    C.flaky.el.querySelector('.own').className = 'own ok'; C.flaky.el.classList.add('isdone');
    layout(true); render(0); return;
  }
  s.loop(render);
  const menuAt = (x, y) => { menu.style.left = x + 'px'; menu.style.top = y + 'px'; menu.classList.add('show'); };
  (async () => {
    const ptr = U2.pointer(s, host);
    const sum = C.sum;
    await s.wait(300); ptr.show();
    await ptr.to(sum.el, 0.78, 0.5);
    await ptr.click();
    const [px, py] = ptr.pos(); menuAt(px + 6, py + 8);
    await s.wait(650); await ptr.click(); menu.classList.remove('show');
    ptr.to([host.clientWidth * 0.5, host.clientHeight + 40]);
    // the thread lowers and hooks the card
    const cx = sum.X.x + G[0].w / 2;
    crane = { ax: new U2.Spring(cx, [60, 14]), y: -6, ex: cx, card: sum, attached: false };
    rope.style.opacity = 1;
    await s.tween(520, (p) => (crane.y = U2.lerp(-6, sum.Y.x + 1, p)), U2.ease.outQuint);
    hook.style.opacity = 1; hook.animate([{ transform: 'scale(0)', transformOrigin: `${cx}px ${sum.Y.x}px` }, { transform: 'scale(1)', transformOrigin: `${cx}px ${sum.Y.x}px` }], { duration: 360, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    crane.attached = true; sum.el.classList.add('lift'); sum.el.style.zIndex = 5;
    await s.wait(280);
    colsEl[1].classList.add('hot');
    move('sum', 'ag', 0);
    await new Promise((r) => s.loop(() => { if (Math.abs(sum.X.x - sum.X.target) < 0.6 && Math.abs(sum.Y.x - sum.Y.target) < 0.6) { r(); return false; } }));
    colsEl[1].classList.remove('hot');
    sum.el.classList.remove('lift'); sum.el.classList.add('land');
    const own = sum.el.querySelector('.own'); own.className = 'own ag morph'; own.textContent = '';
    sum.el.querySelector('.bd-m span').textContent = 'Ensemble · picked up';
    // unhook and retract
    crane.attached = false; crane.ex = sum.X.x + G[0].w / 2; const y0 = sum.Y.x + 1;
    hook.style.opacity = 0;
    s.tween(520, (p) => (crane.y = U2.lerp(y0, -10, p)), U2.ease.in).then(() => (rope.style.opacity = 0));
    await s.wait(300);
    // agent finishes the flaky test card: it hops to Done
    const fl = C.flaky; fl.el.classList.add('working'); fl.el.querySelector('.bd-m span').textContent = 'Run · finishing';
    await s.wait(1700);
    fl.el.classList.add('isdone'); fl.el.querySelector('.own').className = 'own ok morph'; fl.el.querySelector('.bd-m span').textContent = 'Run · 5 of 5 passed';
    fl.el.style.zIndex = 4; fl.el.classList.add('lift');
    move('flaky', 'done', 0);
    await new Promise((r) => s.loop(() => { if (Math.abs(fl.X.x - fl.X.target) < 0.8 && Math.abs(fl.Y.x - fl.Y.target) < 0.8) { r(); return false; } }));
    fl.el.classList.remove('lift', 'working'); fl.el.classList.add('land');
    U2.burst(s, host, fl.X.x + G[0].w - 22, fl.Y.x + 20, 14, { speed: 300 });
    await s.wait(500);
    // you drag "Review PR #42" to Ensemble: ghost + tether to a stitched slot
    const rv = C.rev;
    await ptr.to(rv.el, 0.4, 0.5); await s.wait(120);
    ptr.el.classList.add('down');
    const [sx, sy] = [rv.X.x, rv.Y.x];
    const sl = document.createElement('div'); sl.className = 'bd-slot'; sl.style.cssText = `left:${sx}px;top:${sy}px;width:${G[0].w}px;height:${H}px`; layer.prepend(sl);
    void sl.offsetWidth; sl.classList.add('on');
    const grab = [ptr.pos()[0] - rv.X.x, ptr.pos()[1] - rv.Y.x];
    rv.el.classList.add('ghost'); rv.el.style.zIndex = 6;
    rv.follow = () => { const [x, y] = ptr.pos(); return [x - grab[0], y - grab[1]]; };
    teth = { slot: [sx + G[0].w / 2, sy + H / 2], card: rv, k: 1 };
    tether.style.opacity = 1;
    const tgt = slot('ag', 1);
    colsEl[1].classList.add('hot');
    await ptr.to([tgt[0] + grab[0], tgt[1] + grab[1] + 6]);
    await s.wait(160);
    ptr.el.classList.remove('down');
    rv.follow = null; rv.el.classList.remove('ghost'); rv.el.classList.add('land');
    move('rev', 'ag', 1); colsEl[1].classList.remove('hot');
    rv.el.querySelector('.own').className = 'own ag morph'; rv.el.querySelector('.own').textContent = '';
    await s.tween(420, (p) => (teth.k = 1 - p), U2.ease.inOut);
    tether.style.opacity = 0; teth = null; sl.classList.remove('on');
    ptr.to([host.clientWidth * 0.9, host.clientHeight + 40]).then(() => ptr.hide());
  })();
});
