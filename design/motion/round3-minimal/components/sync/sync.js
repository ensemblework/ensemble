(function () {
  const TOT = [2269, 38, 146, 512];
  const quiet = (sc, el) => {
    const root = el.querySelector('.sy'), paths = [...el.querySelectorAll('.sy-lines path')], beads = [...el.querySelectorAll('.sy-beads circle')];
    const ns = [...el.querySelectorAll('text.n')], st = el.querySelector('.sy-st');
    const L = paths.map((p) => p.getTotalLength());
    UM.cycle(sc, async () => {
      root.classList.remove('done'); ns.forEach((n) => (n.textContent = '0')); st.textContent = 'Syncing 4 sources';
      if (sc.reduced) { ns.forEach((n, i) => (n.textContent = TOT[i].toLocaleString())); root.classList.add('done'); st.textContent = 'Synced · just now'; return; }
      let T = 0; const DUR = 6.4;
      await new Promise((res) => sc.loop((dt) => {
        T += dt;
        beads.forEach((b, i) => {
          const ph = ((T * 0.62 + i * 0.27) % 1), e = UM.drift(ph), pt = paths[i].getPointAtLength(e * L[i]);
          b.setAttribute('cx', pt.x); b.setAttribute('cy', pt.y);
          b.style.opacity = T > DUR - .6 ? Math.max(0, (DUR - T) / .6) * Math.sin(Math.PI * ph) : Math.sin(Math.PI * ph);
          ns[i].textContent = Math.round(TOT[i] * UM.calm(Math.min(1, T / (DUR - 1 - i * .3)))).toLocaleString();
        });
        if (T >= DUR) { res(); return false; }
      }));
      root.classList.add('done'); await UM.swap(sc, st, 'Synced · just now'); await sc.wait(2400);
    }, 300);
  };
  const dot = (sc, el) => {
    const rows = [...el.querySelectorAll('.sy-r')], st = el.querySelector('.sy-st');
    UM.cycle(sc, async () => {
      rows.forEach((r) => { r.classList.remove('done'); r.querySelector('.n').textContent = '0'; }); st.textContent = 'Syncing 4 sources';
      if (sc.reduced) { rows.forEach((r, i) => { r.classList.add('done'); r.querySelector('.n').textContent = TOT[i].toLocaleString(); }); st.textContent = 'Synced · just now'; return; }
      const ends = [5.2, 2.2, 3.6, 4.4];
      let T = 0;
      await new Promise((res) => sc.loop((dt) => {
        T += dt;
        rows.forEach((r, i) => { r.querySelector('.n').textContent = Math.round(TOT[i] * UM.calm(Math.min(1, T / ends[i]))).toLocaleString(); if (T >= ends[i]) r.classList.add('done'); });
        if (T >= 5.6) { res(); return false; }
      }));
      await UM.swap(sc, st, 'Synced · just now'); await sc.wait(2400);
    }, 300);
  };
  UM.register('minimal-quiet', 'connector.sync', quiet);
  UM.register('minimal-dot', 'connector.sync', dot);
})();
