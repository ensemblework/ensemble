(function () {
  const mk = (dot) => (sc, el) => {
    const bar = el.querySelector(dot ? '.pp-dot' : '.pp-bar'), c = el.querySelector('.pp-c'), main = el.querySelector('.pp-main');
    const side = [...el.querySelectorAll('.pp-side b')];
    const set = (v, o = 1) => {
      if (dot) { bar.style.transform = `translateX(${v * (main.clientWidth - 17)}px)`; bar.style.opacity = o; }
      else { bar.style.transform = `scaleX(${v})`; bar.style.opacity = o; }
    };
    let k = 1;
    UM.cycle(sc, async () => {
      if (sc.reduced) { c.classList.add('on'); set(1, 0); return; }
      c.classList.remove('on'); set(0, 1);
      side.forEach((b, i) => b.classList.toggle('on', i === k));
      el.querySelector('h4').textContent = side[k].textContent;
      let v = 0;
      await sc.tween(500, (p) => set((v = .32 * p)), UM.calm);
      await sc.tween(1100, (p) => set((v = .32 + .38 * p)), UM.calm);
      await sc.tween(900, (p) => set((v = .70 + .14 * p)), UM.calm);
      await sc.tween(360, (p) => set(.84 + .16 * p), UM.calm);
      c.classList.add('on');
      await sc.tween(420, (p) => set(1, 1 - p), UM.enter);
      await sc.wait(2200); k = (k + 1) % side.length;
    }, 300);
  };
  UM.register('minimal-quiet', 'page.progress', mk(false));
  UM.register('minimal-dot', 'page.progress', mk(true));
})();
