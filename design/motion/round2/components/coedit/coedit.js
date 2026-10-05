/* 07 · Co-editing threads: presence cursors trail threads; when they meet, a thread links them. */
U2.define('coedit', (s) => {
  const host = s.root, root = s.$('.ce');
  const cur = { you: s.$('.ce-cur.you'), ag: s.$('.ce-cur.ag') };
  const tr = { you: s.$('.ce-trail.you'), ag: s.$('.ce-trail.ag') };
  const link = s.$('.ce-link'), sug = s.$('.ce-sug'), w = s.$('.ce-w'), typed = s.$('.ce-typed'), mk = s.$('.ce-mk');
  const rel = (el, fx = 0, fy = 0) => { const r = el.getBoundingClientRect(), h = host.getBoundingClientRect(); return [r.left - h.left + r.width * fx, r.top - h.top + r.height * fy]; };
  const S = {};
  for (const k of ['you', 'ag']) S[k] = { X: new U2.Spring(0, [150, 21]), Y: new U2.Spring(0, [150, 21]), H: [], energy: 0 };
  const place = (k, [x, y], jump) => { const c = S[k]; if (jump) { c.X.set(x); c.Y.set(y - 1); } else { c.X.to(x); c.Y.to(y - 1); } };
  const lineTop = (el) => { const [x, y] = rel(el, 0, 0); return [x, y + 3]; };
  const text = ' Ensemble will open the PR and draft the changelog.';
  const finish = () => {
    typed.textContent = text; w.innerHTML = '<span class="ce-new">30 days</span>';
    ['you', 'ag'].forEach((k) => cur[k].classList.add('on'));
    place('ag', lineTop(mk), true); place('you', rel(w, 1, 0).map((v, i) => v + (i ? 3 : 0)), true);
    cur.ag.style.transform = `translate(${S.ag.X.x}px,${S.ag.Y.x}px)`; cur.you.style.transform = `translate(${S.you.X.x}px,${S.you.Y.x}px)`;
  };
  if (s.reduced) { finish(); return; }
  s.loop((dt) => {
    let pts = {};
    for (const k of ['you', 'ag']) {
      const c = S[k]; c.X.step(dt); c.Y.step(dt);
      cur[k].style.transform = `translate(${c.X.x}px,${c.Y.x}px)`;
      const sp = Math.hypot(c.X.v, c.Y.v);
      c.energy = U2.lerp(c.energy, U2.clamp(sp / 500), 1 - Math.exp(-dt * 8));
      c.H.push([c.X.x, c.Y.x + 10]); if (c.H.length > 26) c.H.shift();
      tr[k].setAttribute('d', c.H.length > 2 ? U2.catmull(c.H) : '');
      tr[k].style.opacity = c.energy * 0.8;
      pts[k] = [c.X.x, c.Y.x];
    }
    const d = Math.hypot(pts.you[0] - pts.ag[0], pts.you[1] - pts.ag[1]);
    const near = d < 170 && d > 20;
    const fa = rel(cur.you.querySelector('span'), 1, 0.5), fb = rel(cur.ag.querySelector('span'), 1, 0.5);
    const mx = Math.max(fa[0], fb[0]) + 26;
    link.setAttribute('d', `M${fa[0]} ${fa[1]} C${mx} ${fa[1]} ${mx} ${fb[1]} ${fb[0]} ${fb[1]}`);
    link.style.opacity = near && root.classList.contains('linking') ? 1 : 0;
    link.style.strokeDashoffset = -performance.now() / 60;
    cur.you.classList.toggle('close', near && root.classList.contains('linking'));
    cur.ag.classList.toggle('close', near && root.classList.contains('linking'));
  });
  (async () => {
    const h = host.getBoundingClientRect();
    place('you', [h.width * 0.72, h.height - 40], true); place('ag', [h.width * 0.15, h.height - 30], true);
    await s.wait(250);
    cur.ag.classList.add('on'); cur.you.classList.add('on');
    place('ag', lineTop(mk));
    place('you', [h.width * 0.55, 150]);
    await s.wait(700);
    // agent types, inking in; caret follows
    for (const ch of text) {
      const sp = document.createElement('span'); sp.className = 'c'; sp.textContent = ch; typed.appendChild(sp);
      place('ag', lineTop(mk)); await s.wait(34 + Math.random() * 30);
      if (typed.childNodes.length === 16) place('you', rel(w, 0, 0).map((v, i) => v + (i ? 3 : -1)));
      if (typed.childNodes.length === 30) { w.classList.add('sel'); place('you', rel(w, 1, 0).map((v, i) => v + (i ? 3 : 0))); }
    }
    cur.ag.classList.add('blink');
    await s.wait(350);
    // agent joins you at the selection; the thread links your flags
    cur.ag.classList.remove('blink');
    const [wx, wy] = rel(w, 0, 0);
    cur.ag.classList.add('below');
    place('ag', [wx - 2, wy + 3]);
    root.classList.add('linking');
    await s.wait(500);
    sug.style.left = Math.min(host.clientWidth - 300, Math.max(12, wx - 24)) + 'px'; sug.style.top = wy + 46 + 'px';
    sug.classList.add('show');
    await s.wait(900);
    // you accept: old words fall away, new ones knit in
    const acc = s.$('.ce-acc');
    place('you', rel(acc, 0.35, 0.2));
    await s.wait(650);
    acc.classList.add('press'); await s.wait(140); acc.classList.remove('press');
    sug.classList.add('gone');
    const old = w.querySelector('.ce-old'); const letters = old.textContent;
    old.innerHTML = [...letters].map((c) => `<span class="ch">${c}</span>`).join('');
    old.querySelectorAll('.ch').forEach((c, i) => setTimeout(() => c.classList.add('out'), i * 22));
    await s.wait(360);
    w.classList.remove('sel'); w.classList.add('acc');
    w.innerHTML = [...'30 days'].map((c, i) => `<span class="ch in" style="animation-delay:${i * 40}ms">${c}</span>`).join('') + '<i class="stitch"></i>';
    void w.offsetWidth; w.classList.add('knit');
    await s.wait(700);
    root.classList.remove('linking'); cur.ag.classList.remove('below');
    place('you', rel(w, 1, 0).map((v, i) => v + (i ? 3 : 0)));
    place('ag', lineTop(mk)); cur.ag.classList.add('blink');
  })();
});
