(function () {
  const run = (sc, el) => {
    const root = el.querySelector('.nw'), bar = el.querySelector('.nw-time i'), cd = el.querySelector('.nw-cd');
    UM.cycle(sc, async () => {
      root.classList.remove('on'); bar.style.transform = 'scaleX(1)';
      if (sc.reduced) { root.classList.add('on'); bar.style.transform = 'scaleX(.8)'; cd.textContent = 'auto-snooze 8:00'; return; }
      await sc.wait(500); root.classList.add('on'); await sc.wait(600);
      await sc.tween(9000, (p) => { bar.style.transform = `scaleX(${1 - p * .35})`; const s = Math.round(581 - p * 210); cd.textContent = `auto-snooze ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, (x) => x);
    }, 400);
  };
  UM.register('minimal-quiet', 'needs.waiting', run);
  UM.register('minimal-dot', 'needs.waiting', run);
})();
