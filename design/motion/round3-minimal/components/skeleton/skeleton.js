(function () {
  const ROWS = [['P', 'Priya: retention review', 'Wants to move it to Thursday', 0], ['E', 'Ensemble: weekly digest ready', '14 threads summarized', 1], ['A', 'Akash: PR #42 needs review', 'hub-api · 3 files', 0]];
  const run = (sc, el) => {
    const root = el.querySelector('.sk'), real = el.querySelector('.sk-real');
    real.innerHTML = ROWS.map(([a, t, s, ag]) => `<div class="rr"><i class="av${ag ? ' ag' : ''}">${a}</i><div><b>${t}</b><span>${s}</span></div></div>`).join('');
    UM.cycle(sc, async () => {
      if (sc.reduced) { root.classList.add('done'); return; }
      root.classList.remove('done'); await sc.wait(3600); root.classList.add('done'); await sc.wait(2800);
    }, 0);
  };
  UM.register('minimal-quiet', 'content.skeleton', run);
  UM.register('minimal-dot', 'content.skeleton', run);
})();
