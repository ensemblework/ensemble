/* 16 · Logo reveals: A · Pull, B · Woven, C · Needle. Auto-plays A→B→C; click a tab to replay one. */
U2.define('reveals', (s) => {
  const stage = s.$('.rv-stage'), seg = s.$('.rv-seg'), pill = s.$('.rv-seg-pill'), note = s.$('.rv-note');
  const btns = [...seg.querySelectorAll('button')];
  let run = 0;
  const NS = 'http://www.w3.org/2000/svg';
  const setTab = (v) => {
    btns.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    const b = btns.find((x) => x.dataset.v === v), h = seg.getBoundingClientRect(), r = b.getBoundingClientRect();
    pill.style.width = r.width + 'px'; pill.style.transform = `translateX(${r.left - h.left - 3}px)`;
  };
  const DEFS = `<defs><linearGradient id="rv-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--tile-top)"/><stop offset="1" stop-color="var(--tile-bot)"/></linearGradient>
    <radialGradient id="rv-wash" cx=".18" cy=".05" r=".9"><stop offset="0" stop-color="#7c6af7" stop-opacity=".34"/><stop offset=".6" stop-color="#7c6af7" stop-opacity=".04"/><stop offset="1" stop-color="#7c6af7" stop-opacity="0"/></radialGradient>
    <linearGradient id="rv-o" gradientUnits="userSpaceOnUse" x1="0" y1="300" x2="0" y2="736"><stop offset="0" stop-color="var(--v-hi)"/><stop offset="1" stop-color="var(--u-agent)"/></linearGradient>
    <clipPath id="rv-clip"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>`;
  const TILE = `<g class="rv-tile"><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#rv-bg)"/><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#rv-wash)"/><rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="3"/></g>`;
  const lockup = (inner) => {
    stage.innerHTML = `<div class="rv-word"><svg class="ph" viewBox="100 100 824 824" style="overflow:visible">${DEFS}${inner}</svg><div class="rv-name" style="max-width:0;overflow:hidden">${[...'Ensemble'].map((c) => `<span>${c}</span>`).join('')}</div></div><div class="rv-tag">You and your agent, in sync.</div>`;
    return stage.querySelector('svg');
  };
  const finale = async (id, dly = 0) => {
    const w = stage.querySelector('.rv-word'), nm = stage.querySelector('.rv-name');
    await s.wait(dly); if (id !== run) return;
    nm.style.transition = 'max-width 1s var(--spring-gentle)'; nm.style.maxWidth = '420px';
    s.after(120, () => id === run && w.classList.add('on'));
    s.after(600, () => id === run && stage.querySelector('.rv-tag').classList.add('on'));
  };
  const reducedEnd = () => { const svg = lockup(TILE + `<path class="rv-u" d="${U2.U_OUTER}" stroke="url(#rv-o)" stroke-width="84"/><path class="rv-u" d="${U2.U_INNER}" stroke="var(--u-you)" stroke-width="64"/>`);
    svg.querySelector('.rv-tile').classList.add('on'); const nm = stage.querySelector('.rv-name'); nm.style.maxWidth = '420px'; stage.querySelector('.rv-word').classList.add('on'); stage.querySelector('.rv-tag').classList.add('on'); };

  /* A · Pull: one taut thread is plucked, then pulled down into the mark, splitting into two voices. */
  const A = async (id) => {
    note.textContent = 'one thread → plucked → pulled into two voices';
    const svg = lockup(TILE + `<path class="rv-u po" stroke="url(#rv-o)"/><path class="rv-u pi" stroke="var(--u-you)"/>`);
    const po = svg.querySelector('.po'), pi = svg.querySelector('.pi'), tile = svg.querySelector('.rv-tile');
    const N = 90, LINE = Array.from({ length: N }, (_, i) => [316 + (392 * i) / (N - 1), 300]);
    const UO = U2.samplePath(U2.U_OUTER, N), UI = U2.samplePath(U2.U_INNER, N);
    let t = 0, m = new U2.Spring(0, [150, 11]), phase = 0;
    s.loop((dt) => {
      if (id !== run) return false;
      t += dt;
      if (phase === 0) { // draw the line
        const k = Math.max(2, Math.round(N * U2.ease.out(U2.clamp(t / 0.5))));
        const d = U2.catmull(LINE.slice(0, k)); po.setAttribute('d', d); pi.setAttribute('d', d);
        po.style.strokeWidth = 16; pi.style.strokeWidth = 9;
        if (t > 0.55) { phase = 1; t = 0; }
      } else if (phase === 1) { // pluck
        const P = LINE.map(([x, y], i) => [x, y + 40 * Math.sin((Math.PI * i) / (N - 1)) * Math.sin(2 * Math.PI * 3.2 * t) * Math.exp(-3.2 * t)]);
        const d = U2.catmull(P); po.setAttribute('d', d); pi.setAttribute('d', d);
        if (t > 0.62) { phase = 2; t = 0; m.to(1); }
      } else { // pull into the mark
        m.step(dt); const v = m.x;
        po.setAttribute('d', U2.catmull(U2.lerpPts(LINE, UO, v))); pi.setAttribute('d', U2.catmull(U2.lerpPts(LINE, UI, v)));
        po.style.strokeWidth = U2.lerp(16, 84, U2.clamp(v)); pi.style.strokeWidth = U2.lerp(9, 64, U2.clamp(v));
        if (t > 0.35 && !tile.classList.contains('on')) tile.classList.add('on');
        if (t > 1.6) return false;
      }
    });
    finale(id, 1700);
  };

  /* B · Woven: warp drops, weft slides over/under, then the mark is stitched on and the stitches pull tight. */
  const B = async (id) => {
    note.textContent = 'warp + weft weave the tile · the mark is stitched on';
    let warp = '', weft = '';
    for (let c = 0; c < 8; c++) warp += `<rect class="wp" x="${100 + c * 103 + 7}" y="100" width="89" height="824" rx="10" fill="${c % 2 ? '#2a241e' : '#241f1a'}" style="transform:translateY(-940px);transition:transform 1s var(--spring-soft) ${c * 55}ms"/>`;
    for (let r = 0; r < 8; r++) {
      let segs = '';
      for (let c = 0; c < 8; c++) if ((r + c) % 2 === 0) segs += `<rect x="${100 + c * 103 - 2}" y="${100 + r * 103 + 8}" width="107" height="87" rx="10" fill="${r % 2 ? '#342d25' : '#2f2921'}"/>`;
      weft += `<g class="wf" style="transform:translateX(${r % 2 ? 960 : -960}px);transition:transform 1.05s var(--spring-soft) ${420 + r * 70}ms">${segs}</g>`;
    }
    const svg = lockup(`<g clip-path="url(#rv-clip)"><rect x="100" y="100" width="824" height="824" fill="#1a1714"/>${warp}${weft}</g>
      <g class="rv-tile" style="transition:opacity 1s"><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#rv-bg)" opacity=".72"/><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#rv-wash)"/><rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="3"/></g>
      <mask id="rv-mo" maskUnits="userSpaceOnUse"><path class="mo" d="${U2.U_OUTER}" stroke="#fff" stroke-width="120" fill="none" stroke-linecap="round"/></mask>
      <mask id="rv-mi" maskUnits="userSpaceOnUse"><path class="mi" d="${U2.U_INNER}" stroke="#fff" stroke-width="100" fill="none" stroke-linecap="round"/></mask>
      <path class="rv-u so" d="${U2.U_OUTER}" stroke="url(#rv-o)" stroke-width="84" mask="url(#rv-mo)" style="stroke-dasharray:44 30;transition:stroke-dasharray .8s var(--ease-weave)"/>
      <path class="rv-u si" d="${U2.U_INNER}" stroke="var(--u-you)" stroke-width="64" mask="url(#rv-mi)" style="stroke-dasharray:34 26;transition:stroke-dasharray .8s var(--ease-weave)"/>
      <circle class="nd" r="16" fill="#fff" opacity="0"/>`);
    const tile = svg.querySelector('.rv-tile'); tile.style.opacity = 0; tile.style.transform = 'none';
    const mo = svg.querySelector('.mo'), mi = svg.querySelector('.mi'), nd = svg.querySelector('.nd');
    [mo, mi].forEach((p) => { p.setAttribute('pathLength', 1); p.style.strokeDasharray = '1 1'; p.style.strokeDashoffset = 1; });
    void svg.getBBox();
    requestAnimationFrame(() => { svg.querySelectorAll('.wp').forEach((e) => (e.style.transform = 'none')); svg.querySelectorAll('.wf').forEach((e) => (e.style.transform = 'none')); });
    await s.wait(1500); if (id !== run) return;
    tile.style.opacity = 1;
    const Lo = svg.querySelector('.so').getTotalLength();
    await s.tween(900, (p) => {
      if (id !== run) return;
      mo.style.strokeDashoffset = 1 - p; mi.style.strokeDashoffset = 1 - U2.clamp(p * 1.08);
      const pt = svg.querySelector('.so').getPointAtLength(Lo * p); nd.setAttribute('cx', pt.x); nd.setAttribute('cy', pt.y); nd.setAttribute('opacity', p < 0.98 ? 1 : 0);
    }, U2.ease.inOut);
    if (id !== run) return;
    svg.querySelector('.so').style.strokeDasharray = '80 0'; svg.querySelector('.si').style.strokeDasharray = '60 0';
    finale(id, 500);
  };

  /* C · Needle: a thread weaves through the letters and ties a knot beside the wordmark. */
  const C = async (id) => {
    note.textContent = 'a needle threads the wordmark · a knot finishes the thread';
    const word = 'Ensemble';
    stage.innerHTML = `<div class="rv-c"><div class="ln bot">${[...word].map((c) => `<span>${c}</span>`).join('')}</div>
      <svg><path class="rv-thread"/><path class="rv-tail"/><ellipse class="rv-needle" rx="16" ry="3.4"/><circle class="rv-dot" r="4"/></svg>
      <div class="ln top">${[...word].map((c) => `<span>${c}</span>`).join('')}</div></div><div class="rv-tag">You and your agent, in sync.</div>`;
    const box = stage.querySelector('.rv-c'), svg = box.querySelector('svg');
    const thread = svg.querySelector('.rv-thread'), tail = svg.querySelector('.rv-tail'), needle = svg.querySelector('.rv-needle'), dot = svg.querySelector('.rv-dot');
    const bot = [...box.querySelectorAll('.ln.bot span')], top = [...box.querySelectorAll('.ln.top span')];
    const sr = svg.getBoundingClientRect();
    const L = bot.map((e) => { const r = e.getBoundingClientRect(); return { x0: r.left - sr.left, x1: r.right - sr.left, cx: (r.left + r.right) / 2 - sr.left, top: r.top - sr.top, h: r.height }; });
    const mid = L[0].top - 26 + L[0].h * 0.5, amp = L[0].h * 0.11; // spans are measured while still offset 26px down
    // thread weaves: dips at odd letters' centres, rises between letters
    const X0 = L[0].x0 - 50, X1 = L[L.length - 1].x1 + 30;
    const yAt = (x) => { let k = 0; for (let i = 0; i < L.length; i++) if (x >= L[i].x0) k = i; const u = (x - L[k].x0) / (L[k].x1 - L[k].x0); return mid + amp * Math.sin(Math.PI * U2.clamp(u)) * (k % 2 ? -1 : 1); };
    const P = []; for (let x = X0; x <= X1; x += 4) P.push([x, x < L[0].x0 ? mid : yAt(x)]);
    const tit = [X1, mid];
    const loopPts = U2.samplePath(`M${X1} ${P[P.length - 1][1]} C${X1 + 60} ${mid - 120} ${tit[0] + 200} ${tit[1] - 150} ${tit[0]} ${tit[1]}`, 50);
    let t = 0, done = false;
    const T1 = 1.5;
    s.loop((dt) => {
      if (id !== run) return false;
      t += dt;
      const p = U2.ease.inOutSine(U2.clamp(t / T1));
      const k = Math.max(2, Math.round(P.length * p));
      const seg = P.slice(0, k); thread.setAttribute('d', U2.catmull(seg));
      const hx = seg[seg.length - 1][0];
      L.forEach((l, i) => { if (hx > l.cx - 10 && !bot[i].classList.contains('up')) { bot[i].classList.add('up'); top[i].classList.add('up'); } });
      let head = seg[seg.length - 1], prev = seg[Math.max(0, seg.length - 3)];
      if (t > T1) {
        const q = U2.ease.inOut(U2.clamp((t - T1) / 0.6));
        const kk = Math.max(2, Math.round(loopPts.length * q));
        tail.setAttribute('d', U2.catmull(loopPts.slice(0, kk)));
        head = loopPts[kk - 1]; prev = loopPts[Math.max(0, kk - 3)];
        if (q >= 1 && !done) { done = true; dot.setAttribute('cx', tit[0]); dot.setAttribute('cy', tit[1]); dot.classList.add('on'); needle.style.opacity = 0;
          s.tween(600, (v) => (tail.style.opacity = 1 - v)); stage.querySelector('.rv-tag').classList.add('on'); return false; }
      }
      const ang = (Math.atan2(head[1] - prev[1], head[0] - prev[0]) * 180) / Math.PI;
      needle.setAttribute('transform', `translate(${head[0]} ${head[1]}) rotate(${ang})`);
    });
  };
  const V = { a: A, b: B, c: C };
  const play = (v) => { run++; setTab(v); if (s.reduced) { reducedEnd(); return; } V[v](run); };
  btns.forEach((b) => b.addEventListener('click', () => play(b.dataset.v)));
  if (s.reduced) { play('a'); return; }
  (async () => {
    const short = new URLSearchParams(location.search).get('tour') === 'highlights';
    play('a'); await s.wait(3300);
    if (!short) { play('b'); await s.wait(3900); }
    play('c');
  })();
});
