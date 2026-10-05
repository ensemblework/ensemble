/* brand.splash, Quiet + Dot (round 5): both end on the Two-voices mark, never on a different mark.
   Quiet: the agent strand draws, then the you strand, calm easing. Dot: two dots arrive at the arm tops and each draws its strand. */
(function () {
  const prep = (paths) => paths.forEach((p) => { p.setAttribute('pathLength', '1'); p.style.strokeDasharray = '1'; p.style.strokeDashoffset = '1'; p.style.opacity = ''; });
  const quiet = (sc, el) => {
    const root = el.querySelector('.sp'), [o, i] = el.querySelectorAll('.sp-u path');
    UM.cycle(sc, async () => {
      root.classList.remove('on'); prep([o, i]);
      if (sc.reduced) { [o, i].forEach((p) => (p.style.strokeDashoffset = 0)); root.classList.add('on'); return; }
      await sc.wait(400);
      UM.draw(sc, o, 1300, UM.calm); await sc.wait(240); await UM.draw(sc, i, 1200, UM.calm);
      root.classList.add('on'); await sc.wait(3200);
      root.classList.remove('on'); await sc.tween(600, (p) => { o.style.opacity = i.style.opacity = 1 - p; }, UM.enter);
    }, 400);
  };
  const dot = (sc, el) => {
    const root = el.querySelector('.sp'), [o, i] = el.querySelectorAll('.sp-u path'), [a, b] = el.querySelectorAll('.sp-dot');
    UM.cycle(sc, async () => {
      root.classList.remove('on'); prep([o, i]);
      if (sc.reduced) { [o, i].forEach((p) => (p.style.strokeDashoffset = 0)); a.style.opacity = b.style.opacity = 0; root.classList.add('on'); return; }
      a.style.opacity = b.style.opacity = 0;
      await sc.wait(400);
      await sc.tween(600, (p) => { a.style.opacity = p; a.setAttribute('cy', 300 - 90 * (1 - p)); }, UM.enter);
      await sc.tween(600, (p) => { b.style.opacity = p; b.setAttribute('cy', 300 - 90 * (1 - p)); }, UM.enter);
      await sc.wait(160);
      // each dot becomes the head of its strand: the strand draws from the dot, the dot hands over to the round cap
      UM.draw(sc, o, 1000, UM.calm); await sc.wait(160); await UM.draw(sc, i, 900, UM.calm);
      await sc.tween(300, (p) => { a.style.opacity = b.style.opacity = 1 - p; }, UM.enter);
      root.classList.add('on'); await sc.wait(3200);
      root.classList.remove('on'); await sc.tween(600, (p) => { o.style.opacity = i.style.opacity = 1 - p; }, UM.enter);
    }, 400);
  };
  UM.register('minimal-quiet', 'brand.splash', quiet);
  UM.register('minimal-dot', 'brand.splash', dot);
})();
