/* Round 3 gallery runtime: lazy mount, replay, per-card theme, flavour filter, reduce motion, suite switcher, tour. */
(function () {
  const $ = (q, r = document) => r.querySelector(q), $$ = (q, r = document) => [...r.querySelectorAll(q)];
  const params = new URLSearchParams(location.search);
  if (params.has('reduced')) document.documentElement.dataset.reduceMotion = 'true';
  const cards = $$('.card[data-piece]');
  if (params.has('light')) cards.forEach((c) => (c.dataset.theme = 'light'));
  cards.forEach((card) => {
    const panes = $$('.pane', card), tpls = panes.map((p) => p.innerHTML);
    let scs = [];
    card.__mount = () => {
      scs.forEach((s) => s.dispose());
      panes.forEach((p, i) => (p.innerHTML = tpls[i]));
      scs = panes.map((p) => UM.mount(p));
      card.__mounted = true;
    };
    const rb = $('.c-replay', card);
    rb.addEventListener('click', () => { rb.classList.remove('spin'); void rb.offsetWidth; rb.classList.add('spin'); card.__mount(); });
    $('.c-theme', card).addEventListener('click', () => { card.dataset.theme = card.dataset.theme === 'light' ? 'dark' : 'light'; card.__mount(); });
    $('.c-cmp', card).addEventListener('click', () => { pickSlot(card.dataset.piece); $('#s-suite').scrollIntoView({ behavior: 'smooth' }); });
  });
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    const card = e.target; $$('.pane', card).forEach((p) => (p.__u2hidden = !e.isIntersecting));
    if (e.intersectionRatio >= 0.3 && !card.__mounted && !window.__touring) card.__mount();
  }), { threshold: [0, 0.3] });
  cards.forEach((c) => io.observe(c));
  const remountAll = () => { cards.forEach((c) => c.__mounted && c.__mount()); cmpMount(); };
  /* header controls */
  const rm = $('#g-reduce'), rmBox = $('#st-reduce');
  const setReduce = (on) => { document.documentElement.dataset.reduceMotion = on ? 'true' : 'false'; rm.setAttribute('aria-pressed', on); rmBox.checked = on; code(); remountAll(); };
  rm.setAttribute('aria-pressed', document.documentElement.dataset.reduceMotion === 'true'); rmBox.checked = document.documentElement.dataset.reduceMotion === 'true';
  rm.addEventListener('click', () => setReduce(document.documentElement.dataset.reduceMotion !== 'true'));
  rmBox.addEventListener('change', () => setReduce(rmBox.checked));
  const th = $('#g-theme');
  th.addEventListener('click', () => { const l = th.getAttribute('aria-pressed') !== 'true'; th.setAttribute('aria-pressed', l); cards.forEach((c) => (c.dataset.theme = l ? 'light' : 'dark')); $$('.cmp-stage[data-theme]').forEach((s) => (s.dataset.theme = l ? 'light' : 'dark')); remountAll(); });
  $('#g-replay').addEventListener('click', remountAll);
  $$('.seg button').forEach((b) => b.addEventListener('click', () => { document.body.dataset.show = b.dataset.show; $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  /* suite switcher */
  const CMP = window.__CMP, ifr = $('.cmp-if'), ref = $('.cmp-ref'), foot = $('#cmp-foot');
  const cq = $('.cmp-col[data-col="minimal-quiet"] .pane'), cd = $('.cmp-col[data-col="minimal-dot"] .pane');
  let cur = null, cs = [];
  const cmpMount = () => {
    if (!cur) return; const d = CMP[cur];
    cs.forEach((s) => s.dispose());
    [[cq, d.q], [cd, d.d]].forEach(([p, h]) => { p.dataset.motionSlot = d.slot; p.innerHTML = h; });
    cs = [UM.mount(cq), UM.mount(cd)];
  };
  const pickSlot = (id) => {
    cur = id; const d = CMP[id];
    $$('.sl').forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === id));
    const [round, anchor] = d.cmp, src = `compare/expressive-${round}.html#${anchor}`;
    ifr.setAttribute('src', src);
    ref.textContent = `${round === 'r1' ? 'round 1' : 'round 2'} · ${anchor}`;
    foot.textContent = `slot "${d.slot}" · same markup contract, three implementations · fallback: minimal-dot → minimal-quiet → expressive`;
    cmpMount(); code();
  };
  $$('.sl').forEach((b) => b.addEventListener('click', () => pickSlot(b.dataset.id)));
  function code() {
    const t = document.documentElement.dataset.motionTheme, r = document.documentElement.dataset.reduceMotion === 'true';
    $('#st-code').textContent = `<html data-motion-theme="${t}"${r ? '\n      data-reduce-motion="true"' : ''}>\n\n<div data-motion-slot="${cur ? CMP[cur].slot : 'agent.thinking'}">`;
    $$('.cmp-col').forEach((c) => c.classList.toggle('pick', c.dataset.col === t));
  }
  code();
  $$('input[name="mt"]').forEach((r) => r.addEventListener('change', () => { document.documentElement.dataset.motionTheme = r.value; code(); }));
  const sio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && !cur && !window.__touring) { pickSlot('thinking'); } }), { threshold: 0.2 });
  sio.observe($('#s-suite'));
  window.__pickSlot = pickSlot;
  /* ?tour=highlights: scripted walk-through for the video */
  if (params.has('tour')) {
    window.__touring = true;
    const steps = document.body.dataset.tourHighlights.split(';').map((st) => { const [ids, ms] = st.split('@'); return { ids: ids.split(','), ms: +ms || 4000 }; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      scrollTo(0, 0); await sleep(1400);
      for (const st of steps) {
        if (st.ids[0].startsWith('cmp:')) {
          const s = $('#s-suite'); scrollTo({ top: s.getBoundingClientRect().top + scrollY - 64, behavior: 'smooth' }); await sleep(700);
          pickSlot(st.ids[0].slice(4)); await sleep(st.ms); continue;
        }
        const els = st.ids.map((id) => document.getElementById(id)).filter(Boolean);
        const top = Math.min(...els.map((e) => e.getBoundingClientRect().top + scrollY)), bottom = Math.max(...els.map((e) => e.getBoundingClientRect().bottom + scrollY));
        const y = Math.max(0, (top + bottom) / 2 - innerHeight / 2 + 28);
        scrollTo({ top: y, behavior: 'smooth' }); await sleep(550);
        els.forEach((e) => e.__mount()); await sleep(st.ms);
      }
      window.__tourDone = true;
    };
    addEventListener('load', () => setTimeout(run, 300));
  }
})();
