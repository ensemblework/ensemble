/* 02 · Inbox-zero tapestry: cleared cards become threads, threads weave a U. */
U2.define('tapestry', (s) => {
  const root = s.$('.tp');
  const U = [
    '...............',
    '.VV.P.....P.VV.',
    '.VV.P.....P.VV.',
    '.VV.P.....P.VV.',
    '.VV.P.....P.VV.',
    '.VV.P.....P.VV.',
    '.VV.P.....P.VV.',
    '..VV.P...P.VV..',
    '...VV.PPP.VV...',
    '.....VVVVV.....',
    '...............',
  ];
  const ROWS = U.length, COLS = 15, PER = 12; // ms per cell
  const grid = s.$('.tp-grid'), warps = s.$('.tp-warps'), fringe = s.$('.tp-fringe');
  for (let c = 0; c < COLS; c++) {
    warps.insertAdjacentHTML('beforeend', `<i style="--d:${c * 28}ms"></i>`);
    fringe.insertAdjacentHTML('beforeend', `<i style="--d:${-c * 170}ms"></i>`);
  }
  const base = 520; // after warps
  U.forEach((row, r) => [...row].forEach((ch, c) => {
    const ltr = r % 2 === 0, idx = ltr ? c : COLS - 1 - c;
    const over = (r + c) % 2 === 0;
    const k = ch === 'V' ? (over ? 'var(--u-agent)' : 'color-mix(in srgb, var(--u-agent) 86%, var(--bg))') : ch === 'P' ? (over ? 'var(--u-you)' : 'color-mix(in srgb, var(--u-you) 86%, var(--bg))')
      : over ? 'color-mix(in srgb, var(--ink) 13%, var(--bg))' : 'color-mix(in srgb, var(--ink) 9%, var(--bg))';
    grid.insertAdjacentHTML('beforeend', `<b class="${over ? 'w' : 'p'}" style="--k:${k};--o:${ltr ? 'left' : 'right'};--d:${base + (r * COLS + idx) * PER}ms"></b>`);
  }));
  const badge = s.$('.tp-badge'), num = badge.querySelector('b');
  if (s.reduced) {
    s.$('.tp-cards').style.display = 'none'; num.textContent = '0'; badge.classList.add('zero');
    root.classList.add('reduced', 'weave', 'hung'); return;
  }
  (async () => {
    const cards = s.$$('.tp-card');
    await s.wait(700);
    for (let i = 0; i < cards.length; i++) {
      cards[i].classList.add('ok');
      await s.wait(380);
      cards[i].classList.add('fold');
      const n = cards.length - 1 - i;
      num.textContent = n; num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      if (!n) badge.classList.add('zero');
      await s.wait(300);
    }
    await s.wait(420);
    s.$('.tp-cards').style.visibility = 'hidden';
    root.classList.add('weave');
    // shuttle follows the row being woven (boustrophedon)
    const sh = s.$('.tp-shuttle'); const cell = 13;
    let t = -base;
    const total = ROWS * COLS * PER;
    sh.style.opacity = 1;
    s.loop((dt) => {
      t += dt * 1000;
      if (t < 0) { sh.style.opacity = 0; return; }
      sh.style.opacity = 1;
      const k = Math.min(total - 1, t / PER), r = Math.floor(k / COLS), f = (k % COLS) / COLS;
      const x = (r % 2 === 0 ? f : 1 - f) * COLS * cell + (r % 2 === 0 ? 4 : cell - 4);
      sh.style.transform = `translate(${x}px, ${3 + r * cell + cell / 2}px)`;
      if (t > total + 60) { sh.style.opacity = 0; return false; }
    });
    await s.wait(base + total + 250);
    root.classList.add('hung');
  })();
});
