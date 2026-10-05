(function () {
  const run = (sc, el) => {
    const root = el.querySelector('.ce'), cb = el.querySelector('.ct-cb button'), n = el.querySelector('.ce-n'), u = [...el.querySelectorAll('.ce-mk .qu path')];
    const ptr = U2.pointer(sc, el);
    UM.cycle(sc, async () => {
      root.classList.remove('gone', 'on'); cb.setAttribute('aria-checked', 'false'); n.textContent = '12';
      u.forEach((p) => { p.setAttribute('pathLength', '1'); p.style.strokeDasharray = '1'; p.style.strokeDashoffset = '1'; });
      if (sc.reduced) { root.classList.add('gone', 'on'); u.forEach((p) => (p.style.strokeDashoffset = 0)); n.textContent = '13'; return; }
      const r = el.getBoundingClientRect(); ptr.at(r.width * .8, r.height + 20).show();
      await sc.wait(500); await ptr.to(cb); await sc.wait(200); await ptr.click(); cb.setAttribute('aria-checked', 'true');
      ptr.to([r.width * .8, r.height * .95]); ptr.hide(); await sc.wait(700);
      root.classList.add('gone'); await sc.wait(300);
      if (u.length) { UM.draw(sc, u[0], 1100, UM.calm); await sc.wait(200); await UM.draw(sc, u[1], 1000, UM.calm); } else await sc.wait(700);
      root.classList.add('on'); await sc.wait(900); await UM.swap(sc, n, '13');
      await sc.wait(3000);
    }, 300);
  };
  UM.register('minimal-quiet', 'moment.celebrate', run);
  UM.register('minimal-dot', 'moment.celebrate', run);
})();
