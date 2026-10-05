/* 13 · Ambient logo + theme toggle: a strand sun morphs into a strand moon; the new theme washes in from the button. */
U2.define('ambient', (s, card) => {
  const body = s.$('.am-body'), raysG = s.$('.am-rays'), stars = s.$$('.am-stars path'), btn = s.$('.am-toggle'), wash = s.$('.am-wash'), mode = s.$('.am-mode');
  const N = 72;
  const SUN = Array.from({ length: N }, (_, i) => { const a = -Math.PI / 2 + (i / N) * Math.PI * 2; return [12 + 4.6 * Math.cos(a), 12 + 4.6 * Math.sin(a)]; });
  const MOON = U2.samplePath('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z', N + 1).slice(0, N);
  Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return U2.el('line', { x1: 12 + Math.cos(a) * 7.6, y1: 12 + Math.sin(a) * 7.6, x2: 12 + Math.cos(a) * 10.4, y2: 12 + Math.sin(a) * 10.4 }, raysG); });
  const app = s.$('.am');
  app.dataset.theme = card.dataset.theme || 'dark';
  const theme = () => app.dataset.theme;
  const swap = (t) => { app.classList.add('no-tr'); app.dataset.theme = t; void app.offsetWidth; requestAnimationFrame(() => app.classList.remove('no-tr')); };
  const pose = (m) => { // m: 0 = sun (light), 1 = moon (dark)
    body.setAttribute('d', U2.catmull(U2.lerpPts(SUN, MOON, m), true));
    raysG.style.transform = `rotate(${m * 60}deg) scale(${U2.clamp(1 - m * 1.1, 0, 1.2)})`;
    raysG.style.opacity = U2.clamp(1 - m * 1.4);
    stars.forEach((st, i) => { const k = U2.clamp((m - 0.55 - i * 0.12) / 0.35); st.style.transform = `scale(${k}) rotate(${k * 90}deg)`; st.style.opacity = k; });
  };
  let m = theme() === 'dark' ? 1 : 0; pose(m);
  mode.textContent = theme() === 'dark' ? 'Dark' : 'Light';
  let busy = false;
  const toggle = async () => {
    if (busy) return; busy = true;
    const next = theme() === 'dark' ? 'light' : 'dark';
    btn.classList.add('press'); s.after(140, () => btn.classList.remove('press'));
    s.spring(m, next === 'dark' ? 1 : 0, 'soft', (v) => { m = v; pose(v); });
    if (s.reduced) { swap(next); mode.textContent = next === 'dark' ? 'Dark' : 'Light'; busy = false; return; }
    const h = s.root.getBoundingClientRect(), r = btn.getBoundingClientRect();
    const cx = r.left - h.left + r.width / 2, cy = r.top - h.top + r.height / 2;
    wash.style.background = next === 'light' ? '#f4f1ea' : '#141210';
    wash.style.clipPath = `circle(0px at ${cx}px ${cy}px)`;
    wash.classList.add('go'); void wash.offsetWidth;
    wash.style.clipPath = `circle(${Math.hypot(h.width, h.height)}px at ${cx}px ${cy}px)`;
    await s.wait(700);
    swap(next); mode.textContent = next === 'dark' ? 'Dark' : 'Light';
    await s.tween(300, (p) => (wash.style.opacity = 1 - p));
    wash.classList.remove('go'); wash.style.opacity = ''; wash.style.clipPath = '';
    busy = false;
  };
  btn.addEventListener('click', toggle);
  if (s.reduced) return;
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(1800); ptr.show(); await ptr.to(btn, 0.6, 0.65); await ptr.click(); toggle();
    await s.wait(2300); await ptr.click(); toggle();
    await s.wait(900); ptr.to([s.root.clientWidth + 30, s.root.clientHeight]).then(() => ptr.hide());
  })();
});
