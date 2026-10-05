(function () {
  const run = (sc, el) => {
    const root = el.querySelector('.er'), [t, s] = el.querySelectorAll('.er-t .m-swap'), btn = el.querySelector('.er-btn');
    const ptr = U2.pointer(sc, el);
    UM.cycle(sc, async () => {
      root.classList.remove('bad', 'ok', 'retry'); t.textContent = 'Syncing Gmail'; s.textContent = 'Reading new mail'; btn.style.opacity = 0;
      if (sc.reduced) { root.classList.add('bad'); t.textContent = "Couldn't reach Gmail"; s.textContent = 'The token expired 2 min ago.'; btn.textContent = 'Retry'; btn.style.opacity = 1; return; }
      await sc.wait(1200);
      root.classList.add('bad'); UM.swap(sc, t, "Couldn't reach Gmail"); UM.swap(sc, s, 'The token expired 2 min ago.'); btn.textContent = 'Retry'; btn.style.opacity = 1;
      await sc.wait(1800);
      const r = el.getBoundingClientRect(); ptr.at(r.width * .9, r.height + 20).show();
      await ptr.to(btn); await sc.wait(200); btn.classList.add('press'); await ptr.click(); btn.classList.remove('press');
      root.classList.add('retry'); UM.swap(sc, btn, 'Retrying'); ptr.to([r.width * .9, r.height * .95]); ptr.hide();
      await sc.wait(1400);
      root.classList.remove('bad', 'retry'); root.classList.add('ok');
      UM.swap(sc, t, 'Gmail reconnected'); UM.swap(sc, s, '14 new messages'); await sc.wait(300); btn.style.opacity = 0;
      await sc.wait(2600);
    }, 300);
  };
  UM.register('minimal-quiet', 'state.error', run);
  UM.register('minimal-dot', 'state.error', run);
})();
