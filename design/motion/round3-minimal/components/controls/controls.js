(function () {
  const run = (sc, el) => {
    const dot = !!el.querySelector('.ct.dotf');
    const btn = el.querySelector('.ct-btn'), tg = el.querySelector('.ct-tg'), cb = el.querySelector('.ct-cb button'), tabs = [...el.querySelectorAll('.ct-tabs button')];
    const ind = el.querySelector('.ct-ind'), inp = el.querySelector('.ct-in input'), inw = el.querySelector('.ct-in');
    const flip = (b) => b.setAttribute('aria-checked', b.getAttribute('aria-checked') !== 'true');
    const placeInd = (t) => { const x = t.offsetLeft, w = t.offsetWidth; ind.style.transform = dot ? `translateX(${x + w / 2 - 2}px)` : `translateX(${x + 10}px) scaleX(${(w - 20) / 10})`; };
    const pick = (t) => { tabs.forEach((b) => b.classList.toggle('on', b === t)); placeInd(t); };
    ind.style.transition = 'none'; placeInd(tabs[0]); void ind.offsetWidth; ind.style.transition = '';
    tg.onclick = () => flip(tg); cb.onclick = (e) => { e.preventDefault(); flip(cb); }; el.querySelector('.ct-cb span').onclick = () => flip(cb);
    tabs.forEach((t) => (t.onclick = () => pick(t)));
    if (sc.reduced) { tg.setAttribute('aria-checked', 'true'); cb.setAttribute('aria-checked', 'true'); pick(tabs[1]); return; }
    const ptr = U2.pointer(sc, el);
    const typeIn = async (s) => { inp.value = ''; for (const ch of s) { inp.value += ch; await sc.wait(55); } };
    UM.cycle(sc, async () => {
      tg.setAttribute('aria-checked', 'false'); cb.setAttribute('aria-checked', 'false'); pick(tabs[0]); inp.value = ''; inw.classList.remove('foc');
      const r = el.getBoundingClientRect(); ptr.at(r.width * .7, r.height + 20).show();
      await sc.wait(300); await ptr.to(btn); btn.classList.add('hov'); await sc.wait(500); btn.classList.add('press'); await ptr.click(); btn.classList.remove('press'); await sc.wait(300); btn.classList.remove('hov');
      await ptr.to(tg); await sc.wait(150); await ptr.click(); flip(tg); await sc.wait(700);
      await ptr.to(cb); await sc.wait(150); await ptr.click(); flip(cb); await sc.wait(700);
      for (const k of [1, 2]) { await ptr.to(tabs[k]); await sc.wait(120); await ptr.click(); pick(tabs[k]); await sc.wait(650); }
      await ptr.to(inw, .3, .5); await ptr.click(); inw.classList.add('foc'); ptr.to([r.width * .85, r.height * .92]); ptr.hide();
      await typeIn('Move standup to 11'); await sc.wait(1600);
    }, 900);
  };
  UM.register('minimal-quiet', 'control.*', run);
  UM.register('minimal-dot', 'control.*', run);
})();
