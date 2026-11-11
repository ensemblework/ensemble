'use strict';
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, amount) => a.map((p, i) => [lerp(p[0], b[i][0], amount), lerp(p[1], b[i][1], amount)]);
const mixFrames = (a, b, amount) => amount <= 0 ? a : amount >= 1 ? b : ({ pair: [mix(a.pair[0], b.pair[0], amount), mix(a.pair[1], b.pair[1], amount)], width: lerp(a.width, b.width, amount) });
const path = points => 'M' + points.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L');
const kinds = {
    unfurl: { name: 'Unfurl', duration: 720, loop: 0 },
    infinity: { name: 'Thought', duration: 850, loop: 7400 },
    relay: { name: 'Handoff', duration: 850, loop: 7800 },
    threadline: { name: 'Response wave', duration: 850, loop: 6800 },
    beacon: { name: 'Quiet activity', duration: 700, loop: 8600 }
};
const SETTLE_MS = 340;
const START_SECONDS = .45;
const RETURN_SECONDS = .65;

function resample(points, count) {
    const distances = [0];
    for (let i = 1; i < points.length; i++)
        distances.push(distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    let next = 1;
    return Array.from({ length: count }, (_, i) => {
        const distance = distances[distances.length - 1] * i / (count - 1);
        while (next < distances.length - 1 && distances[next] < distance)
            next++;
        const amount = (distance - distances[next - 1]) / (distances[next] - distances[next - 1] || 1);
        return points[next - 1].map((value, axis) => lerp(value, points[next][axis], amount));
    });
}

function createModel(data) {
    const N = data.N, base = { pair: data.pair, width: 9 };
    // Shared correspondence selected against both approved strands. Keeping this phase
    // avoids a dense alignment search on every web, SSR and native startup.
    const infinityPhase = 173 / 256 * Math.PI * 2;
    const center = resample(Array.from({ length: 1025 }, (_, i) => {
        const t = infinityPhase - Math.PI * 2 * i / 1024;
        return [160 + 104 * Math.sin(t), 160 + 52 * Math.sin(2 * t)];
    }), N);
    const infinity = [0, 1].map(strand => center.map((p, i) => {
        const before = center[i ? i - 1 : N - 2], after = center[i === N - 1 ? 1 : i + 1];
        const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy) || 1;
        const sign = strand ? 1 : -1;
        return [p[0] - sign * dy / length * 6, p[1] + sign * dx / length * 6];
    }));
    function curves(kind) {
        if (kind === 'infinity' || kind === 'beacon')
            return infinity;
        return [0, 1].map(strand => Array.from({ length: N }, (_, i) => {
            const u = i / (N - 1), sign = strand ? 1 : -1;
            if (kind === 'relay') {
                const theta = 5 * Math.PI / 4 - 2 * Math.PI * u;
                return [160 + sign * 40 + 58 * Math.cos(theta), 160 + 47 * Math.sin(theta)];
            }
            if (kind === 'threadline')
                return [35 + 250 * u, 160 + sign * 18 + 44 * Math.sin(2 * Math.PI * u + sign * .2)];
            const theta = (-.58 + (1 - u) * 1.16) * Math.PI;
            return [160 + sign * (61 * Math.cos(theta) + 13), 160 + 72 * Math.sin(theta)];
        }));
    }
    const targets = Object.fromEntries(Object.keys(kinds).map(kind => [kind, { pair: curves(kind), width: 9 }]));
    const target = kind => targets[kind] || targets.infinity;
    const pose = (kind, amount) => mixFrames(base, target(kind), ease(amount));
    const settle = (from, amount) => mixFrames(from, base, ease(amount));
    function timing(kind, seconds) {
        const role = kinds[kind] || kinds.infinity;
        const duration = role.loop / 1000;
        const remainder = seconds % duration;
        const t = remainder < 0 ? remainder + duration : remainder;
        const arrive = START_SECONDS + role.duration / 1000;
        const release = kind === 'beacon' ? 2.45 : kind === 'infinity' ? 4.65 : 4.2;
        const end = release + RETURN_SECONDS;
        const moving = t >= START_SECONDS - 1e-9 && t < end - 1e-9;
        return { t, duration, arrive, release, end, moving, wait: moving ? 0 : t < START_SECONDS ? START_SECONDS - t : duration - t + START_SECONDS };
    }
    function once(seconds) {
        const progress = clamp(seconds / (kinds.unfurl.duration / 1000));
        const amount = progress < .43 ? ease(progress / .43) : 1 - ease((progress - .43) / .57);
        return { frame: mixFrames(base, targets.unfurl, amount), rest: 1 - clamp(amount * 9), phase: 'unfurl', moving: progress < 1, wait: 0 };
    }
    function cycle(kind, seconds) {
        if (kind === 'unfurl')
            return once(seconds);
        const clock = timing(kind, seconds);
        if (!clock.moving)
            return { ...clock, frame: base, rest: 1, phase: 'rest' };
        const { t, arrive, release } = clock;
        const entering = t < arrive, leaving = t > release;
        const amount = entering ? ease((t - START_SECONDS) / (arrive - START_SECONDS)) : leaving ? 1 - ease((t - release) / RETURN_SECONDS) : 1;
        const held = clamp((t - arrive) / (release - arrive));
        const envelope = Math.sin(Math.PI * held) ** 2;
        const pair = target(kind).pair.map((strand, s) => strand.map(([x, y], i) => {
            const u = i / (N - 1), lead = s ? .22 : 0;
            if (kind === 'threadline')
                return [x, y + envelope * 8 * Math.sin(u * Math.PI * 2 - held * Math.PI * 2 + lead)];
            if (kind === 'relay')
                return [x + envelope * (s ? -1 : 1) * 9 * Math.sin(held * Math.PI * 2), y + envelope * 7 * Math.sin(held * Math.PI * 2 + lead)];
            return [160 + (x - 160) * (1 + envelope * .025), y + envelope * 3 * Math.sin(u * Math.PI * 2 + held * Math.PI * 2 + lead)];
        }));
        return { ...clock, frame: mixFrames(base, { pair, width: 9 }, amount), rest: 1 - clamp(amount * 9), phase: entering ? 'unweave' : leaving ? 'return' : kind === 'relay' ? 'handoff' : kind === 'threadline' ? 'wave' : 'flow' };
    }
    return { base, target, pose, timing, once, cycle, settle, mixFrames };
}
module.exports = { createModel, kinds, path, ease, clamp, SETTLE_MS };
