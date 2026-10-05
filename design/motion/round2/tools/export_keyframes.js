// Exports point keyframes for native ports (SwiftUI Path / Compose Path / Reanimated), sampled by the same helpers the web uses.
const { chromium } = require('/workspace/ensemble-animations/tools/node_modules/playwright-core');
const fs = require('fs'), R = '/workspace/ensemble-animations/round2/components/';
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage();
  await p.goto('file:///workspace/ensemble-animations/round2/index.html');
  const out = await p.evaluate(() => {
    const r2 = (P) => P.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    const N = 150;
    const offset = (P, d) => P.map((q, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [q[0] - (dy / L) * d, q[1] + (dx / L) * d]; });
    const lem = (off) => { const P = []; for (let i = 0; i < N; i++) { const t = -Math.PI / 2 + (i / (N - 1)) * Math.PI * 2; const d = 1 + Math.sin(t) ** 2; P.push([512 + (470 * Math.cos(t)) / d, 520 + (470 * Math.sin(t) * Math.cos(t)) / d]); } return offset(P, off); };
    const ring = (cx, r) => Array.from({ length: N }, (_, i) => { const a = -Math.PI / 2 - (i / (N - 1)) * Math.PI * 2; return [cx + r * Math.cos(a), 520 + r * Math.sin(a)]; });
    const brand = {
      about: 'Ensemble brand loop. Coordinates in the icon 1024 grid. Each shape has an agent (violet, width 84) and a you (paper, width 64) strand with the same point count, so shapes morph by per-point lerp. Render each strand as a ribbon: width *= 0.28 + 0.72*|cos(twist)|, back face (cos<0) uses the tint colour. twist(u,T) = flat(T) * (u*9 + T*1.6) (+1.2 for you).',
      loopSeconds: 12, points: N,
      colors: { agentFront: '#7c6af7', agentBack: '#b4a9ff', youFront: '#f3eee6', youBack: '#c9bfae' },
      timeline: [
        { from: 0, to: 1.6, hold: 'u' }, { from: 1.6, to: 3.2, morph: ['u', 'figure8'], ease: 'inOutCubic' }, { from: 3.2, to: 5.0, hold: 'figure8', flow: 'shift points along the closed curve by one full lap' },
        { from: 5.0, to: 6.6, morph: ['figure8', 'rings'], ease: 'inOutCubic' }, { from: 6.6, to: 8.4, hold: 'rings', spin: 'agent ring forward, you ring backward, one lap' },
        { from: 8.4, to: 10.2, morph: ['rings', 'u'], ease: 'inOutCubic' }, { from: 10.2, to: 12, hold: 'u' },
        { twistFlat: 'flat = 0 before 1.4 s and after 10.4 s; ramps 1.4→2.6 s and 9.2→10.4 s' }],
      shapes: { u: { agent: r2(U2.samplePath(U2.U_OUTER, N)), you: r2(U2.samplePath(U2.U_INNER, N)) }, figure8: { agent: r2(lem(-30)), you: r2(lem(30)) }, rings: { agent: r2(ring(412, 210)), you: r2(ring(612, 210)) } },
    };
    const M = 72;
    const sunmoon = { about: 'Theme toggle strand, 24×24 grid, closed path, 72 points. m=0 sun (light), m=1 moon (dark); morph with spring-soft. Rays: 8 lines r 7.6→10.4, scale to 0 and rotate 60° as m→1; two sparkles pop in after m>0.55.',
      sun: r2(Array.from({ length: M }, (_, i) => { const a = -Math.PI / 2 + (i / M) * Math.PI * 2; return [12 + 4.6 * Math.cos(a), 12 + 4.6 * Math.sin(a)]; })),
      moon: r2(U2.samplePath('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z', M + 1).slice(0, M)) };
    const tie = { about: 'Tie checkbox, 20×20 grid, 44 points. Draw the knot (260 ms ease-out), then morph knot → check with spring-soft.',
      knot: r2(U2.samplePath('M4.5 10.5 L7.6 13.4 C9.4 15.2 12.4 13.8 11.4 11.4 C10.4 9.1 7.3 10.4 8.3 12.8 C9.1 14.7 10.7 14.3 11.7 12.8 L16 5.5', 44)), check: r2(U2.samplePath('M4.5 10.5 L8.4 14.2 L16 5.5', 44)) };
    const meet = { about: 'First meeting. Spiral for 2.9 s: q = easeInOutSine(t/2.9); theta = PI - (PI/2 + 2PI)*q; r = 55 + 1150*(1-q)^2.4; centre (512,681). Agent at theta, you at theta+PI. They meet at (512,736) and (512,626), then the four half-arms draw (1.25 s, easeInOutCubic) while stroke width grows 26→84 / 22→64.',
      arms: { agentLeft: 'M512 736 A196 196 0 0 1 316 540 V300', agentRight: 'M512 736 A196 196 0 0 0 708 540 V300', youLeft: 'M512 626 A86 86 0 0 1 426 540 V300', youRight: 'M512 626 A86 86 0 0 0 598 540 V300' } };
    return { brand, sunmoon, tie, meet };
  });
  fs.writeFileSync(R + 'brandloop/keyframes.json', JSON.stringify(out.brand));
  fs.writeFileSync(R + 'ambient/sun-moon.json', JSON.stringify(out.sunmoon));
  fs.writeFileSync(R + 'core/tie.json', JSON.stringify(out.tie));
  fs.writeFileSync(R + 'meet/meet.json', JSON.stringify(out.meet, null, 2));
  console.log('exported');
  await b.close();
})();
