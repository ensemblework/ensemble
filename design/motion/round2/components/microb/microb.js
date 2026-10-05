/* 11 · Tabs thread / bell strand ring / focus rim */
U2.define('microb', (s) => {
  // Tabs: two ends on different springs; the one moving forward leads, the thread sags while stretched.
  const tabsEl = s.$('.mb-tabs'), tabs = [...tabsEl.querySelectorAll('button')], ul = s.$('.mb-ul');
  const path = ul.querySelector('path'), ca = ul.querySelector('.a'), cb = ul.querySelector('.b');
  const box = (b) => { const r = b.getBoundingClientRect(), h = tabsEl.getBoundingClientRect(); return [r.left - h.left + 10, r.right - h.left - 10, r.bottom - h.top + 4]; };
  let [l0, r0, Y] = box(tabs[0]);
  const L = new U2.Spring(l0, 'soft'), R = new U2.Spring(r0, 'soft');
  let cur = 0;
  const go = (i) => {
    if (i === cur) return; const [l, r] = box(tabs[i]); const fwd = i > cur;
    const lead = [420, 32], trail = [120, 17];
    Object.assign(fwd ? R : L, { k: lead[0], c: lead[1] }); Object.assign(fwd ? L : R, { k: trail[0], c: trail[1] });
    L.to(l); R.to(r);
    tabs[cur].classList.remove('on'); tabs[i].classList.add('on'); cur = i;
    if (s.reduced) { L.set(l); R.set(r); }
  };
  tabs.forEach((b, i) => b.addEventListener('click', () => go(i)));
  const drawTabs = () => {
    const w = R.x - L.x, want = R.target - L.target, sag = U2.clamp((w - want) * 0.09, 0, 10);
    path.setAttribute('d', `M${L.x} ${Y} Q${(L.x + R.x) / 2} ${Y + sag * 2} ${R.x} ${Y}`);
    ca.setAttribute('cx', L.x); ca.setAttribute('cy', Y); cb.setAttribute('cx', R.x); cb.setAttribute('cy', Y);
  };
  s.loop((dt) => { L.step(dt); R.step(dt); drawTabs(); });
  drawTabs();
  // Bell
  const bell = s.$('.bl'), bs = s.$('.bl-bell'), rings = s.$$('.bl-ring circle');
  const swing = new U2.Spring(0, [260, 7]);
  s.loop((dt) => { swing.step(dt); bs.style.transform = `rotate(${swing.x}deg)`; });
  const ring = async () => {
    bell.classList.remove('has');
    swing.kick(420);
    rings.forEach((c, i) => {
      c.setAttribute('pathLength', 1); c.style.strokeDasharray = '0 1'; c.style.opacity = 1;
      s.after(i * 130, () => s.tween(700, (p) => { c.style.strokeDasharray = `${p} 1`; c.style.strokeDashoffset = -p * 0.25; }, U2.ease.inOut)
        .then(() => s.tween(400, (p) => (c.style.opacity = 1 - p))));
    });
    s.after(250, () => bell.classList.add('has'));
  };
  bell.addEventListener('click', ring);
  // Focus rim: two strands from the left middle, one over the top and one under, meeting on the right.
  const fr = s.$('.fr'), inp = s.$('.fr-in'), [pt, pb] = s.$$('.fr-svg path'), meet = s.$('.fr-meet');
  const rimPaths = () => {
    const w = fr.clientWidth, h = inp.offsetHeight, r = 12, m = h / 2, o = 0.5;
    pt.setAttribute('d', `M${o} ${m} V${r} A${r} ${r} 0 0 1 ${r} ${o} H${w - r} A${r} ${r} 0 0 1 ${w - o} ${r} V${m}`);
    pb.setAttribute('d', `M${o} ${m} V${h - r} A${r} ${r} 0 0 0 ${r} ${h - o} H${w - r} A${r} ${r} 0 0 0 ${w - o} ${h - r} V${m}`);
    meet.setAttribute('cx', w - o); meet.setAttribute('cy', m);
  };
  rimPaths();
  [pt, pb].forEach((p) => { p.setAttribute('pathLength', 1); p.style.strokeDasharray = '1 1'; p.style.strokeDashoffset = 1; });
  const focusIn = async () => {
    fr.classList.add('focus');
    if (s.reduced) { [pt, pb].forEach((p) => (p.style.strokeDashoffset = 0)); return; }
    await s.spring(0, 1, 'gentle', (v) => { pt.style.strokeDashoffset = 1 - v; pb.style.strokeDashoffset = 1 - U2.clamp(v * 0.97); });
    meet.animate([{ opacity: 1, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(3)' }], { duration: 600, easing: 'ease-out' });
  };
  const focusOut = () => { fr.classList.remove('focus'); s.tween(260, (v) => [pt, pb].forEach((p) => (p.style.strokeDashoffset = v))); };
  inp.addEventListener('focus', focusIn); inp.addEventListener('blur', focusOut);
  if (s.reduced) { go(2); bell.classList.add('has'); focusIn(); return; }
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(300); ptr.show();
    for (const i of [2, 4, 1]) { await ptr.to(tabs[i], 0.5, 0.65); await ptr.click(); go(i); await s.wait(i === 1 ? 250 : 520); }
    await ptr.to(bell, 0.6, 0.7); await ptr.click(); ring(); await s.wait(900);
    await ptr.to(inp, 0.3, 0.6); await ptr.click(); focusIn();
    await s.wait(700);
    for (const ch of 'Move standup to 11') { inp.value += ch; await s.wait(38); }
    ptr.to([s.root.clientWidth + 30, s.root.clientHeight + 30]).then(() => ptr.hide());
  })();
});
