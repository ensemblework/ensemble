/* Gallery runtime: mounts each piece when it scrolls into view, Replay, per-card theme, reduce-motion, tour. */
(function () {
  const $$ = (q, r = document) => [...r.querySelectorAll(q)];
  const params = new URLSearchParams(location.search);
  if (params.has('reduced')) document.documentElement.dataset.reduceMotion = 'true';
  if (params.has('light')) $$('.card').forEach((c) => (c.dataset.theme = 'light'));
  const cards = $$('.card[data-piece]');
  cards.forEach((card) => {
    const stage = card.querySelector('.stage');
    const tpl = stage.innerHTML;
    let sc = null;
    card.__mount = () => {
      if (sc) sc.dispose();
      stage.innerHTML = tpl;
      sc = U2.scene(stage);
      card.__mounted = true;
      const fn = U2.pieces[card.dataset.piece];
      try { fn && fn(sc, card); } catch (e) { console.error(card.dataset.piece, e); }
    };
    const rb = card.querySelector('.c-replay');
    rb && rb.addEventListener('click', () => { rb.classList.remove('spin'); void rb.offsetWidth; rb.classList.add('spin'); card.__mount(); });
    const tb = card.querySelector('.c-theme');
    tb && tb.addEventListener('click', () => { card.dataset.theme = card.dataset.theme === 'light' ? 'dark' : 'light'; card.__mount(); });
  });
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    const card = e.target, stage = card.querySelector('.stage');
    stage.__u2hidden = !e.isIntersecting;
    if (e.intersectionRatio >= 0.35 && !card.__mounted && !window.__touring) card.__mount();
  }), { threshold: [0, 0.35] });
  cards.forEach((c) => io.observe(c));

  const rm = document.getElementById('g-reduce');
  const syncRm = () => rm && rm.setAttribute('aria-pressed', document.documentElement.dataset.reduceMotion === 'true');
  syncRm();
  rm && rm.addEventListener('click', () => {
    const on = document.documentElement.dataset.reduceMotion !== 'true';
    document.documentElement.dataset.reduceMotion = on ? 'true' : 'false';
    syncRm(); cards.forEach((c) => c.__mounted && c.__mount());
  });
  const th = document.getElementById('g-theme');
  th && th.addEventListener('click', () => {
    const light = th.getAttribute('aria-pressed') !== 'true';
    th.setAttribute('aria-pressed', light);
    cards.forEach((c) => { c.dataset.theme = light ? 'light' : 'dark'; c.__mounted && c.__mount(); });
  });
  const replayAll = document.getElementById('g-replay');
  replayAll && replayAll.addEventListener('click', () => cards.forEach((c) => c.__mounted && c.__mount()));

  /* springs strip */
  $$('.tok').forEach((t) => {
    const lane = t.querySelector('.lane');
    const run = () => { lane.classList.remove('go'); lane.style.setProperty('--w', lane.clientWidth + 'px'); void lane.offsetWidth; lane.classList.add('go'); };
    t.addEventListener('click', run); t.__run = run;
  });
  const tokRun = () => $$('.tok').forEach((t) => t.__run());
  const tio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { tokRun(); } }), { threshold: .6 });
  const tg = document.querySelector('.g-tokens'); tg && tio.observe(tg);

  /* ?tour: scripted walk-through for the video. ?tour&dwell=ms */
  if (params.has('tour')) {
    window.__touring = true;
    const dwell = +params.get('dwell') || 4200;
    const spec = params.get('tour') === 'highlights' ? document.body.dataset.tourHighlights : document.body.dataset.tour;
    const steps = spec.split(';').map((st) => { const [ids, ms] = st.split('@'); return { ids: ids.split(','), ms: +ms || 0 }; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      window.scrollTo(0, 0);
      for (const st of steps) {
        const els = st.ids.map((id) => document.getElementById(id)).filter(Boolean);
        if (!els.length) continue;
        const top = Math.min(...els.map((e) => e.getBoundingClientRect().top + scrollY));
        const bottom = Math.max(...els.map((e) => e.getBoundingClientRect().bottom + scrollY));
        const y = Math.max(0, (top + bottom) / 2 - innerHeight / 2 + 20);
        if (Math.abs(y - scrollY) > 4) { window.scrollTo({ top: y, behavior: 'smooth' }); await sleep(650); }
        els.forEach((e) => e.__mount && e.__mount());
        await sleep(st.ms || Math.max(...els.map((e) => +e.dataset.dwell || dwell)));
      }
      window.__tourDone = true;
    };
    addEventListener('load', () => setTimeout(run, 300));
  }
})();
