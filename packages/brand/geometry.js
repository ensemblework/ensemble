'use strict';
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const out = x => 1 - Math.pow(1 - clamp(x), 3);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, k) => a.map((p, i) => [lerp(p[0], b[i][0], k), lerp(p[1], b[i][1], k)]);
const mixFrames = (a, b, k) => ({ pair: [mix(a.pair[0], b.pair[0], k), mix(a.pair[1], b.pair[1], k)], width: lerp(a.width, b.width, k) });
const path = p => 'M' + p.map(q => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('L');
const kinds = { unfurl: { name: 'Unfurl', duration: 720, loop: 0 }, infinity: { name: 'Infinity weave', duration: 660, loop: 3400 }, relay: { name: 'Relay', duration: 620, loop: 5400 }, threadline: { name: 'Threadline', duration: 500, loop: 2200 }, beacon: { name: 'Beacon', duration: 560, loop: 3600 } };
function createModel(data) {
    const N = data.N, base = { pair: data.pair, width: 8 }, align = { infinity: [0, 0], relay: [0, 0] }, direction = { unfurl: [1, 1], infinity: [1, 1], relay: [1, 1], threadline: [1, 1], beacon: [1, 1] };
    function curves(kind, phase, phases = align, directions = direction) {
        return [0, 1].map(s => {
            const points = [], sign = s ? 1 : -1;
            for (let i = 0; i < N; i++) {
                const u = directions[kind][s] === 1 ? i / (N - 1) : 1 - i / (N - 1), theta = 2 * Math.PI * u + (phases[kind]?.[s] || 0);
                let x = 0, y = 0;
                if (kind === 'infinity') {
                    const r = 1 + .024 * Math.sin(phase), t = theta, xx = 98 * Math.sin(t), yy = 49 * Math.sin(2 * t), dx = 98 * Math.cos(t), dy = 98 * Math.cos(2 * t), length = Math.hypot(dx, dy) || 1;
                    x = 160 + xx * r - sign * dy / length * 6;
                    y = 160 + yy * r + sign * dx / length * 6;
                }
                else if (kind === 'relay') {
                    const p = phase * .65, theta2 = theta + sign * p, cx = 160 + sign * 40 * Math.cos(p), cy = 160 + sign * 21 * Math.sin(p);
                    x = cx + 58 * Math.cos(theta2);
                    y = cy + 47 * Math.sin(theta2);
                }
                else if (kind === 'threadline') {
                    x = 35 + 250 * u;
                    y = 160 + sign * 7 + 7 * Math.sin(2 * Math.PI * u - phase + sign * .2);
                }
                else if (kind === 'beacon') {
                    const r = s ? 49 : 77, a = (-.45 + (s ? .40 : 0) + u * .83) * 2 * Math.PI + sign * phase;
                    x = 160 + r * Math.cos(a);
                    y = 160 + r * Math.sin(a);
                }
                else {
                    const a = (-.58 + u * 1.16) * Math.PI;
                    x = 160 + sign * (61 * Math.cos(a) + 13);
                    y = 160 + 72 * Math.sin(a);
                }
                points.push([x, y]);
            }
            return points;
        });
    }
    for (const kind of ['unfurl', 'infinity', 'relay', 'threadline', 'beacon'])
        for (let s = 0; s < 2; s++) {
            let best = Infinity, phase = 0, dir = 1;
            const count = ['infinity', 'relay'].includes(kind) ? 40 : 1;
            align[kind] ??= [0, 0];
            for (const sign of [-1, 1])
                for (let k = 0; k < count; k++) {
                    const trial = { ...align, [kind]: [...align[kind]] }, trialDir = { ...direction, [kind]: [...direction[kind]] };
                    trial[kind][s] = k / count * 2 * Math.PI;
                    trialDir[kind][s] = sign;
                    const q = curves(kind, 0, trial, trialDir)[s];
                    let score = 0;
                    for (let j = 0; j < N; j += 4)
                        score += (q[j][0] - base.pair[s][j][0]) ** 2 + (q[j][1] - base.pair[s][j][1]) ** 2;
                    if (score < best) {
                        best = score;
                        phase = trial[kind][s];
                        dir = sign;
                    }
                }
            align[kind][s] = phase;
            direction[kind][s] = dir;
        }
    const target = (kind, phase) => ({ pair: curves(kind, phase), width: kind === 'beacon' ? 11 : kind === 'threadline' ? 7 : 10 });
    function gather(from, to, amount) { const k = clamp(amount), first = k < .5, r = first ? 1 - ease(k * 2) : ease((k - .5) * 2), shape = first ? from : to; return { pair: shape.pair.map((points, s) => points.map(p => { const cx = 160 + (s ? 2 : -2); return [cx + (p[0] - cx) * r, 160 + (p[1] - 160) * r]; })), width: lerp(6, shape.width, r) }; }
    const pose = (kind, amount, phase = 0) => kind === 'unfurl' ? mixFrames(base, target(kind, phase), ease(amount)) : gather(base, target(kind, phase), amount);
    const settle = (from, amount) => gather(from, base, amount);
    function cycle(kind, seconds) {
        if (kind === 'unfurl') {
            const t = seconds % 4.8;
            if (t < .25 || t > 1.25)
                return { frame: base, rest: 1, phase: 0 };
            const k = (t - .25) / 1;
            const amount = k < .44 ? ease(k / .44) : 1 - ease((k - .44) / .56);
            return { frame: pose(kind, amount), rest: amount < .08 ? 1 - amount / .08 : 0, phase: t };
        }
        const t = seconds % 4.8, phase = t / (kinds[kind].loop / 1000) * 2 * Math.PI;
        let amount = t < .25 ? 0 : t < 1 ? (t - .25) / .75 : t < 3.6 ? 1 : t < 4.25 ? 1 - (t - 3.6) / .65 : 0;
        return { frame: pose(kind, amount, phase), rest: amount < .08 ? 1 - amount / .08 : 0, phase };
    }
    return { base, target, pose, cycle, settle, align };
}
module.exports = { createModel, kinds, path, ease, clamp };
