/* 10 · Thread button / twist toggle / tie checkbox. All three are real, clickable controls. */
U2.define('microa', (s) => {
  // Thread button: a thread across the bottom with spring sag.
  const buttons = s.$$('.tb').map((b) => {
    const path = b.querySelector('.tb-thread'), bead = b.querySelector('.tb-bead');
    const sag = new U2.Spring(2.6, 'pluck'), bx = new U2.Spring(0.12, 'soft');
    const st = { b, sag, bx, hover: false };
    const draw = () => {
      const w = b.clientWidth, h = b.clientHeight, x0 = 14, x1 = w - 14, y = h - 7;
      const mx = U2.lerp(x0, x1, 0.5);
      path.setAttribute('d', `M${x0} ${y} Q${mx} ${y + sag.x * 2} ${x1} ${y}`);
      const t = bx.x, bxp = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1, byp = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y + sag.x * 2) + t * t * y;
      bead.setAttribute('cx', bxp); bead.setAttribute('cy', byp);
    };
    st.enter = () => { st.hover = true; b.classList.add('hover'); sag.to(0); bx.to(0.5); };
    st.leave = () => { st.hover = false; b.classList.remove('hover', 'down'); sag.to(2.6); bx.to(0.12); };
    st.down = () => { b.classList.add('down'); sag.to(5.5); };
    st.up = () => { b.classList.remove('down'); sag.to(st.hover ? 0 : 2.6); sag.kick(-60); };
    b.addEventListener('pointerenter', st.enter); b.addEventListener('pointerleave', st.leave);
    b.addEventListener('pointerdown', st.down); b.addEventListener('pointerup', st.up);
    s.loop((dt) => { sag.step(dt); bx.step(dt); draw(); });
    draw();
    return st;
  });
  const toggles = s.$$('.tw');
  const flip = (t) => { const on = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', on); t.classList.add('flip'); s.after(260, () => t.classList.remove('flip')); };
  toggles.forEach((t) => t.addEventListener('click', (e) => { e.preventDefault(); flip(t); }));
  const rows = s.$$('.tc-row');
  const tick = (row) => { const box = row.querySelector('.tie-box'), on = !box.classList.contains('on'); box.classList.toggle('on', on); row.classList.toggle('on', on); U2.tie(s, box.querySelector('path'), on); };
  rows.forEach((r) => r.addEventListener('click', (e) => { e.preventDefault(); tick(r); }));
  if (s.reduced) { flip(toggles[0]); tick(rows[0]); return; }
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(300); ptr.show();
    const b = buttons[0];
    await ptr.to(b.b, 0.6, 0.6); b.enter(); await s.wait(420);
    b.down(); ptr.el.classList.add('down'); await s.wait(260); ptr.el.classList.remove('down'); b.up(); ptr.click(); await s.wait(450);
    b.leave();
    const g = buttons[1]; await ptr.to(g.b, 0.6, 0.6); g.enter(); await s.wait(380); g.leave();
    await ptr.to(toggles[0], 0.5, 0.6); await ptr.click(); flip(toggles[0]); await s.wait(520);
    await ptr.to(toggles[1], 0.5, 0.6); await ptr.click(); flip(toggles[1]); await s.wait(450);
    for (const r of rows.slice(0, 2)) { await ptr.to(r.querySelector('.tie-box')); await ptr.click(); tick(r); await s.wait(420); }
    ptr.to([s.root.clientWidth + 30, s.root.clientHeight + 30]).then(() => ptr.hide());
  })();
});
