/* 08 · Context graph: nodes bloom in BFS order, needles knit the edges, selection ripples to neighbours. */
U2.define('graph', (s) => {
  const root = s.$('.gr'), EG = s.$('.gr-edges'), NG = s.$('.gr-nodes'), FX = s.$('.gr-fx');
  const K = { people: '#e7a08a', project: '#7eb8c9', repo: '#8fbf9f', task: '#e0b15a', skill: '#d4c07a', deliv: '#c9a4e0' };
  const N = [
    ['me', 325, 178, 'you', 'You + Ensemble', 21], ['priya', 196, 108, 'people', 'Priya'], ['ret', 452, 104, 'project', 'Retention'],
    ['api', 468, 246, 'repo', 'hub-api'], ['pr', 190, 252, 'task', 'PR #42'], ['akash', 86, 62, 'people', 'Akash'],
    ['macro', 70, 176, 'skill', 'Support macro'], ['priv', 568, 44, 'deliv', 'Privacy page'], ['log', 590, 166, 'task', 'Changelog'],
    ['ci', 572, 300, 'repo', 'CI'], ['q3', 330, 318, 'deliv', 'Q3 plan'], ['dr', 316, 36, 'task', 'Design review'],
  ];
  const E = [['me', 'priya'], ['me', 'ret'], ['me', 'api'], ['me', 'pr'], ['priya', 'akash'], ['priya', 'macro'], ['ret', 'priv'], ['ret', 'log'],
    ['api', 'ci'], ['pr', 'q3'], ['me', 'dr'], ['priya', 'ret', 1], ['pr', 'api', 1], ['api', 'log', 1]];
  const nodes = {};
  N.forEach(([id, x, y, kind, label, r]) => { nodes[id] = { id, x, y, kind, label, r: r || (['priya', 'ret', 'api', 'pr', 'dr'].includes(id) ? 12 : 9), adj: [] }; });
  const edges = E.map(([a, b, cross]) => {
    const A = nodes[a], B = nodes[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    const c = [(A.x + B.x) / 2 - (dy / L) * L * 0.1, (A.y + B.y) / 2 + (dx / L) * L * 0.1];
    const e = { a, b, cross, c, el: U2.el('path', { class: 'gr-edge' }, EG) };
    A.adj.push([b, e]); B.adj.push([a, e]);
    return e;
  });
  const qpt = (A, c, B, t) => [(1 - t) ** 2 * A.x + 2 * (1 - t) * t * c[0] + t * t * B.x, (1 - t) ** 2 * A.y + 2 * (1 - t) * t * c[1] + t * t * B.y];
  const partial = (e, t, from) => { // de Casteljau split so the stitch grows from `from`
    const A = nodes[from], B = nodes[from === e.a ? e.b : e.a];
    const P0 = [A.x, A.y], P1 = e.c, P2 = [B.x, B.y];
    const q0 = [P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t], q1 = [P1[0] + (P2[0] - P1[0]) * t, P1[1] + (P2[1] - P1[1]) * t];
    const end = [q0[0] + (q1[0] - q0[0]) * t, q0[1] + (q1[1] - q0[1]) * t];
    return { d: `M${P0[0]} ${P0[1]} Q${q0[0]} ${q0[1]} ${end[0]} ${end[1]}`, end };
  };
  Object.values(nodes).forEach((n) => {
    const g = U2.el('g', { class: 'gr-node', transform: `translate(${n.x} ${n.y})`, style: `--k:${K[n.kind] || 'var(--u-agent)'}` }, NG);
    const nb = U2.el('g', { class: 'gr-nb' }, g);
    U2.el('circle', { class: 'petal', r: n.r }, nb);
    U2.el('circle', { class: 'sel', r: n.r + 6 }, g);
    if (n.kind === 'you') {
      U2.el('circle', { class: 'body', r: n.r, style: 'fill:var(--raised);stroke:var(--u-agent)' }, nb);
      const u = U2.el('g', { transform: 'scale(.034) translate(-512 -530)' }, nb);
      U2.el('path', { class: 'gr-u', d: U2.U_OUTER, stroke: 'var(--u-agent)', 'stroke-width': 84 }, u);
      U2.el('path', { class: 'gr-u', d: U2.U_INNER, stroke: 'var(--u-you)', 'stroke-width': 64 }, u);
    } else U2.el('circle', { class: 'body', r: n.r }, nb);
    U2.el('text', { y: n.r + 14 }, g).textContent = n.label;
    n.g = g;
    g.addEventListener('click', (ev) => { ev.stopPropagation(); focus(n.id); });
  });
  s.root.addEventListener('click', () => clear());
  // BFS depth
  const depth = { me: 0 }, parent = {}, q = ['me'];
  while (q.length) { const u = q.shift(); for (const [v, e] of nodes[u].adj) if (!(v in depth) && !e.cross) { depth[v] = depth[u] + 1; parent[v] = [u, e]; q.push(v); } }
  const full = (e) => { e.el.setAttribute('d', `M${nodes[e.a].x} ${nodes[e.a].y} Q${e.c[0]} ${e.c[1]} ${nodes[e.b].x} ${nodes[e.b].y}`); };
  const clear = () => { root.classList.remove('focus'); Object.values(nodes).forEach((n) => n.g.classList.remove('on', 'nb1')); edges.forEach((e) => e.el.classList.remove('lit')); };
  const focus = (id) => {
    clear(); const n = nodes[id];
    root.classList.add('focus'); n.g.classList.add('on');
    if (!s.reduced) ['var(--u-agent)', 'var(--u-you)'].forEach((col, i) => {
      const ring = U2.el('circle', { class: 'gr-ring', cx: n.x, cy: n.y, r: n.r, stroke: col }, FX);
      s.after(i * 140, () => s.tween(1000, (p) => { ring.setAttribute('r', n.r + p * 150); ring.style.opacity = (1 - p) * 0.6; }, U2.ease.out).then(() => ring.remove()));
    });
    n.adj.forEach(([v, e], i) => {
      e.el.classList.add('lit');
      const m = nodes[v];
      if (s.reduced) { m.g.classList.add('nb1'); return; }
      const bead = U2.el('circle', { r: 3.2, class: 'gr-needle' }, FX);
      const fromA = e.a === id;
      s.after(80 + i * 60, () => s.tween(460, (p) => { const t = fromA ? p : 1 - p; const [x, y] = qpt(nodes[e.a], e.c, nodes[e.b], t); bead.setAttribute('cx', x); bead.setAttribute('cy', y); }, U2.ease.inOut).then(() => {
        bead.remove(); m.g.classList.add('nb1'); m.g.classList.remove('hit'); void m.g.getBBox(); m.g.classList.add('hit');
      }));
    });
  };
  if (s.reduced) { root.classList.add('reduced'); Object.values(nodes).forEach((n) => n.g.classList.add('bloom')); edges.forEach((e) => { full(e); e.el.classList.add('tight'); }); return; }
  const STEP = 620, T0 = 250;
  Object.values(nodes).forEach((n) => {
    const at = T0 + depth[n.id] * STEP + (n.id.charCodeAt(0) % 5) * 40;
    s.after(at, () => n.g.classList.add('bloom'));
    if (parent[n.id]) {
      const [p, e] = parent[n.id];
      const needle = U2.el('circle', { r: 2.6, class: 'gr-needle', opacity: 0 }, FX);
      s.after(at - STEP + 180, () => { needle.setAttribute('opacity', 1); s.tween(STEP - 180, (t) => { const r = partial(e, t, p); e.el.setAttribute('d', r.d); needle.setAttribute('cx', r.end[0]); needle.setAttribute('cy', r.end[1]); }, U2.ease.inOut).then(() => { needle.remove(); full(e); s.after(200, () => e.el.classList.add('tight')); }); });
    }
  });
  const T1 = T0 + 2 * STEP + 400;
  edges.filter((e) => e.cross).forEach((e, i) => s.after(T1 + i * 160, () => { const nd = U2.el('circle', { r: 2.6, class: 'gr-needle' }, FX); s.tween(520, (t) => { const r = partial(e, t, e.a); e.el.setAttribute('d', r.d); nd.setAttribute('cx', r.end[0]); nd.setAttribute('cy', r.end[1]); }, U2.ease.inOut).then(() => { nd.remove(); full(e); s.after(200, () => e.el.classList.add('tight')); }); }));
  s.after(T1 + 1100, () => focus('priya'));
  s.after(T1 + 3200, () => focus('api'));
  s.after(T1 + 5400, () => clear());
});
