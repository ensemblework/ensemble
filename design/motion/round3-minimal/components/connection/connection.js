(function () {
  const run = (sc, el) => {
    const root = el.querySelector('.cn'), [lbl] = el.querySelectorAll('.cn-pill .m-swap'), m = el.querySelector('.cn-m');
    UM.cycle(sc, async () => {
      root.classList.remove('re', 'on', 'fade'); lbl.textContent = 'Offline'; m.textContent = 'changes saved locally';
      if (sc.reduced) { root.classList.add('on'); lbl.textContent = 'Back online'; m.textContent = '3 changes synced'; return; }
      await sc.wait(2200); root.classList.add('re'); UM.swap(sc, lbl, 'Reconnecting'); UM.swap(sc, m, 'attempt 2');
      await sc.wait(2600); root.classList.remove('re'); root.classList.add('on'); UM.swap(sc, lbl, 'Back online'); UM.swap(sc, m, '3 changes synced');
      await sc.wait(2400); root.classList.add('fade'); await sc.wait(1200);
    }, 200);
  };
  UM.register('minimal-quiet', 'net.connection', run);
  UM.register('minimal-dot', 'net.connection', run);
})();
