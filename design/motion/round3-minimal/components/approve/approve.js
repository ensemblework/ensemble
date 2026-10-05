(function () {
  const run = (sc, el) => {
    const root = el.querySelector('.ap'), ok = el.querySelector('.ap-ok'), lbl = ok.querySelector('.m-swap');
    const ptr = U2.pointer(sc, el);
    UM.cycle(sc, async () => {
      root.classList.remove('ok', 'gone'); lbl.textContent = 'Approve';
      if (sc.reduced) { root.classList.add('ok'); lbl.textContent = 'Approved'; return; }
      const r = el.getBoundingClientRect(); ptr.at(r.width * .85, r.height + 20).show();
      await sc.wait(700); await ptr.to(ok, .5, .6); await sc.wait(250);
      ok.classList.add('press'); await ptr.click(); await sc.wait(80); ok.classList.remove('press');
      root.classList.add('ok'); UM.swap(sc, lbl, 'Approved');
      await sc.wait(500); ptr.to([r.width * .8, r.height * .9]); ptr.hide();
      await sc.wait(900); root.classList.add('gone'); await sc.wait(2600);
    }, 300);
  };
  UM.register('minimal-quiet', 'action.approve', run);
  UM.register('minimal-dot', 'action.approve', run);
})();
