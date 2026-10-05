/* 12 · Voice: your wave and the agent's wave; understanding = the agent matches frequency and phase until they lock. */
U2.define('voice', (s) => {
  const root = s.$('.vo'), svg = s.$('.vo-svg'), pY = s.$('.vo-you'), pA = s.$('.vo-ag'), pG = s.$('.vo-glow');
  const chips = s.$$('.vo-chips span'), pill = s.$('.vo-pill'), lY = s.$('.vo-l.you'), lA = s.$('.vo-l.ag');
  const YOU = 'Move my standup to eleven, and let Akash know.'.split(' ');
  const AG = 'Done. Standup is at 11:00 and Akash has a heads-up.'.split(' ');
  const LOOP = 11;
  const g = (t, c, w) => Math.exp(-((t - c) * (t - c)) / (2 * w * w));
  const syl = (t, t0, n, gap) => { let a = 0; for (let i = 0; i < n; i++) a += g(t, t0 + i * gap + (i % 3) * 0.04, 0.07) * (0.7 + 0.3 * ((i * 7) % 5) / 4); return Math.min(1, a); };
  let state = -1;
  const setState = (i) => {
    if (i === state) return; state = i;
    chips.forEach((c, j) => c.classList.toggle('on', j === i));
    const c = chips[Math.max(0, i)], h = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect();
    pill.style.width = r.width + 'px'; pill.style.transform = `translateX(${r.left - h.left}px)`;
    pill.classList.toggle('ensemble', i === 2);
  };
  const words = (el, list, t, t0, per) => {
    const n = Math.max(0, Math.min(list.length, Math.floor((t - t0) / per) + 1));
    while (el.children.length < n) { const sp = document.createElement('span'); sp.textContent = list[el.children.length]; el.appendChild(sp); }
  };
  const wave = (A, k, ph, t, harm) => {
    const W = svg.clientWidth, H = svg.clientHeight, m = H / 2, pts = [], n = 110, x0 = 30, x1 = W - 30;
    for (let i = 0; i <= n; i++) {
      const u = i / n, env = Math.pow(Math.sin(Math.PI * u), 1.7);
      const y = Math.sin(u * k * 6.283 + t * 5.2 + ph) + harm[0] * Math.sin(u * k * 2 * 6.283 - t * 3.1 + ph * 2 + 1.3) + harm[1] * Math.sin(u * k * 3.1 * 6.283 + t * 7.3 + ph * 3);
      pts.push([x0 + (x1 - x0) * u, m + y * A * env * (H * 0.36)]);
    }
    return U2.catmull(pts);
  };
  const frame = (T) => {
    const t = T % LOOP;
    let st = t < 3.5 ? 0 : t < 5.0 ? 1 : t < 6.3 ? 2 : t < 10 ? 3 : -1;
    if (t < 0.3) st = 0;
    setState(st < 0 ? 3 : st);
    // your amplitude: syllables while you talk, a quiet hum otherwise
    const talkY = syl(t, 0.5, 12, 0.24);
    const talkA = syl(t, 6.5, 13, 0.25);
    const ay = 0.1 + 0.8 * talkY * (t < 3.4 ? 1 : 0) + (t >= 3.4 && t < 6.3 ? 0.34 * U2.seg(t, 3.2, 3.8) : 0) + (t >= 6.3 ? 0.12 : 0);
    const aa = 0.1 + (t < 3.4 ? 0.12 : 0) + (t >= 3.4 && t < 6.3 ? 0.34 * U2.seg(t, 3.4, 4.2) : 0) + (t >= 6.3 && t < 10 ? 0.14 + 0.72 * talkA : 0);
    const lock = t < 3.5 ? 0 : t < 5.0 ? U2.ease.inOut(U2.seg(t, 3.5, 5.0)) : t < 6.3 ? 1 : t < 10 ? 1 - 0.45 * U2.seg(t, 6.3, 7) : U2.lerp(0.55, 0, U2.seg(t, 10, 10.8));
    const fade = t > 10 ? 1 - 0.6 * U2.seg(t, 10, 10.9) : 1;
    const kY = 2.1, kA = U2.lerp(3.3, kY, lock), phA = U2.lerp(2.2 + t * 1.7, 0, lock);
    const hY = [0.42, 0.22], hA = [U2.lerp(0.15, 0.42, lock), U2.lerp(0.5, 0.22, lock)];
    const ampA = U2.lerp(aa, t < 6.3 ? ay : aa, lock * (t < 6.3 ? 1 : 0.6));
    pY.setAttribute('d', wave(ay * fade, kY, 0, t, hY)); pY.style.strokeWidth = U2.lerp(2.4, 1.2, lock);
    pA.setAttribute('d', wave(ampA * fade, kA, phA, t, hA));
    const gl = Math.pow(lock, 4) * (t < 6.4 ? 1 : 0.35);
    pG.setAttribute('d', wave(ay * fade, kY, 0, t, hY)); pG.style.opacity = gl * 0.75;
    root.style.setProperty('--lock', gl); root.style.setProperty('--amp', Math.max(ay * (t < 3.4 ? 1 : 0), 0));
    // transcript
    if (t < 0.1) { lY.innerHTML = ''; lA.innerHTML = ''; lY.classList.remove('fade'); }
    if (t > 0.55 && t < 6.3) words(lY, YOU, t, 0.55, 0.3);
    if (t > 6.4) { lY.classList.add('fade'); words(lA, AG, t, 6.45, 0.3); }
  };
  if (s.reduced) { setState(2); lY.textContent = YOU.join(' '); lA.textContent = AG.join(' '); pY.setAttribute('d', wave(0.3, 2.1, 0, 0, [0.42, 0.22])); pA.setAttribute('d', wave(0.3, 2.1, 0.25, 0, [0.42, 0.22])); return; }
  let T = 0;
  s.loop((dt) => { T += dt; frame(T); });
});
